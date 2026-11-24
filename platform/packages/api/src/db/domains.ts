import { and, asc, eq, lt, gte, inArray, or } from 'drizzle-orm';
import { generateId } from '../id.ts';
import type { DomainVerificationData } from '../schema.ts';
import { domains } from '../schema.ts';
import type { Domain } from '../types.ts';
import type { Db } from './client.ts';

// --- Domains ---

export async function createDomain(
  db: Db,
  projectId: string,
  hostname: string,
  cfHostnameId: string,
  verificationData?: DomainVerificationData | null,
): Promise<Domain> {
  const id = generateId('dom');
  const [row] = await db
    .insert(domains)
    .values({
      id,
      project_id: projectId,
      hostname,
      cf_hostname_id: cfHostnameId,
      verification_data: verificationData ?? null,
    })
    .returning();
  return row;
}

export async function getDomainsByProjectId(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<Domain>> {
  return db
    .select()
    .from(domains)
    .where(eq(domains.project_id, projectId))
    .orderBy(asc(domains.created_at));
}

export async function getDomainsByProjectIds(
  db: Db,
  projectIds: ReadonlyArray<string>,
): Promise<Map<string, ReadonlyArray<Domain>>> {
  const allDomains = await db
    .select()
    .from(domains)
    .where(inArray(domains.project_id, projectIds))
    .orderBy(asc(domains.created_at));

  const map = new Map<string, Array<Domain>>();
  for (const d of allDomains) {
    const list = map.get(d.project_id) ?? [];
    list.push(d);
    map.set(d.project_id, list);
  }
  return map;
}

export async function getDomainByHostname(db: Db, hostname: string): Promise<Domain | null> {
  const [row] = await db.select().from(domains).where(eq(domains.hostname, hostname)).limit(1);
  return row ?? null;
}

export async function getDomainByHostnameOrCfHostnameId(
  db: Db,
  hostname: string,
  cfHostnameId: string,
): Promise<Domain | null> {
  const [row] = await db
    .select()
    .from(domains)
    .where(or(eq(domains.hostname, hostname), eq(domains.cf_hostname_id, cfHostnameId)))
    .limit(1);
  return row ?? null;
}

export async function getDomain(db: Db, id: string): Promise<Domain | null> {
  const [row] = await db.select().from(domains).where(eq(domains.id, id)).limit(1);
  return row ?? null;
}

// Stale custom hostnames that never verified — for the cleanup janitor. Only
// `pending` rows are eligible; `created_at` is a string-mode timestamp so the
// cutoff is compared as an ISO string. Capped at `limit` and ordered
// oldest-first (most overdue cleaned first) so a large stale backlog cannot
// starve later hourly maintenance.
export async function getPendingDomainsOlderThan(
  db: Db,
  isoCutoff: string,
  limit: number,
): Promise<ReadonlyArray<Domain>> {
  return db
    .select()
    .from(domains)
    .where(and(eq(domains.status, 'pending'), lt(domains.created_at, isoCutoff)))
    .orderBy(asc(domains.created_at))
    .limit(limit);
}

// All pending custom-hostname rows (cron hourly reconciliation tier). Capped
// at `limit` and ordered oldest-first so domains nearest the 7-day cleanup are
// reconciled before the per-run cap truncates the batch.
export async function getPendingDomains(db: Db, limit: number): Promise<ReadonlyArray<Domain>> {
  return db
    .select()
    .from(domains)
    .where(eq(domains.status, 'pending'))
    .orderBy(asc(domains.created_at))
    .limit(limit);
}

// Recently-created pending rows (cron fast reconciliation tier).
// `created_at` is a string-mode timestamp, compared as an ISO string. Capped at
// `limit` and ordered oldest-first so the per-run cap truncates the newest
// (least urgent) domains rather than starving older ones.
export async function getPendingDomainsNewerThan(
  db: Db,
  isoCutoff: string,
  limit: number,
): Promise<ReadonlyArray<Domain>> {
  return db
    .select()
    .from(domains)
    .where(and(eq(domains.status, 'pending'), gte(domains.created_at, isoCutoff)))
    .orderBy(asc(domains.created_at))
    .limit(limit);
}

export async function updateDomainStatus(
  db: Db,
  id: string,
  status: Domain['status'],
): Promise<void> {
  await db.update(domains).set({ status }).where(eq(domains.id, id));
}

export async function updateDomainVerificationData(
  db: Db,
  id: string,
  data: DomainVerificationData | null,
): Promise<void> {
  await db.update(domains).set({ verification_data: data }).where(eq(domains.id, id));
}

export async function deleteDomain(db: Db, id: string): Promise<void> {
  await db.delete(domains).where(eq(domains.id, id));
}
