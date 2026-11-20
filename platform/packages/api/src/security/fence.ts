/**
 * The attempt fence (spec §6.2, T10): only the current attempt of a running scan,
 * inside its lease, of a project not being deleted, may write. `SecurityScanControl`
 * checks it on every call and result ingest checks it again under the row lock.
 */
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db.ts';
import { projects } from '../schema.ts';
import type { ScanFence } from '../security-scanner-controller-runtime.ts';
import { securityScans } from './schema.ts';

export type FenceRow = {
  status: string;
  attempt: number;
  leaseUntil: string | null;
  projectStatus: string;
};

/** The fence rule, apart from the database read. */
export function judgeScanFence(row: FenceRow | undefined, attempt: number, now: number): ScanFence {
  if (!row || row.projectStatus === 'deleting') {
    return { ok: false, reason: 'canceled' };
  }
  if (row.attempt !== attempt) {
    return { ok: false, reason: 'stale' };
  }
  if (row.status !== 'running') {
    return { ok: false, reason: 'canceled' };
  }
  if (!row.leaseUntil || Date.parse(row.leaseUntil) <= now) {
    // The reaper times the scan out; this attempt must stop writing.
    return { ok: false, reason: 'stale' };
  }
  return { ok: true, leaseUntil: row.leaseUntil };
}

export async function checkScanFence(
  db: DbOrTx,
  scanId: string,
  attempt: number,
  now = Date.now(),
): Promise<ScanFence> {
  const [row] = await db
    .select({
      status: securityScans.status,
      attempt: securityScans.attempt,
      leaseUntil: securityScans.lease_until,
      projectStatus: projects.status,
    })
    .from(securityScans)
    .innerJoin(projects, eq(projects.id, securityScans.project_id))
    .where(eq(securityScans.id, scanId))
    .limit(1);
  return judgeScanFence(row, attempt, now);
}
