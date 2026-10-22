import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { signConfirmToken, type ConfirmTokenPayload } from '../auth/confirm-token.ts';
import { capabilityMiddleware } from '../capabilities.ts';
import {
  deleteEmailDestination,
  getEmailDestinationByAddress,
  getEmailDestinationsByProjectId,
  getProjectByEmailAlias,
  getProjectBySlug,
  getUser,
  promoteEmailDestinationWithOwnerAudit,
  queueUnreferencedEmailDestinationCleanup,
  tryCreateEmailDestination,
  updateEmailDestinationStatus,
  type Db,
  type OwnerVerificationAudit,
} from '../db.ts';
import { getProjectEmailUsage, getProjectEmailLogs } from '../email/admission.ts';
import { emailDomainRoutes, emailZoneConnections } from '../email/connection-schema.ts';
import { EmailOperationError } from '../email/connection-service.ts';
import {
  addEmailDomainForProject,
  getEmailDomainStatusForProject,
  removeEmailDomainForProject,
  getEmailOperationForProject,
  serializeEmailRoute,
  syncEmailDomainForProject,
  rotateEmailIngressSecretForProject,
} from '../email/domain-service.ts';
import { sendPlatformVerificationEmail } from '../email/send-verification.ts';
import {
  getEmailDomainManagement,
  getEmailRecipientPolicy,
  repairEmailRecipientPolicyMirror,
} from '../email/settings.ts';
import {
  checkSharedEmailAliasRoutable,
  getSharedEmailRecipientReadiness,
  reconcileSharedEmailRecipient,
} from '../email/shared-recipient-service.ts';
import type { ApiEnv } from '../env.ts';
import { hasSqlState, isForeignKeyViolation } from '../pg-errors.ts';
import { resolvePlan } from '../plans.ts';
import {
  PROJECT_PERMISSION_MESSAGES,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  projectAccessErrorBody,
} from '../project-access.ts';
import { projectNameError } from '../project-names.ts';
import { runEmailDestinationCleanup } from '../provisioning/email-destination-cleanup.ts';
import {
  addDestination,
  isAlreadyExistsError,
  listDestinations,
  type CfDestinationAddress,
} from '../provisioning/email-routing.ts';
import { projects } from '../schema.ts';
import type { EmailDestination } from '../types.ts';
import { requireProjectRouteCapability } from './project-access.ts';

/**
 * Per-project rate-limit on POST /destinations to prevent abuse where a
 * project owner could spam an arbitrary recipient with platform-side
 * verification emails. Two windows so a sustained attacker can't pace
 * around the burst cap:
 *   - 5 requests / minute (TTL 5m)
 *   - 50 requests / day   (TTL 25h)
 *
 * Counters live in ROUTING KV. Treat malformed values as zero:
 * `parseInt('NaN', 10) → NaN` would silently bypass `count >= LIMIT` if
 * not coerced, so any non-finite or negative read becomes 0.
 */
const ADD_RATE_PER_MINUTE = 5;
const ADD_RATE_PER_DAY = 50;

/**
 * Cap the raw `address` string BEFORE `.trim().toLowerCase()` and BEFORE
 * `isValidEmail`. Both run ahead of the rate limiter, and a 400 never
 * charges it, so whatever they cost is free to the caller. `toLowerCase`
 * allocates a full-size copy up front (V8 sizes the result before it knows
 * nothing changed), and the loose regex backtracks quadratically on a
 * crafted string — `a@` + `b.` x 80k + ` x` (160 KB) is ~7s of CPU in the
 * shared isolate. RFC 5321 caps a forward-path at 256 octets, UTF-16 length
 * is never more than the octet count, so 320 cannot reject a deliverable
 * address. Same value as the proxy's `MAX_RECIPIENT_LENGTH`.
 */
const MAX_ADDRESS_LENGTH = 320;

/**
 * Email observability + destinations management.
 *
 * Usage and recipient consent are SQL-authoritative. The destination routes
 * proxy CF Email Routing's account-level address API and keep the per-project
 * consent view in sync.
 */
