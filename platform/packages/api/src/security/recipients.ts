/**
 * Who gets a security email (spec §12). Worked out when the email is sent, not when the
 * row is queued, so an owner transfer or a role change between the two is respected.
 *
 *   findings   owner + project admins + the deploy author of each scanned deployment
 *   reopen/cap owner + project admins
 *   public     the requester (while they hold `settings`) + owner + project admins
 *   platform   installation admins (`users.role = 'admin'`) for the platform cap and bypasses
 *
 * A user needs an email and no suspension. One email per person, and the reason in its
 * footer is the strongest one: requester, then owner/admin, then author.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db.ts';
import { hasProjectCapability, projectRoleForUser } from '../project-access.ts';
import { deployments, projectMembers, projects, users } from '../schema.ts';
import type { SecurityEmailReason } from './notification-copy.ts';
import { securityScans } from './schema.ts';

export type SecurityRecipient = Readonly<{
  userId: string;
  email: string;
  reason: SecurityEmailReason;
}>;

type Candidate = Readonly<{ userId: string; reason: SecurityEmailReason }>;

function hasMailbox(email: string | null): email is string {
  return email !== null && email.trim().length > 0;
}

/** Users that can be mailed, by id. A missing, suspended or email-less user is absent. */
async function mailable(db: Db, ids: ReadonlyArray<string>): Promise<Map<string, string>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(inArray(users.id, [...ids]), isNull(users.suspended_reason)));
  const out = new Map<string, string>();
  for (const row of rows) {
    if (hasMailbox(row.email)) {
      out.set(row.id, row.email.trim());
    }
  }
  return out;
}

/** First candidate of a user wins (callers list the strongest reason first). */
async function finish(
  db: Db,
  candidates: ReadonlyArray<Candidate>,
): Promise<Array<SecurityRecipient>> {
  const first = new Map<string, Candidate>();
  for (const candidate of candidates) {
    if (!first.has(candidate.userId)) {
      first.set(candidate.userId, candidate);
    }
  }
  const emails = await mailable(db, [...first.keys()]);
  const seenEmails = new Set<string>();
  const out: Array<SecurityRecipient> = [];
  for (const candidate of first.values()) {
    const email = emails.get(candidate.userId);
    if (email === undefined || seenEmails.has(email.toLowerCase())) {
      continue;
    }
    seenEmails.add(email.toLowerCase());
    out.push({ userId: candidate.userId, email, reason: candidate.reason });
  }
  return out;
}

const OWNER_ADMIN: SecurityEmailReason = { kind: 'owner_admin' };

async function ownerAndAdmins(db: Db, projectId: string): Promise<Array<Candidate>> {
  const [project] = await db
    .select({ ownerId: projects.user_id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) {
    return [];
  }
  const admins = await db
    .select({ userId: projectMembers.user_id })
    .from(projectMembers)
    .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.role, 'admin')))
    .orderBy(projectMembers.user_id);
  return [
    { userId: project.ownerId, reason: OWNER_ADMIN },
    ...admins.map((admin) => ({ userId: admin.userId, reason: OWNER_ADMIN })),
  ];
}

/** Reopen and project-cap emails: owner + project admins (no author). */
export async function resolveProjectAdminRecipients(
  db: Db,
  projectId: string,
): Promise<Array<SecurityRecipient>> {
  return finish(db, await ownerAndAdmins(db, projectId));
}

/**
 * Findings email: owner + admins + the deploy authors of the scanned deployments, each
 * only while they still hold `deploy`. A deployment with no user adds nobody.
 */
export async function resolveProjectSecurityRecipients(
  db: Db,
  projectId: string,
  options: Readonly<{ scanIds: ReadonlyArray<string> }>,
): Promise<Array<SecurityRecipient>> {
  const candidates = await ownerAndAdmins(db, projectId);
  const authors = new Map<string, Array<string>>();
  if (options.scanIds.length > 0) {
    const rows = await db
      .select({ deploymentId: deployments.id, authorId: deployments.initiated_by_user_id })
      .from(securityScans)
      .innerJoin(
        deployments,
        and(
          eq(deployments.id, securityScans.deployment_id),
          eq(deployments.project_id, securityScans.project_id),
        ),
      )
      .where(
        and(
          eq(securityScans.project_id, projectId),
          inArray(securityScans.id, [...options.scanIds]),
        ),
      )
      .orderBy(deployments.created_at, deployments.id);
    for (const row of rows) {
      if (row.authorId === null) {
        continue;
      }
      const list = authors.get(row.authorId) ?? [];
      if (!list.includes(row.deploymentId)) {
        list.push(row.deploymentId);
      }
      authors.set(row.authorId, list);
    }
  }
  for (const [userId, deploymentIds] of authors) {
    const role = await projectRoleForUser(db, projectId, userId);
    if (role !== null && hasProjectCapability(role, 'deploy')) {
      candidates.push({ userId, reason: { kind: 'author', deploymentIds } });
    }
  }
  return finish(db, candidates);
}

/** Public request emails: the requester while they hold `settings`, then owner + admins. */
export async function resolvePublicRequestRecipients(
  db: Db,
  projectId: string,
  requesterUserId: string | null,
): Promise<Array<SecurityRecipient>> {
  const candidates: Array<Candidate> = [];
  if (requesterUserId !== null) {
    const role = await projectRoleForUser(db, projectId, requesterUserId);
    if (role !== null && hasProjectCapability(role, 'settings')) {
      candidates.push({ userId: requesterUserId, reason: { kind: 'requester' } });
    }
  }
  candidates.push(...(await ownerAndAdmins(db, projectId)));
  return finish(db, candidates);
}

/** Platform cap and bypass emails: every installation admin. */
export async function resolveInstallationAdminRecipients(
  db: Db,
): Promise<Array<SecurityRecipient>> {
  const admins = await db
    .select({ userId: users.id })
    .from(users)
    .where(eq(users.role, 'admin'))
    .orderBy(users.id);
  return finish(
    db,
    admins.map((admin) => ({
      userId: admin.userId,
      reason: { kind: 'installation_admin' as const },
    })),
  );
}
