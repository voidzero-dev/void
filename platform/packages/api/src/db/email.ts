import { and, countDistinct, asc, eq, sql } from 'drizzle-orm';
import { lockEmailPolicy } from '../email/admission.ts';
import { generateId } from '../id.ts';
import { requireProjectCapability } from '../project-access.ts';
import { users, projects, emailDestinations, emailDestinationCleanups } from '../schema.ts';
import type { EmailDestination } from '../types.ts';
import type { DbOrTx, Db, Tx } from './client.ts';

// --- Email destinations ---

/**
 * The human whose CF-side consent an owner-relaxed row inherits, captured
 * at insert-time. See `emailDestinations.verified_by_*` in `schema.ts`.
 */
export interface OwnerVerificationAudit {
  /** users.id of the human whose CF-side consent we inherited. */
  userId: string;
  /** That user's email address at insert-time (snapshot for revocation). */
  emailSnapshot: string;
}

type EmailDestinationMutationOptions = Readonly<{
  ownerAudit?: OwnerVerificationAudit;
  actorUserId?: string;
}>;

async function requireEmailDestinationSettingsAccess(
  db: DbOrTx,
  projectId: string,
  actorUserId: string | undefined,
): Promise<void> {
  if (actorUserId) {
    await requireProjectCapability(db, projectId, actorUserId, 'settings');
  }
}

/** A provider tag queued for cleanup must never be adopted again. */
async function isRetiredDestination(tx: DbOrTx, cfDestinationId: string): Promise<boolean> {
  const [retired] = await tx
    .select({ id: emailDestinationCleanups.cf_destination_id })
    .from(emailDestinationCleanups)
    .where(eq(emailDestinationCleanups.cf_destination_id, cfDestinationId))
    .limit(1);
  return !!retired;
}

/** Locks the owner's `users` row FOR SHARE and compares its email to the snapshot. */
async function ownerEmailMatches(tx: DbOrTx, ownerAudit: OwnerVerificationAudit): Promise<boolean> {
  const [owner] = await tx
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, ownerAudit.userId))
    .for('share')
    .limit(1);
  return (owner?.email?.toLowerCase() ?? null) === ownerAudit.emailSnapshot.toLowerCase();
}

/** Number of projects whose consent rows still reference a provider tag. */
async function countDestinationReferences(tx: DbOrTx, cfDestinationId: string): Promise<number> {
  const [references] = await tx
    .select({ n: countDistinct(emailDestinations.project_id) })
    .from(emailDestinations)
    .where(eq(emailDestinations.cf_destination_id, cfDestinationId));
  return Number(references?.n ?? 0);
}

/**
 * RETURNING identifies the sole inserter so only it sends a verification email.
 * A missing row means it was concurrently deleted; callers must retry.
 *
 * Inherited owner consent requires a FOR SHARE lock on users: an email change
 * must either commit before this check or revoke the inserted row afterward.
 * Lock projects first to match build transactions and avoid a lock-order cycle.
 * A supplied actor is reauthorized after that project lock is acquired.
 */