const app = new Hono<ApiEnv>()
  // Path-scoped, NOT `use('*')` as `domains.ts` does: this router is one of
  // several mounted at `/projects`, and Hono re-registers a sub-app's
  // `use('*')` as `ALL /projects/*` on the parent, where it runs for every
  // sibling mounted after it (`githubProjectRoutes`, `projectUsage`). Pinned
  // by the sibling-router test in `api-email.test.ts`.
  .use('/:id/email/*', capabilityMiddleware('email'))
  .get('/:id/email/usage', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'read');
    if (access instanceof Response) {
      return access;
    }

    return context.json(await getProjectEmailUsage(context.get('db'), projectId));
  })

  .get('/:id/email/logs', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'read');
    if (access instanceof Response) {
      return access;
    }

    const limit = Number(context.req.query('limit') ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return context.json({ error: 'limit must be between 1 and 100' }, 400);
    }
    return context.json(await getProjectEmailLogs(context.get('db'), projectId, limit));
  })

  // -------------------------------------------------------------------------
  // Destinations: per-project verified recipient addresses for outbound mail
  // via the shared platform sender (`EMAIL_SENDER_DOMAIN`, per environment).
  // CF Email Routing is the source of truth for verification status; the
  // platform adds a per-project allowlist on top so projects only see /
  // send to addresses they declared.
  // -------------------------------------------------------------------------
  .get('/:id/email/destinations', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }
    const project = access.project;

    const rows = await getEmailDestinationsByProjectId(context.get('db'), projectId);
    // Refresh status from CF for any rows still pending. CF's
    // listDestinations is account-level; we filter to the rows we care about.
    //
    // Platform-pending rows (verification_source='platform') are
    // intentionally excluded from CF refresh: CF already shows them as
    // verified (a different project verified them), but we issued our
    // own per-project confirmation link and the row stays pending until
    // THAT link is clicked. Refreshing from CF here would defeat the
    // platform-side verification gate (Option B in the email design doc).
    const pending = rows.filter(
      (r) => r.status === 'pending' && r.verification_source !== 'platform',
    );
    if (pending.length > 0) {
      try {
        const cfRows = await listDestinations(context.env.CF_ACCOUNT_ID, context.env.CF_API_TOKEN);
        const byEmail = new Map<string, CfDestinationAddress>();
        for (const cf of cfRows) {
          byEmail.set(cf.email.toLowerCase(), cf);
        }
        // The owner's address is read only when a row needs it (below).
        let ownerEmail: string | null | undefined;
        for (const row of pending) {
          const cf = byEmail.get(row.address);
          if (!cf?.verified) {
            continue;
          }
          if (cf.tag === row.cf_destination_id) {
            // The click answered the destination THIS row registered.
            const updated = await updateEmailDestinationStatus(
              context.get('db'),
              row.id,
              'verified',
              cf.tag,
              cf.verified,
            );
            if (!updated) {
              continue;
            }
          } else {
            // The account carries the address under a tag this row never
            // registered: its own destination was deleted at Cloudflare
            // (an operator, or the delete-vs-register window the DELETE
            // route names) and another project's add recreated it, so CF's
            // mail — which names no project — was answered for THAT
            // registration. Had the destination survived, this project
            // would have been the second registrant and taken the
            // per-project platform link (Option B); promoting by address
            // here would hand it the other registration's consent instead.
            // So a NON-owner row stays pending — `void email disallow` then
            // `allow` re-registers it, and because the address is now
            // CF-verified that add takes the platform link. This GET must
            // not mail that link itself. The OWNER's own address is Option
            // C: the human who clicked is the human who owns the project,
            // so the row adopts the live tag and records the inherited
            // consent the way the create paths do.
            if (ownerEmail === undefined) {
              const owner = await getUser(context.get('db'), project.user_id);
              ownerEmail = owner?.email?.toLowerCase() ?? null;
            }
            if (ownerEmail !== row.address) {
              console.warn(
                `[email] destination tag mismatch: row=${row.id} project=${projectId} registered=${row.cf_destination_id} cloudflare=${cf.tag}; the verified destination belongs to another registration, so the row stays pending (disallow + allow re-registers it)`,
              );
              continue;
            }
            // The helper re-checks the owner's address under a lock: the
            // read above is unlocked, and a login that rotates the address
            // can commit between it and this write.
            const promoted = await promoteEmailDestinationWithOwnerAudit(
              context.get('db'),
              projectId,
              row.id,
              cf.tag,
              cf.verified,
              { userId: project.user_id, emailSnapshot: ownerEmail },
            );
            if (!promoted) {
              console.warn(
                `[email] destination tag mismatch: row=${row.id} project=${projectId} registered=${row.cf_destination_id} cloudflare=${cf.tag}; the owner's address changed while the listing was refreshing, so the row stays pending`,
              );
              continue;
            }
            row.verified_by_user_id = project.user_id;
            row.verified_by_email_snapshot = ownerEmail;
          }
          row.status = 'verified';
          row.cf_destination_id = cf.tag;
          row.verified_at = cf.verified;
        }
      } catch (err) {
        console.error('[email] destinations refresh failed:', err);
        // Non-fatal — we still return the cached view.
      }
    }
    return context.json(rows.map(serializeDestination));
  })

  .post('/:id/email/destinations', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }
    const project = access.project;
    // Same guard the other provisioning routes use (see `routes/projects.ts`).
    // Teardown snapshots the CF destination tags it must clean up ONCE; a
    // destination registered after that snapshot but before the cascade drops
    // our rows leaves an account-level CF address no row points at any more.
    if (project.status === 'deleting') {
      return context.json({ error: 'Project is being deleted' }, 409);
    }

    // Malformed JSON is user input, not a server fault — 400 it here rather
    // than letting the throw reach the app-level `onError` 500 (same shape
    // the secrets/domains routes use).
    let body: { address?: unknown } = {};
    try {
      body = await context.req.json<{ address?: unknown }>();
    } catch {
      return context.json({ error: 'invalid address' }, 400);
    }
    // Length is checked on the RAW string: `MAX_ADDRESS_LENGTH` exists to
    // bound the normalization and the regex, so neither may run first.
    const raw = body.address;
    if (typeof raw !== 'string' || raw.length > MAX_ADDRESS_LENGTH) {
      return context.json({ error: 'invalid address' }, 400);
    }
    const address = raw.trim().toLowerCase();
    if (!isValidEmail(address)) {
      return context.json({ error: 'invalid address' }, 400);
    }

    // Rate-limit before Cloudflare calls. KV reads make this abuse gate approximate.
    const rateCheck = await checkAndIncrementAddRate(context.env.ROUTING, projectId);
    if (!rateCheck.allowed) {
      return context.json({ error: rateCheck.message }, 429);
    }

    const existing = await getEmailDestinationByAddress(context.get('db'), projectId, address);
    if (existing) {
      // A platform-pending row waits on OUR link (Option B below), which is
      // best-effort and expires in 24h — so a repeat POST is the resend, and
      // the only one a project owner has. The rate check above already
      // bounds it. A CF-pending row is not resendable: CF mails its own link
      // on create only, and the row flips via the GET refresh when clicked —
      // so that repeat is answered with `verificationSent: false`, the same
      // marker the recovered-owner insert below carries, because both mean
      // "nothing went out; the row waits on a Cloudflare link mailed earlier".
      if (existing.status === 'pending' && existing.verification_source === 'platform') {
        const accessResponse = await recheckEmailDestinationSettingsAccess(context, projectId);
        if (accessResponse) {
          return accessResponse;
        }
        await dispatchPlatformVerification(context, project, existing, address);
        return context.json(
          { ...serializeDestination(existing), platformVerificationPending: true },
          200,
        );
      }
      return context.json(
        existing.status === 'pending'
          ? { ...serializeDestination(existing), verificationSent: false }
          : serializeDestination(existing),
        200,
      );
    }

    // Create CF destination; CF responds with the tag and triggers the
    // verification email. If the address already exists on the CF account
    // (e.g. another project already registered it, or this is a same-
    // request race), narrowly handle the "already exists" error by
    // listing + reusing the existing record so we don't spam users with
    // duplicate verification emails and don't fail their request.
    // Other errors (auth, network, CF outage) are surfaced as 502.
    let cfRow: CfDestinationAddress;
    // `cfRow.verified` cannot distinguish a row CF just created for THIS
    // request from a row that was already on the account and nobody has
    // clicked yet — both report `null`. Only the recovery path below knows
    // which one we are holding, so it records that here.
    let recoveredExistingCfRow = false;
    try {
      cfRow = await addDestination(context.env.CF_ACCOUNT_ID, context.env.CF_API_TOKEN, address);
    } catch (err) {
      if (!isAlreadyExistsError(err)) {
        console.error('[email] addDestination failed:', err);
        return context.json({ error: 'failed to register destination' }, 502);
      }
      try {
        const all = await listDestinations(context.env.CF_ACCOUNT_ID, context.env.CF_API_TOKEN);
        const found = all.find((r) => r.email.toLowerCase() === address);
        if (!found) {
          console.error('[email] addDestination reported exists but list missed it:', err);
          return context.json({ error: 'failed to register destination' }, 502);
        }
        cfRow = found;
        recoveredExistingCfRow = true;
      } catch (innerErr) {
        console.error('[email] addDestination recovery failed:', innerErr);
        return context.json({ error: 'failed to register destination' }, 502);
      }
    }

    // C+B: when CF reports the address already verified, decide whether
    // to inherit that verification or issue our own platform-side check.
    //   Option C (owner-relaxed): the project owner's own email — trust
    //   CF. Most common case for second-and-later projects of the same
    //   user.
    //   Option B (everyone else): a different person/project verified
    //   it on CF. We cannot trust CF's verified flag for per-project
    //   consent, so we issue our own confirmation link and keep the row
    //   'pending' / 'platform' until the recipient clicks it.
    const owner = await getUser(context.get('db'), project.user_id);
    const ownerEmail = owner?.email?.toLowerCase() ?? null;
    const ownerMatches = !!ownerEmail && ownerEmail === address;
    const cfVerified = !!cfRow.verified;

    if (cfVerified && ownerMatches) {
      // Option C — owner-relaxed CF reuse. Persist who consented + the
      // email snapshot so we can revoke if the owner's identity later
      // changes (see `revokeOwnerVerifiedDestinationsForUserChange`).
      const ownerAudit: OwnerVerificationAudit = {
        userId: project.user_id,
        emailSnapshot: ownerEmail!,
      };
      const inserted = await tryInsertWithRetry(
        context,
        projectId,
        address,
        cfRow.tag,
        'verified',
        cfRow.verified ?? null,
        'cf',
        ownerAudit,
      );
      if (inserted instanceof Response) {
        return inserted;
      }
      if (!inserted.row) {
        // Either a sibling DELETE ate the row mid-INSERT-then-SELECT twice,
        // or project teardown's cascade landed between the `status` guard
        // above and the INSERT. Neither persisted the CF tag we just
        // registered, so roll it back rather than leaking an account-level
        // address, then surface a clean retryable error.
        await rollbackCfDestination(
          context.get('db'),
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          cfRow.tag,
        );
        return context.json({ error: 'destination concurrently modified, try again' }, 409);
      }
      const { row } = inserted;
      return context.json(serializeDestination(row), 201);
    }

    if (!ownerMatches && (cfVerified || recoveredExistingCfRow)) {
      // Option B — platform-side verification required. It is required
      // whenever the Cloudflare-side click is not ours to claim:
      //   - the row was already VERIFIED by someone else, or
      //   - the row was already on the account and still pending, meaning
      //     CF mailed the recipient for the OTHER project and will not mail
      //     again for this one (it refused our create).
      // Either way, nothing CF does can express consent for THIS project, so
      // our own link is the only one that can.
      //
      // Accepted cost: this creates a state where our row is `verified`
      // while the CF account row is still pending — the recipient clicked
      // OUR link, not CF's. The send then fails at the `send_email` binding,
      // and `packages/proxy/src/email.ts` classifies that CF error as
      // `UNVERIFIED_DESTINATION`, which the framework reports as "verify the
      // address first". It fails safe, and it self-heals the moment the
      // recipient clicks CF's link. No machinery for it.
      const inserted = await tryInsertWithRetry(
        context,
        projectId,
        address,
        cfRow.tag,
        'pending',
        null,
        'platform',
      );
      if (inserted instanceof Response) {
        return inserted;
      }
      if (!inserted.row) {
        await rollbackCfDestination(
          context.get('db'),
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          cfRow.tag,
        );
        return context.json({ error: 'destination concurrently modified, try again' }, 409);
      }
      const { row } = inserted;
      // Only fire a fresh confirmation email when WE inserted the row.
      // A sibling concurrent POST that races to the unique constraint
      // gets `inserted=false` and reads back the winner's row — without
      // this gate it would also dispatch a platform email, doubling
      // recipient mail per race.
      if (inserted.inserted && row.status === 'pending' && row.verification_source === 'platform') {
        await dispatchPlatformVerification(context, project, row, address);
      }
      return context.json({ ...serializeDestination(row), platformVerificationPending: true }, 201);
    }

    // The row waits on CLOUDFLARE's link. Two ways to get here:
    //   - CF created the address for THIS request: it is mailing the
    //     recipient right now, and the GET refresh flips the row to verified
    //     when they click.
    //   - The address is the owner's own and CF already held it, still
    //     pending (their first project's auto-add, or a hand add). CF refused
    //     our create and mails its link on create only, so NOTHING went out
    //     for this add — the link from the first add is the only one the
    //     owner has, and this route cannot mint another (CF has no resend
    //     API; `deleteDestination` + a fresh create is the only way, and the
    //     DELETE route takes it only when no other project references the
    //     tag). Report that as `verificationSent: false` rather than let a
    //     bare 201 read as "a link went out": `void email allow` prints
    //     "Verification email sent" from the status code alone.
    const inserted = await tryInsertWithRetry(
      context,
      projectId,
      address,
      cfRow.tag,
      'pending',
      null,
      'cf',
    );
    if (inserted instanceof Response) {
      return inserted;
    }
    if (!inserted.row) {
      await rollbackCfDestination(
        context.get('db'),
        context.env.CF_ACCOUNT_ID,
        context.env.CF_API_TOKEN,
        cfRow.tag,
      );
      return context.json({ error: 'destination concurrently modified, try again' }, 409);
    }
    return context.json(
      recoveredExistingCfRow
        ? { ...serializeDestination(inserted.row), verificationSent: false }
        : serializeDestination(inserted.row),
      201,
    );
  })

  .delete('/:id/email/destinations/:destId', async (context) => {
    const projectId = context.req.param('id');
    const destId = context.req.param('destId');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }
    const project = access.project;
    if (project.status === 'deleting') {
      return context.json({ error: 'Project is being deleted' }, 409);
    }

    const rows = await getEmailDestinationsByProjectId(context.get('db'), projectId);
    const dest = rows.find((r) => r.id === destId);
    if (!dest) {
      return context.json({ error: 'destination not found' }, 404);
    }

    let cleanupTag: string | null;
    try {
      cleanupTag = await deleteEmailDestination(context.get('db'), dest.id, context.get('user').id);
    } catch (error) {
      const accessResponse = projectAccessErrorResponse(context, error);
      if (accessResponse) {
        return accessResponse;
      }
      throw error;
    }
    if (cleanupTag) {
      await runEmailDestinationCleanup(
        context.get('db'),
        { accountId: context.env.CF_ACCOUNT_ID, apiToken: context.env.CF_API_TOKEN },
        cleanupTag,
      );
    }
    return context.json({ ok: true });
  })

  // -------------------------------------------------------------------------
  // Custom email domain routes. The connection service runs durable
  // operations; these routes apply project capabilities and map responses.
  // -------------------------------------------------------------------------

  // Installation settings the CLI needs before it acts: who manages email
  // domains here (an `admin` platform prints the administrator's command
  // instead of opening a Cloudflare consent) and the shared-sender recipient
  // policy. Read-only for project members; the operator API and admin UI write them.
  .get('/:id/email/settings', async (context) => {
    const projectId = context.req.param('id');
    const db = context.get('db');
    const access = await requireProjectRouteCapability(context, projectId, 'read');
    if (access instanceof Response) {
      return access;
    }
    const [management, recipientPolicy, sharedInbound] = await Promise.all([
      getEmailDomainManagement(db),
      getEmailRecipientPolicy(db),
      getSharedEmailRecipientReadiness(db, context.env, projectId, true),
    ]);
    // Republish a drifted recipient-policy mirror for the proxy's local gate.
    await repairEmailRecipientPolicyMirror(db, context.env.ROUTING);
    return context.json({
      domains: { management, projectSlug: access.project.slug },
      recipientPolicy: { mode: recipientPolicy.mode, domains: [...recipientPolicy.domains] },
      emailAlias: access.project.email_alias,
      // Set even when the platform has no shared inbound route: projects can
      // still send from the slug or alias on it.
      sharedDomain: context.env.EMAIL_SENDER_DOMAIN?.toLowerCase() ?? null,
      sharedInbound,
    });
  })

  // Give the project a shorter name on the shared mail domain. The alias is set
  // once and never changes, so reply addresses built on it keep working. The
  // slug keeps sending and receiving too.
  .put('/:id/email/alias', async (context) => {
    const projectId = context.req.param('id');
    const db = context.get('db');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }
    if (access.role !== 'owner') {
      return context.json(
        { error: 'forbidden', message: PROJECT_PERMISSION_MESSAGES['email-alias'] },
        403,
      );
    }
    if (!context.env.EMAIL_SENDER_DOMAIN) {
      return context.json({ error: 'this platform has no shared mail domain' }, 409);
    }
    let body: { alias?: unknown };
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: 'alias is required' }, 400);
    }
    const alias = typeof body.alias === 'string' ? body.alias : '';
    if (!alias) {
      return context.json({ error: 'alias is required' }, 400);
    }
    const nameError = projectNameError(alias, 'alias');
    if (nameError) {
      return context.json({ error: nameError }, 400);
    }
    if (access.project.email_alias) {
      return context.json(
        {
          error: `this project already has the email alias ${access.project.email_alias}; it cannot be changed`,
        },
        409,
      );
    }
    if (alias === access.project.slug) {
      return context.json({ error: 'alias must differ from the project slug' }, 400);
    }
    // The same plan rule as short project slugs.
    if (alias.length <= 5 && !(await resolvePlan(db, access.owner.plan)).allowShortSlugs) {
      return context.json(
        { error: 'the selected plan does not permit short names (5 characters or fewer)' },
        403,
      );
    }
    if ((await getProjectBySlug(db, alias)) ?? (await getProjectByEmailAlias(db, alias))) {
      return context.json({ error: 'this name is already taken' }, 409);
    }
    try {
      await checkSharedEmailAliasRoutable(db, context.env, access.project.slug, alias);
    } catch (error) {
      if (error instanceof EmailOperationError) {
        return context.json({ error: error.message }, error.status as ContentfulStatusCode);
      }
      throw error;
    }
    let saved: boolean;
    try {
      saved = await db.transaction(async (tx) => {
        const rows = await tx
          .update(projects)
          .set({ email_alias: alias })
          .where(
            and(
              eq(projects.id, projectId),
              eq(projects.status, 'active'),
              isNull(projects.email_alias),
            ),
          )
          .returning({ id: projects.id });
        return rows.length === 1;
      });
    } catch (error) {
      // The trigger and unique index refuse a name another project claimed meanwhile.
      if (hasSqlState(error, '23505')) {
        return context.json({ error: 'this name is already taken' }, 409);
      }
      throw error;
    }
    if (!saved) {
      return context.json({ error: 'the project changed; reload it and try again' }, 409);
    }
    // Create the alias rule now when the project already receives mail. The
    // scheduled repair retries a failure.
    try {
      await reconcileSharedEmailRecipient(db, context.env, projectId);
    } catch (error) {
      console.error('[email-alias] shared recipient reconcile failed', { projectId, error });
    }
    return context.json({
      emailAlias: alias,
      address: `${alias}@${context.env.EMAIL_SENDER_DOMAIN.toLowerCase()}`,
      sharedInbound: await getSharedEmailRecipientReadiness(db, context.env, projectId),
    });
  })

  .get('/:id/email/domains', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'read');
    if (access instanceof Response) {
      return access;
    }

    const rows = await context
      .get('db')
      .select()
      .from(emailDomainRoutes)
      .innerJoin(emailZoneConnections, eq(emailZoneConnections.id, emailDomainRoutes.connection_id))
      .where(
        and(
          eq(emailDomainRoutes.project_id, projectId),
          ne(emailDomainRoutes.desired_state, 'removed'),
        ),
      )
      .orderBy(asc(emailDomainRoutes.created_at));
    return context.json(
      rows.map((row) => serializeEmailRoute(row.email_domain_routes, row.email_zone_connections)),
    );
  })

  .post('/:id/email/domains', async (context) => {
    const projectId = context.req.param('id');
    let body: {
      domain?: unknown;
      refreshToken?: unknown;
      apiToken?: unknown;
      attemptId?: unknown;
    } = {};
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: 'invalid domain' }, 400);
    }
    if (body.refreshToken !== undefined) {
      return context.json(
        { error: 'OAuth grants are not supported; use a scoped Cloudflare API token' },
        400,
      );
    }
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }
    return addEmailDomainForProject(context, access.project, {
      domain: typeof body.domain === 'string' ? body.domain : '',
      apiToken: typeof body.apiToken === 'string' ? body.apiToken : undefined,
      attemptId: body.attemptId,
      managedBy: 'owner',
    });
  })

  .get('/:id/email/operations/:operationId', async (context) => {
    const access = await requireProjectRouteCapability(context, context.req.param('id'), 'read');
    if (access instanceof Response) {
      return access;
    }
    return getEmailOperationForProject(context, access.project, context.req.param('operationId'));
  })

  .get('/:id/email/domains/:domain', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'read');
    if (access instanceof Response) {
      return access;
    }
    return getEmailDomainStatusForProject(context, access.project, context.req.param('domain'));
  })

  .post('/:id/email/domains/:domain/rotate-secret', async (context) => {
    const access = await requireProjectRouteCapability(
      context,
      context.req.param('id'),
      'settings',
    );
    if (access instanceof Response) {
      return access;
    }
    let attemptId: string | undefined;
    if (context.req.header('content-type')?.includes('application/json')) {
      let body: { attemptId?: unknown };
      try {
        body = await context.req.json();
      } catch {
        return context.json({ error: 'invalid JSON' }, 400);
      }
      if (
        body.attemptId !== undefined &&
        (typeof body.attemptId !== 'string' ||
          body.attemptId.length < 1 ||
          body.attemptId.length > 128)
      ) {
        return context.json({ error: 'invalid attemptId' }, 400);
      }
      attemptId = body.attemptId as string | undefined;
    }
    return rotateEmailIngressSecretForProject(
      context,
      access.project,
      context.req.param('domain'),
      'owner',
      attemptId,
    );
  })

  .post('/:id/email/domains/:domain/sync', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }
    return syncEmailDomainForProject(context, access.project, context.req.param('domain'), 'owner');
  })

  .delete('/:id/email/domains/:domain', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }
    return removeEmailDomainForProject(
      context,
      access.project,
      context.req.param('domain'),
      'owner',
    );
  });

