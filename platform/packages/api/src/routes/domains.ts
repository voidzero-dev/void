import { sql as drizzleSql } from 'drizzle-orm';
import { Hono } from 'hono';
import { capabilityMiddleware } from '../capabilities.ts';
import { SITE_DOMAIN } from '../constants.ts';
import {
  createDomain,
  getDomainsByProjectId,
  getDomain,
  getDomainByHostname,
  getDomainByHostnameOrCfHostnameId,
  deleteDomain,
  type Db,
} from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { tryActivateDomain } from '../provisioning/activate-domain.ts';
import {
  CloudflareApiError,
  createCustomHostname,
  deleteCustomHostname,
  getCustomHostnameByHostname,
  type CustomHostnameInfo,
} from '../provisioning/cloudflare-api.ts';
import type { DomainVerificationData } from '../schema.ts';
import { ZeroTrustUnavailableError } from '../zero-trust/errors.ts';
import { lockZeroTrustConfiguration } from '../zero-trust/lock.ts';
import { reconcileProjectZeroTrustDomains } from '../zero-trust/project.ts';
import {
  getProjectZeroTrustState,
  markProjectCustomDomainsChanged,
  MAX_ZERO_TRUST_CUSTOM_DOMAINS_PER_PROJECT,
} from '../zero-trust/state.ts';
import { requireProjectRouteCapability } from './project-access.ts';

const ORPHAN_ADOPTION_MIN_AGE_MS = 60_000;
const DOMAIN_LIMIT_ERROR = `Protected projects support at most ${MAX_ZERO_TRUST_CUSTOM_DOMAINS_PER_PROJECT} custom domains`;

// Whitelist of CF status codes the create-hostname route surfaces to the
// caller. See the catch block on `createCustomHostname` for the full
// rationale on why 401/403/404 are NOT in this set.
const CF_PASSTHROUGH_STATUSES = new Set<number>([400, 409, 422, 429]);

function isAdoptablePostCreateOrphan(cfHostname: CustomHostnameInfo): boolean {
  if (cfHostname.status !== 'pending') {
    return false;
  }

  if (!cfHostname.ownership_verification && !cfHostname.ownership_verification_http) {
    return false;
  }

  if (!cfHostname.created_at) {
    return false;
  }

  const createdAtMs = Date.parse(cfHostname.created_at);
  return Number.isFinite(createdAtMs) && Date.now() - createdAtMs >= ORPHAN_ADOPTION_MIN_AGE_MS;
}

async function protectedProjectReachedDomainLimit(db: Db, projectId: string): Promise<boolean> {
  const zeroTrust = await getProjectZeroTrustState(db, projectId);
  if (!zeroTrust?.desired_protected) {
    return false;
  }
  return (
    (await getDomainsByProjectId(db, projectId)).length >= MAX_ZERO_TRUST_CUSTOM_DOMAINS_PER_PROJECT
  );
}