export async function tryCreateEmailDestination(
  db: Db,
  projectId: string,
  address: string,
  cfDestinationId: string | null,
  status: EmailDestination['status'] = 'pending',
  verifiedAt?: string | null,
  verificationSource: EmailDestination['verification_source'] = 'cf',
  options: EmailDestinationMutationOptions = {},
): Promise<{ row: EmailDestination | null; inserted: boolean; ownerEmailChanged?: true }> {
  const { actorUserId, ownerAudit } = options;
  const values = {
    id: generateId('edst'),
    project_id: projectId,
    address: address.toLowerCase(),
    cf_destination_id: cfDestinationId,
    status,
    verified_at: status === 'verified' ? (verifiedAt ?? new Date().toISOString()) : null,
    verification_source: verificationSource,
    verified_by_user_id: ownerAudit?.userId ?? null,
    verified_by_email_snapshot: ownerAudit?.emailSnapshot ?? null,
  };
  const outcome = await db.transaction(async (tx) => {
    await lockEmailPolicy(tx);
    const [project] = await tx
      .select({ status: projects.status, ownerUserId: projects.user_id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('update')
      .limit(1);
    if (!project || project.status === 'deleting') {
      return 'project-unavailable' as const;
    }
    await requireEmailDestinationSettingsAccess(tx, projectId, actorUserId);
    if (
      ownerAudit &&
      (project.ownerUserId !== ownerAudit.userId || !(await ownerEmailMatches(tx, ownerAudit)))
    ) {
      return 'owner-email-changed' as const;
    }
    if (cfDestinationId && (await isRetiredDestination(tx, cfDestinationId))) {
      return undefined;
    }
    const [row] = await tx
      .insert(emailDestinations)
      .values(values)
      .onConflictDoNothing({ target: [emailDestinations.project_id, emailDestinations.address] })
      .returning();
    return row;
  });
  if (outcome === 'owner-email-changed') {
    return { row: null, inserted: false, ownerEmailChanged: true };
  }
  if (outcome === 'project-unavailable') {
    return { row: null, inserted: false };
  }
  if (outcome) {
    return { row: outcome, inserted: true };
  }
  // A concurrent insert may have won, or cleanup retired the provider tag.
  // Return an existing project row if present; otherwise the caller retries.
  const existing = await getEmailDestinationByAddress(db, projectId, address);
  return { row: existing, inserted: false };
}

/**
 * Revoke owner-inherited CF verification when the project owner's email
 * identity changes (e.g. OAuth email update on a re-link).
 *
 * Affects only rows where:
 *   - `verification_source = 'cf'` (we inherited a CF flag, not a
 *     platform-side click)
 *   - `verified_by_user_id = userId` (the same human consented)
 *   - `verified_by_email_snapshot = oldEmail` (the address they used)
 *
 * Such rows trace back to the owner-relaxed branch in `routes/email.ts`
 * (Option C). When the owner's email changes, the consent that
 * authorized those rows no longer represents the current identity, so
 * we flip them back to 'pending' / 'platform' (rather than
 * hard-deleting) to give the user a re-confirm path: a repeat
 * `void email allow <address>` re-sends our own confirmation link and
 * the confirm route flips the row back, without losing its history. We
 * also clear the audit columns so the row no longer claims to be
 * owner-verified by a stale identity.
 *
 * Called from the OAuth callback in `routes/auth.ts`, which re-reads the
 * provider's current email on every login and writes it straight back
 * via `updateUser` — so the stored address really does change under us.
 * The caller runs this in the same transaction as `updateUser` so consent
 * and the owner's current address change together.
 */
export async function revokeOwnerVerifiedDestinationsForUserChange(
  db: Db,
  userId: string,
  oldEmail: string,
): Promise<void> {
  const lowered = oldEmail.toLowerCase();
  // The caller holds the policy lock in its surrounding profile transaction.
  // Lock affected projects before changing consent so admission cannot read
  // their old verified destinations after this revocation commits.
  const affected = await db
    .selectDistinct({ project_id: emailDestinations.project_id })
    .from(emailDestinations)
    .where(
      and(
        eq(emailDestinations.verified_by_user_id, userId),
        sql`lower(${emailDestinations.verified_by_email_snapshot}) = ${lowered}`,
        eq(emailDestinations.verification_source, 'cf'),
      ),
    );
  for (const projectId of affected.map((row) => row.project_id).sort()) {
    await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('update');
  }
  await db
    .update(emailDestinations)
    .set({
      status: 'pending',
      verified_at: null,
      verified_by_user_id: null,
      verified_by_email_snapshot: null,
      // Re-sourcing the row to 'platform' is what makes the demotion
      // STICK. The destinations GET in `routes/email.ts` refreshes every
      // row matching `status = 'pending' && verification_source !== 'platform'`
      // against CF's account-level list — and nothing deleted the address
      // on CF's side, so CF still reports it verified. A row left as 'cf'
      // therefore drops straight back into that filter and the very next
      // `void email destinations` re-promotes it to 'verified', undoing
      // this revoke entirely. 'platform' is also the correct state on the
      // merits: the account-level CF flag is exactly the consent we just
      // decided we can no longer inherit, so the only thing that may
      // re-verify the row is a per-recipient click on our own confirmation
      // link (a repeat `void email allow <address>` re-sends it).
      //
      // Safe inside this statement: Postgres evaluates the WHERE predicate
      // against the PRE-update row, so narrowing `verification_source` to
      // 'platform' here cannot de-select the `= 'cf'` clause below.
      verification_source: 'platform',
    })
    .where(
      and(
        eq(emailDestinations.verified_by_user_id, userId),
        sql`lower(${emailDestinations.verified_by_email_snapshot}) = ${lowered}`,
        eq(emailDestinations.verification_source, 'cf'),
      ),
    );
}

export async function getEmailDestinationsByProjectId(
  db: Db,
  projectId: string,
): Promise<Array<EmailDestination>> {
  return db
    .select()
    .from(emailDestinations)
    .where(eq(emailDestinations.project_id, projectId))
    .orderBy(asc(emailDestinations.created_at));
}

export async function getEmailDestinationByAddress(
  db: Db,
  projectId: string,
  address: string,
): Promise<EmailDestination | null> {
  const [row] = await db
    .select()
    .from(emailDestinations)
    .where(
      and(
        eq(emailDestinations.project_id, projectId),
        eq(emailDestinations.address, address.toLowerCase()),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Look up a single destination by its primary key. Used by the public
 * confirm endpoint to validate a token's `did` claim against the DB row.
 */
export async function getEmailDestinationById(
  db: Db,
  id: string,
): Promise<EmailDestination | null> {
  const [row] = await db
    .select()
    .from(emailDestinations)
    .where(eq(emailDestinations.id, id))
    .limit(1);
  return row ?? null;
}

export async function updateEmailDestinationStatus(
  db: Db,
  id: string,
  status: EmailDestination['status'],
  cfDestinationId?: string | null,
  /**
   * Audit timestamp from CF's `verified` field. When status flips to
   * 'verified' and no value is supplied, defaults to now().
   */
  verifiedAt?: string | null,
  /**
   * Optional override for the row's `verification_source`. Useful when
   * promoting a 'platform' pending row to verified after the recipient
   * clicks the platform-side confirmation link — leave undefined to
   * preserve the existing source value rather than overwriting it.
   */
  verificationSource?: EmailDestination['verification_source'],
): Promise<boolean> {
  const patch: Pick<EmailDestination, 'status'> &
    Partial<Pick<EmailDestination, 'verified_at' | 'cf_destination_id' | 'verification_source'>> = {
    status,
  };
  if (status === 'verified') {
    patch.verified_at = verifiedAt ?? new Date().toISOString();
  }
  if (cfDestinationId !== undefined) {
    patch.cf_destination_id = cfDestinationId;
  }
  if (verificationSource !== undefined) {
    patch.verification_source = verificationSource;
  }
  const [existing] = await db
    .select({ project_id: emailDestinations.project_id })
    .from(emailDestinations)
    .where(eq(emailDestinations.id, id))
    .limit(1);
  if (!existing) {
    return false;
  }
  return db.transaction(async (tx) => {
    await lockEmailPolicy(tx);
    await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, existing.project_id))
      .for('update');
    if (cfDestinationId && (await isRetiredDestination(tx, cfDestinationId))) {
      return false;
    }
    const updated = await tx
      .update(emailDestinations)
      .set(patch)
      .where(
        and(eq(emailDestinations.id, id), eq(emailDestinations.project_id, existing.project_id)),
      )
      .returning({ id: emailDestinations.id });
    return updated.length > 0;
  });
}

async function queueDestinationCleanupTx(tx: Tx, cfDestinationId: string): Promise<void> {
  await tx
    .insert(emailDestinationCleanups)
    .values({ cf_destination_id: cfDestinationId })
    .onConflictDoNothing();
}

/** Revoke one project's consent and durably queue the last provider tag. */
export async function deleteEmailDestination(
  db: Db,
  id: string,
  actorUserId?: string,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    await lockEmailPolicy(tx);
    const [existing] = await tx
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.id, id))
      .for('update');
    if (!existing) {
      return null;
    }
    await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, existing.project_id))
      .for('update');
    await requireEmailDestinationSettingsAccess(tx, existing.project_id, actorUserId);
    await tx
      .delete(emailDestinations)
      .where(
        and(eq(emailDestinations.id, id), eq(emailDestinations.project_id, existing.project_id)),
      );
    if (!existing.cf_destination_id) {
      return null;
    }
    if ((await countDestinationReferences(tx, existing.cf_destination_id)) !== 0) {
      return null;
    }
    await queueDestinationCleanupTx(tx, existing.cf_destination_id);
    return existing.cf_destination_id;
  });
}