export function parseCounter(raw: string | null): number {
  if (!raw) {
    return 0;
  }
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Loose RFC 5322 sanity check. Defers real validation to CF Email
 * Routing — we just want to keep obviously-bad input out of the rate
 * limiter / CF API call.
 */
function isValidEmail(s: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
}

function serializeDestination(row: EmailDestination) {
  return {
    id: row.id,
    address: row.address,
    status: row.status,
    verified_at: row.verified_at,
    verification_source: row.verification_source,
    created_at: row.created_at,
  };
}

function projectAccessErrorResponse(context: Context<ApiEnv>, error: unknown): Response | null {
  if (error instanceof ProjectNotFoundError || error instanceof ProjectAccessDeniedError) {
    return context.json(projectAccessErrorBody(error), error.status);
  }
  return null;
}

async function recheckEmailDestinationSettingsAccess(
  context: Context<ApiEnv>,
  projectId: string,
): Promise<Response | null> {
  return context.get('db').transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    const access = await requireProjectRouteCapability(context, projectId, 'settings', tx);
    return access instanceof Response ? access : null;
  });
}

/**
 * Mint a fresh 24h confirmation token for a platform-pending row and mail
 * the link (Option B). Shared by the first insert and the repeat-POST
 * resend; the token is single-use by ROW state, so an earlier unexpired
 * link stays valid and a second click is idempotent.
 */
