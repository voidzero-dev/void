/**
 * `SecurityScanControl`: the API side of the scanner controller (design doc 0095).
 * RPC only, no HTTP route. Only the installation's scanner controller receives this
 * service binding; its immutable `props` name the installation. Per-scan identity
 * (scan id + attempt) comes from the controller's outbound handler props, never from
 * the container.
 *
 * Every call is fenced by `attempt`: a write or a call from an older attempt, or after
 * the lease ran out, is refused (spec §6.2, T10). `heartbeat` is the fence check the
 * controller makes before it starts a container and on every poll. `model` is the
 * model proxy (`model-proxy.ts`); `input` (M10) and `result` (M12) refuse until
 * their milestones land.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { getPlatformCapabilities } from '../capabilities.ts';
import { createDb, type DbOrTx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import {
  securityScannerIdentity,
  securityScannerTarget,
  type SecurityScannerIdentity,
} from '../provisioning/security-scanner.ts';
import { projects } from '../schema.ts';
import type { ScanFence, ScanResultReport } from '../security-scanner-controller-runtime.ts';
import { handleSecurityModelRequest, securityModelProxyDeps } from './model-proxy.ts';
import { securityScans } from './schema.ts';

const UNAVAILABLE: ScanFence = { ok: false, reason: 'unavailable' };

function isScanId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

function isAttempt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

type FenceRow = {
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

export class SecurityScanControl extends WorkerEntrypoint<
  ApiEnv['Bindings'],
  SecurityScannerIdentity
> {
  /** The binding props must name this installation's scanner. */
  private trusted(scanId: unknown, attempt: unknown): scanId is string {
    if (!getPlatformCapabilities(this.env).securityAudits) {
      return false;
    }
    const expected = securityScannerIdentity(securityScannerTarget(this.env).installationKey);
    const props = this.ctx.props;
    return (
      props?.protocol === expected.protocol &&
      props.installation === expected.installation &&
      isScanId(scanId) &&
      isAttempt(attempt)
    );
  }

  async heartbeat(scanId: string, attempt: number): Promise<ScanFence> {
    if (!this.trusted(scanId, attempt)) {
      return UNAVAILABLE;
    }
    return checkScanFence(createDb(this.env.HYPERDRIVE.connectionString), scanId, attempt);
  }

  /** The scan input tar (M10). Until then no scan has an input. */
  async input(scanId: string, attempt: number): Promise<ReadableStream<Uint8Array> | null> {
    if (!this.trusted(scanId, attempt)) {
      return null;
    }
    return null;
  }

  /** The model proxy: every model call of this scan attempt (spec §15.1). */
  async model(scanId: string, attempt: number, request: Request): Promise<Response> {
    if (!this.trusted(scanId, attempt)) {
      return new Response('forbidden', { status: 403 });
    }
    return handleSecurityModelRequest(securityModelProxyDeps(this.env), scanId, attempt, request);
  }

  /** Result ingest (M12). Until then a result is refused and the reaper ends the scan. */
  async result(
    scanId: string,
    attempt: number,
    _report: ScanResultReport,
  ): Promise<{ ok: boolean }> {
    if (!this.trusted(scanId, attempt)) {
      return { ok: false };
    }
    return { ok: false };
  }
}