/** Revoke all project consent rows and queue provider tags with no live sibling. */
export async function deleteProjectEmailDestinations(
  db: Db,
  projectId: string,
): Promise<Array<string>> {
  return db.transaction(async (tx) => {
    await lockEmailPolicy(tx);
    await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('update');
    const rows = await tx
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.project_id, projectId))
      .for('update');
    await tx.delete(emailDestinations).where(eq(emailDestinations.project_id, projectId));
    const queued: Array<string> = [];
    for (const tag of new Set(rows.map((row) => row.cf_destination_id).filter(Boolean))) {
      if ((await countDestinationReferences(tx, tag!)) === 0) {
        await queueDestinationCleanupTx(tx, tag!);
        queued.push(tag!);
      }
    }
    return queued;
  });
}

/** Queue an allocated tag that never gained a SQL consent row. */
export async function queueUnreferencedEmailDestinationCleanup(
  db: Db,
  cfDestinationId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockEmailPolicy(tx);
    if ((await countDestinationReferences(tx, cfDestinationId)) !== 0) {
      return false;
    }
    await queueDestinationCleanupTx(tx, cfDestinationId);
    return true;
  });
}

/**
 * Promote a pending row to `verified` by INHERITING the project owner's
 * Cloudflare-side consent from a destination this row did not register.
 *
 * The listing refresh in `routes/email.ts` reaches for this when the row's
 * own CF destination is gone and the account now carries the same address
 * under a new tag that somebody else's registration verified. For the
 * owner's own address that is Option C (design doc 0078): the human who
 * clicked is the human who owns the project. The row adopts the live tag
 * and records whose consent it inherited, exactly as the create paths do
 * (`autoAddOwnerDestination`, the owner branch of the POST), so a later
 * owner-email change can revoke it through
 * `revokeOwnerVerifiedDestinationsForUserChange`.
 *
 * `verification_source` stays `'cf'`: the consent is still Cloudflare's
 * click, only attributed. Non-owner rows never take this path.
 *
 * Same gate as the owner-audited insert in `tryCreateEmailDestination`, for
 * the same reason: the listing decided "this is the owner's address" from an
 * unlocked read, and a login that rotates the address can commit between
 * that read and this write — its revoke skips a `pending` row, and no later
 * login looks again. So the promotion runs in one transaction behind
 * `SELECT … FOR SHARE` on the owner's `users` row (after `projects`, in the
 * lock order the build transactions use) and writes nothing when
 * `users.email` no longer equals the snapshot, or the row is no longer
 * `pending`. Returns whether the row was promoted.
 */
export async function promoteEmailDestinationWithOwnerAudit(
  db: Db,
  projectId: string,
  id: string,
  cfDestinationId: string,
  verifiedAt: string | null,
  ownerAudit: OwnerVerificationAudit,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockEmailPolicy(tx);
    const [project] = await tx
      .select({ ownerUserId: projects.user_id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('update')
      .limit(1);
    if (project?.ownerUserId !== ownerAudit.userId) {
      return false;
    }
    if (
      (await isRetiredDestination(tx, cfDestinationId)) ||
      !(await ownerEmailMatches(tx, ownerAudit))
    ) {
      return false;
    }
    const promoted = await tx
      .update(emailDestinations)
      .set({
        status: 'verified',
        cf_destination_id: cfDestinationId,
        verified_at: verifiedAt ?? new Date().toISOString(),
        verified_by_user_id: ownerAudit.userId,
        verified_by_email_snapshot: ownerAudit.emailSnapshot,
      })
      .where(and(eq(emailDestinations.id, id), eq(emailDestinations.status, 'pending')))
      .returning({ id: emailDestinations.id });
    return promoted.length > 0;
  });
}