async function dispatchPlatformVerification(
  context: Context<ApiEnv>,
  project: { id: string; slug: string },
  row: EmailDestination,
  address: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const tokenPayload: ConfirmTokenPayload = {
    v: 1,
    pid: project.id,
    did: row.id,
    addr: address,
    iat: now,
    exp: now + 24 * 60 * 60,
  };
  const token = await signConfirmToken(tokenPayload, context.env.EMAIL_SIGNING_SECRET);
  const sendPromise = sendPlatformVerificationEmail(
    context.env,
    { id: project.id, slug: project.slug },
    address,
    token,
  );
  // Keep delivery alive after the response; contexts without waitUntil await it.
  // Delivery failures are logged; missing platform-mail configuration still rejects.
  try {
    context.executionCtx.waitUntil(sendPromise);
  } catch {
    await sendPromise;
  }
}

/**
 * Insert + retry-on-race wrapper around `tryCreateEmailDestination`.
 *
 * A missing row can mean the conflicting row disappeared before readback,
 * or that project teardown marked the project deleting after the route's
 * initial guard. One retry resolves the former; the latter stays rejected
 * and lets the caller retire the provider tag.
 */
async function tryInsertWithRetry(
  context: Context<ApiEnv>,
  projectId: string,
  address: string,
  cfDestinationId: string | null,
  status: EmailDestination['status'],
  verifiedAt: string | null,
  verificationSource: EmailDestination['verification_source'],
  ownerAudit?: OwnerVerificationAudit,
): Promise<{ row: EmailDestination | null; inserted: boolean } | Response> {
  const db = context.get('db');
  for (let attempt = 0; attempt < 2; attempt++) {
    let result: { row: EmailDestination | null; inserted: boolean; ownerEmailChanged?: true };
    try {
      result = await tryCreateEmailDestination(
        db,
        projectId,
        address,
        cfDestinationId,
        status,
        verifiedAt,
        verificationSource,
        { actorUserId: context.get('user').id, ownerAudit },
      );
    } catch (err) {
      const accessResponse = projectAccessErrorResponse(context, err);
      if (accessResponse) {
        if (cfDestinationId) {
          await rollbackCfDestination(
            db,
            context.env.CF_ACCOUNT_ID,
            context.env.CF_API_TOKEN,
            cfDestinationId,
          );
        }
        return accessResponse;
      }
      if (!isForeignKeyViolation(err)) {
        throw err;
      }
      // Project teardown committed its cascade between the route's
      // `status === 'deleting'` guard (an unlocked read) and this INSERT, so
      // `email_destinations.project_id` has no project row left to point at.
      // Retrying cannot help — the project is gone for good. Report the same
      // "not inserted" shape as the row-deleted race so the caller rolls the
      // CF destination back (`rollbackCfDestination`) and answers 409,
      // instead of letting a raw 23503 reach the app's `onError` as a 500
      // that leaves the account-level address allocated with nothing left to
      // reclaim it.
      return { row: null, inserted: false };
    }
    if (result.row || result.ownerEmailChanged) {
      return result;
    }
  }
  return { row: null, inserted: false };
}

