/**
 * `SecurityScanControl`: the scanner controller's RPC into the API (design doc 0095).
 * Only the installation's controller holds this binding; its `props` name the
 * installation, and scan id + attempt come from the controller, never the container.
 * Every call is fenced by `attempt` (spec §6.2, T10).
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { getPlatformCapabilities } from '../capabilities.ts';
import { createDb } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import {
  securityScannerIdentity,
  securityScannerTarget,
} from '../provisioning/security-scanner.ts';
import type { SecurityScannerIdentity } from '../provisioning/security-scanner.ts';
import type { ScanFence, ScanResultReport } from '../security-scanner-controller-runtime.ts';
import { checkScanFence } from './fence.ts';
import { reportSecurityScanToGitHub } from './github-check.ts';
import { ingestSecurityScanResult } from './ingest.ts';
import { prepareSecurityScanInput } from './input/prepare.ts';
import { handleSecurityModelRequest, securityModelProxyDeps } from './model-proxy.ts';
import { recheckPublicRequestForScan } from './public-gate-flow.ts';
import {
  deleteSecurityRuntimeCopyForScan,
  noteSecurityRuntimeCopyOutcome,
  prepareSecurityRuntimeCopy,
} from './runtime-copy.ts';
import type { SecurityCopyOutcome } from './runtime-copy.ts';

export { checkScanFence, judgeScanFence } from './fence.ts';

const UNAVAILABLE: ScanFence = { ok: false, reason: 'unavailable' };

function logFailure(what: string, scanId: string, attempt: number, error: unknown): void {
  console.error(`[security-scan] ${what}`, {
    scanId,
    attempt,
    error: error instanceof Error ? error.message : String(error),
  });
}

export class SecurityScanControl extends WorkerEntrypoint<
  ApiEnv['Bindings'],
  SecurityScannerIdentity
> {
  /** Keeps the Worker alive for best-effort work after the call returns. */
  private later(work: Promise<unknown>): void {
    try {
      this.ctx.waitUntil(work);
    } catch {
      // No execution context (a unit test): the work is already running.
      void work;
    }
  }

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
      typeof scanId === 'string' &&
      scanId.length > 0 &&
      scanId.length <= 64 &&
      typeof attempt === 'number' &&
      Number.isSafeInteger(attempt) &&
      attempt > 0
    );
  }

  async heartbeat(scanId: string, attempt: number): Promise<ScanFence> {
    if (!this.trusted(scanId, attempt)) {
      return UNAVAILABLE;
    }
    return checkScanFence(createDb(this.env.HYPERDRIVE.connectionString), scanId, attempt);
  }

  /** The scan input tar, or `null` (fenced off or missing: `input_unavailable`). */
  async input(scanId: string, attempt: number): Promise<ReadableStream<Uint8Array> | null> {
    if (!this.trusted(scanId, attempt)) {
      return null;
    }
    const db = createDb(this.env.HYPERDRIVE.connectionString);
    if (!(await checkScanFence(db, scanId, attempt)).ok) {
      return null;
    }
    try {
      const input = await prepareSecurityScanInput(this.env, db, scanId, attempt);
      if (input === null) {
        // A scan with nothing to send is stored here (`no changes`, backlog only).
        await recheckPublicRequestForScan(this.env, db, scanId);
        this.later(reportSecurityScanToGitHub(this.env, db, scanId));
      }
      return input;
    } catch (error) {
      logFailure('scan input could not be built', scanId, attempt, error);
      return null;
    }
  }

  /** The attempt's runtime copy (M30, spec §8.6); without one the scan is static-only. */
  async copy(scanId: string, attempt: number): Promise<SecurityCopyOutcome> {
    if (!this.trusted(scanId, attempt)) {
      return { ok: false, reason: 'fence' };
    }
    const db = createDb(this.env.HYPERDRIVE.connectionString);
    let outcome: SecurityCopyOutcome;
    try {
      outcome = await prepareSecurityRuntimeCopy(this.env, db, scanId, attempt);
    } catch (error) {
      logFailure('runtime copy could not be made', scanId, attempt, error);
      outcome = { ok: false, reason: 'create_failed' };
    }
    try {
      // A copy that was wanted and not made shows as a coverage note, not only in a log.
      await noteSecurityRuntimeCopyOutcome(db, scanId, attempt, outcome);
    } catch (error) {
      logFailure('runtime copy note could not be stored', scanId, attempt, error);
    }
    return outcome;
  }

  /** The model proxy: every model call of this scan attempt (spec §15.1). */
  async model(scanId: string, attempt: number, request: Request): Promise<Response> {
    if (!this.trusted(scanId, attempt)) {
      return new Response('forbidden', { status: 403 });
    }
    return handleSecurityModelRequest(securityModelProxyDeps(this.env), scanId, attempt, request);
  }

  /** Result ingest: `ok: true` once stored or requeued, so the container can go. */
  async result(
    scanId: string,
    attempt: number,
    report: ScanResultReport,
  ): Promise<{ ok: boolean }> {
    if (!this.trusted(scanId, attempt)) {
      return { ok: false };
    }
    try {
      const db = createDb(this.env.HYPERDRIVE.connectionString);
      const ingested = await ingestSecurityScanResult(this.env, db, scanId, attempt, {
        status: report?.status,
        findings: typeof report?.findings === 'string' ? report.findings : null,
      });
      if (ingested.ok) {
        // The attempt is over (stored or requeued): its copy goes now; the reaper retries.
        this.later(
          Promise.resolve()
            .then(() => deleteSecurityRuntimeCopyForScan(this.env, scanId, attempt))
            .catch((error: unknown) => {
              logFailure('runtime copy delete failed', scanId, attempt, error);
            }),
        );
      }
      if (ingested.ok && ingested.kind === 'stored') {
        // The public gate judges the stored result (a gate scan, or any scan of the live deployment).
        await recheckPublicRequestForScan(this.env, db, scanId);
        // Hosted only (M28): the `Void Security Audit` check, off the RPC path.
        this.later(reportSecurityScanToGitHub(this.env, db, scanId));
      }
      return { ok: ingested.ok };
    } catch (error) {
      logFailure('scan result could not be stored', scanId, attempt, error);
      return { ok: false };
    }
  }
}