const app = new Hono<ApiEnv>()
  .use('/:id/domains/*', capabilityMiddleware('customDomains'))

  // Add a custom domain to a project
  .post('/:id/domains', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }

    const { hostname } = await context.req.json<{ hostname: string }>();

    if (!hostname || typeof hostname !== 'string') {
      return context.json({ error: 'hostname is required' }, 400);
    }

    if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)) {
      return context.json({ error: 'invalid hostname format' }, 400);
    }

    const siteDomain = context.env.SITE_DOMAIN ?? SITE_DOMAIN;
    if (hostname.endsWith(`.${siteDomain}`)) {
      return context.json({ error: `cannot use ${siteDomain} subdomains` }, 400);
    }

    const existing = await getDomainByHostname(context.get('db'), hostname);
    if (existing) {
      return context.json({ error: 'hostname already in use' }, 409);
    }
    if (await protectedProjectReachedDomainLimit(context.get('db'), projectId)) {
      return context.json({ error: DOMAIN_LIMIT_ERROR }, 409);
    }

    // Create custom hostname via CF API. CF's 4xx responses are not all
    // semantically equivalent and only a subset can be safely surfaced to
    // the caller:
    //
    //   400 — hostname validation (reserved TLDs, malformed names): caller-fixable
    //   409 — hostname already registered to another account: caller-fixable
    //   422 — other validation: caller-fixable
    //   429 — CF rate limit: transient; caller should back off (retry-after)
    //
    // 401 and 403 BOTH commonly indicate our `CF_API_TOKEN` is broken or
    // under-scoped — a server-config fault the caller can't act on, and
    // whose CF message ("Authentication error", "permission denied", etc.)
    // would leak internal state if surfaced. 403 is also returned for some
    // caller-fixable cases (SaaS zone-apex collision), but the HTTP status
    // alone can't disambiguate and this route does not map CF error codes,
    // so 403 is treated like 401 and re-thrown → onError → generic 500.
    //
    // Same for 404 (could be zone-not-found = misconfig) and any other
    // status not in the whitelist. CF 5xx (upstream degraded) also re-throws.
    //
    // The duplicate-hostname case can be a CF object left behind after an
    // earlier post-create DB failure. Only adopt still-pending CF objects with
    // an outstanding ownership challenge; a previously verified/active hostname
    // must not become claimable by another project without fresh ownership.
    // Cloudflare creation is a reversible first phase. The durable second
    // phase below takes the project lock and rechecks access before inserting
    // the row. If a membership change or teardown wins that lock, hand the CF
    // object back before returning the rejection; if this request wins, the
    // domain commits before the membership write can proceed.
    let cfHostname: CustomHostnameInfo;
    let createdCfHostname: CustomHostnameInfo | undefined;
    try {
      cfHostname = await createCustomHostname(
        context.env.CF_ZONE_ID,
        context.env.CF_API_TOKEN,
        hostname,
      );
      createdCfHostname = cfHostname;
    } catch (err) {
      if (err instanceof CloudflareApiError && err.status === 409) {
        const existingAfterConflict = await getDomainByHostname(context.get('db'), hostname);
        if (existingAfterConflict) {
          return context.json({ error: 'hostname already in use' }, 409);
        }

        let orphanedHostname: CustomHostnameInfo | null;
        try {
          orphanedHostname = await getCustomHostnameByHostname(
            context.env.CF_ZONE_ID,
            context.env.CF_API_TOKEN,
            hostname,
          );
        } catch (lookupErr) {
          if (lookupErr instanceof CloudflareApiError && lookupErr.status === 429) {
            return context.json({ error: lookupErr.message }, 429);
          }
          return context.json({ error: err.message }, 409);
        }

        if (orphanedHostname && isAdoptablePostCreateOrphan(orphanedHostname)) {
          cfHostname = orphanedHostname;
        } else {
          return context.json({ error: err.message }, 409);
        }
      } else if (err instanceof CloudflareApiError && CF_PASSTHROUGH_STATUSES.has(err.status)) {
        return context.json({ error: err.message }, err.status as 400 | 409 | 422 | 429);
      } else {
        throw err;
      }
    }

    const rollbackCreatedHostname = async (): Promise<void> => {
      if (!createdCfHostname) {
        return;
      }
      const persistedDomain = await getDomainByHostnameOrCfHostnameId(
        context.get('db'),
        hostname,
        createdCfHostname.id,
      );
      if (!persistedDomain) {
        await deleteCustomHostname(
          context.env.CF_ZONE_ID,
          context.env.CF_API_TOKEN,
          createdCfHostname.id,
        ).catch((deleteErr) => {
          console.error(
            `Failed to delete orphaned custom hostname ${createdCfHostname?.id} after DB transaction failure:`,
            deleteErr,
          );
        });
      }
    };

    try {
      const lockedResult = await context.get('db').transaction(async (tx) => {
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const lockedAccess = await requireProjectRouteCapability(
          context,
          projectId,
          'settings',
          tx,
        );
        if (lockedAccess instanceof Response) {
          return lockedAccess;
        }
        if (lockedAccess.project.status === 'deleting') {
          return context.json({ error: 'Project is being deleted' }, 409);
        }

        // Recheck after waiting for the project lock. A prior request for this
        // project may have committed while this request was queued.
        const lockedExisting = await getDomainByHostname(tx, hostname);
        if (lockedExisting) {
          return context.json({ error: 'hostname already in use' }, 409);
        }
        if (await protectedProjectReachedDomainLimit(tx, projectId)) {
          return context.json({ error: DOMAIN_LIMIT_ERROR }, 409);
        }

        // Under HTTP-DCV the certificate is validated at CF's edge once the
        // hostname proxies through it, so CF never emits
        // `ssl.validation_records`. Persist the ownership challenge returned
        // synchronously with the create response.
        const verificationData: DomainVerificationData = {
          ownership_verification: cfHostname.ownership_verification,
          ssl_validation_records: cfHostname.ssl.validation_records,
        };
        const domain = await createDomain(tx, projectId, hostname, cfHostname.id, verificationData);

        return context.json({
          ...domain,
          cname_target: `cname.${context.env.SITE_DOMAIN ?? SITE_DOMAIN}`,
          ownership_verification: cfHostname.ownership_verification,
          ssl_validation_records: cfHostname.ssl.validation_records ?? [],
        });
      });
      if (!lockedResult.ok) {
        await rollbackCreatedHostname();
      }
      return lockedResult;
    } catch (err) {
      // A CF create can succeed even when the DB transaction later fails to
      // insert or commit. Hand back only the object this request created; an
      // adopted pre-existing hostname belongs to the recovery path and must
      // not be deleted. The read-back also protects a concurrent winning
      // request that durably persisted this exact object.
      await rollbackCreatedHostname();
      throw err;
    }
  })

  // List domains for a project
  .get('/:id/domains', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'read');
    if (access instanceof Response) {
      return access;
    }

    const domains = await getDomainsByProjectId(context.get('db'), projectId);
    return context.json(domains);
  })

  // Get domain status (polls CF API for live status)
  .get('/:id/domains/:domainId', async (context) => {
    const projectId = context.req.param('id');
    const domainId = context.req.param('domainId');

    const access = await requireProjectRouteCapability(context, projectId, 'read');
    if (access instanceof Response) {
      return access;
    }
    const project = access.project;

    const domain = await getDomain(context.get('db'), domainId);
    if (!domain || domain.project_id !== projectId) {
      return context.json({ error: 'domain not found' }, 404);
    }

    const { cf, activated, awaitingDeployment } = await tryActivateDomain(
      context.env,
      context.get('db'),
      domain,
      project,
    );

    return context.json({
      ...domain,
      status: activated || domain.status === 'active' ? 'active' : domain.status,
      cname_target: `cname.${context.env.SITE_DOMAIN ?? SITE_DOMAIN}`,
      ssl_status: cf.ssl.status,
      cf_status: cf.status,
      awaiting_deployment: awaitingDeployment,
      verification_errors: cf.verification_errors,
      ownership_verification: cf.ownership_verification,
      ssl_validation_records: cf.ssl.validation_records ?? [],
    });
  })

  // Remove a custom domain
  .delete('/:id/domains/:domainId', async (context) => {
    const projectId = context.req.param('id');
    const domainId = context.req.param('domainId');

    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }

    const domain = await getDomain(context.get('db'), domainId);
    if (!domain || domain.project_id !== projectId) {
      return context.json({ error: 'domain not found' }, 404);
    }

    const warnings: Array<string> = [];

    // CF cleanup is best-effort. KV + DB deletion serialize with deploy,
    // rollback, activation, and failed-cutover compensation through the
    // project row so none can resurrect this hostname from a stale snapshot.
    // The shared Zero Trust lock comes before any cleanup: when it refuses
    // during uninstall, nothing outside the database has been removed yet.
    const lockedResponse = await context.get('db').transaction(async (tx) => {
      await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
      try {
        await lockZeroTrustConfiguration(tx, 'shared');
      } catch (error) {
        if (error instanceof ZeroTrustUnavailableError) {
          return context.json({ error: error.message }, error.status);
        }
        throw error;
      }
      const lockedAccess = await requireProjectRouteCapability(context, projectId, 'settings', tx);
      if (lockedAccess instanceof Response) {
        return lockedAccess;
      }
      await deleteCustomHostname(
        context.env.CF_ZONE_ID,
        context.env.CF_API_TOKEN,
        domain.cf_hostname_id,
      ).catch((err) => {
        warnings.push(
          `Failed to delete custom hostname: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      await context.env.ROUTING.delete(`domain:${domain.hostname}`).catch((err) => {
        warnings.push(
          `Failed to delete routing entry: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      // The project's custom domain application still lists this hostname.
      // Record that with the deletion, so the hostname is never freed while
      // no retry would remove it from that application.
      await markProjectCustomDomainsChanged(tx, projectId);
      await deleteDomain(tx, domain.id);
      return null;
    });
    if (lockedResponse) {
      return lockedResponse;
    }

    await reconcileProjectZeroTrustDomains(context.env, context.get('db'), projectId).catch(
      (err) => {
        warnings.push(
          `Failed to reconcile Zero Trust custom-domain protection: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );

    return context.json({ ok: true, ...(warnings.length > 0 && { warnings }) });
  });

export default app;