/** Queue an allocated provider tag when its project row did not land. */
export async function rollbackCfDestination(
  db: Db,
  accountId: string,
  apiToken: string,
  cfDestinationId: string,
): Promise<void> {
  if (await queueUnreferencedEmailDestinationCleanup(db, cfDestinationId)) {
    await runEmailDestinationCleanup(db, { accountId, apiToken }, cfDestinationId);
  }
}

/**
 * Approximate per-project rate-limit on POST /destinations. Malformed values
 * become zero so they cannot bypass the numeric comparisons.
 *
 * Not strongly consistent — KV reads can lag writes for ~60s per colo,
 * so racing requests across colos can exceed the limit by a few. That's
 * fine for this defense: we want order-of-magnitude protection against
 * spam, not a strict cap.
 */
async function checkAndIncrementAddRate(
  kv: KVNamespace,
  projectId: string,
): Promise<{ allowed: true } | { allowed: false; message: string }> {
  const now = new Date();
  const minuteKey = `email-add-rate:${projectId}:${minuteBucket(now)}`;
  const dayKey = `email-add-rate:${projectId}:${dayBucket(now)}`;
  const [minuteRaw, dayRaw] = await Promise.all([kv.get(minuteKey), kv.get(dayKey)]);
  const minute = parseCounter(minuteRaw);
  const day = parseCounter(dayRaw);
  if (minute >= ADD_RATE_PER_MINUTE) {
    return {
      allowed: false,
      message: `too many destination requests per minute (limit ${ADD_RATE_PER_MINUTE}); try again shortly`,
    };
  }
  if (day >= ADD_RATE_PER_DAY) {
    return {
      allowed: false,
      message: `too many destination requests today (limit ${ADD_RATE_PER_DAY}); try again tomorrow`,
    };
  }
  await Promise.all([
    kv.put(minuteKey, String(minute + 1), { expirationTtl: 5 * 60 }),
    kv.put(dayKey, String(day + 1), { expirationTtl: 25 * 60 * 60 }),
  ]);
  return { allowed: true };
}

export function minuteBucket(now: Date): string {
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(
    now.getUTCDate(),
  ).padStart(2, '0')}T${String(now.getUTCHours()).padStart(2, '0')}${String(
    now.getUTCMinutes(),
  ).padStart(2, '0')}`;
}

export function dayBucket(now: Date): string {
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(
    now.getUTCDate(),
  ).padStart(2, '0')}`;
}

export default app;
