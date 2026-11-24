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
 * model proxy (`model-proxy.ts`), `input` builds the scan input (`input/prepare.ts`),
 * `copy` makes the scan's runtime copy (`runtime-copy.ts`, M30), `result` stores the
 * outcome and findings (`ingest.ts`) and deletes the copy.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { getPlatformCapabilities } from '../capabilities.ts';
import { createDb } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import {
  securityScannerIdentity,
  securityScannerTarget,
  type SecurityScannerIdentity,
} from '../provisioning/security-scanner.ts';
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
  type SecurityCopyOutcome,
} from './runtime-copy.ts';

export { checkScanFence, judgeScanFence } from './fence.ts';

const UNAVAILABLE: ScanFence = { ok: false, reason: 'unavailable' };

function isScanId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

function isAttempt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
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

  /**
   * The scan input tar (`input/prepare.ts`): `task.json`, `input/…` and `memory/…`.
   * `null` when the attempt is fenced off or its input is missing; the controller then
   * reports `input_unavailable` and stops.
   */
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
      console.error('[security-scan] scan input could not be built', {
        scanId,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * The runtime copy of this attempt (M30, spec §8.6): the deployed bundle with empty
   * stores, fake secrets and stubs, reachable only from this scan's container. The
   * controller asks once the runner is running; a copy that is not made leaves the scan
   * static-only.
   */
  async copy(scanId: string, attempt: number): Promise<SecurityCopyOutcome> {
    if (!this.trusted(scanId, attempt)) {
      return { ok: false, reason: 'fence' };
    }
    const db = createDb(this.env.HYPERDRIVE.connectionString);
    let outcome: SecurityCopyOutcome;
    try {
      outcome = await prepareSecurityRuntimeCopy(this.env, db, scanId, attempt);
    } catch (error) {
      console.error('[security-scan] runtime copy could not be made', {
        scanId,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      outcome = { ok: false, reason: 'create_failed' };
    }
    try {
      // A copy that was wanted and not made shows as a coverage note, not only in a log.
      await noteSecurityRuntimeCopyOutcome(db, scanId, attempt, outcome);
    } catch (error) {
      console.error('[security-scan] runtime copy note could not be stored', {
        scanId,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
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

  /**
   * Result ingest (`ingest.ts`). `ok: true` once the result is taken (stored, or the
   * attempt requeued for its retry), so the controller destroys the container; `false`
   * for a fenced-off attempt or a store that failed (the controller keeps polling until
   * the hard cap, and the reaper ends a scan nobody stored).
   */
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
              console.error('[security-scan] runtime copy delete failed', {
                scanId,
                attempt,
                error: error instanceof Error ? error.message : String(error),
              });
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
      console.error('[security-scan] scan result could not be stored', {
        scanId,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false };
    }
  }
}
