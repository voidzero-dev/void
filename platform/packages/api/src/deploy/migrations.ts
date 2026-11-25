import type { DeployLogger } from '../observability/logger.ts';

/**
 * Detect the known CF WfP bug where APIs return plain text about asset state
 * instead of JSON. CF returns different messages depending on propagation state
 * (e.g. "Assets have already been uploaded", "Assets have not yet been deployed").
 * Valid JSON always starts with `{` or `[`, so `startsWith` avoids false positives.
 */
export function isCfAssetPlainText(text: string): boolean {
  return text.trimStart().startsWith('Assets have');
}

export type UserWorkerMigrationResult = Readonly<{
  ok: boolean;
  protocolVersion?: 2;
  attemptId?: string;
  migrations: ReadonlyArray<{
    name: string;
    applied: boolean;
    durationMs: number;
    error?: string;
    status?: 'applied' | 'skipped' | 'failed';
    stability?: 'stable' | 'legacy';
  }>;
  confirmedApplied?: ReadonlyArray<string>;
  confirmedSkipped?: ReadonlyArray<string>;
  stability?: 'stable' | 'legacy';
  warnings?: ReadonlyArray<string>;
  error?: string;
}>;

export function normalizeUserWorkerMigrationResult(
  value: unknown,
  bodyPreview: string,
): UserWorkerMigrationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      migrations: [],
      error: `migration endpoint returned invalid response: ${bodyPreview}`,
    };
  }

  const data = value as Record<string, unknown>;
  if (Array.isArray(data.migrations)) {
    return data as UserWorkerMigrationResult;
  }

  return {
    ok: false,
    migrations: [],
    error: `migration endpoint returned invalid response: missing migrations array (${bodyPreview})`,
  };
}

type WorkerMigrationCapabilities = Readonly<{
  protocolVersion: 2;
  endpoints: {
    app: string;
    auth?: string;
    reconcile: string;
  };
  dialect: 'sqlite' | 'postgresql' | 'mysql';
  classifierVersion: number;
  migrationListHash: string;
  destructiveValidation: 'passed';
}>;

export function formatMigrationFailure(result: UserWorkerMigrationResult): string {
  const failedMigration = result.migrations.find((migration) => migration.error);
  if (failedMigration?.error) {
    const detailed = `migration ${failedMigration.name} failed: ${failedMigration.error}`;
    return result.error?.includes(failedMigration.error) ? result.error : detailed;
  }
  return result.error ?? 'unknown error';
}

type CapabilityProbeResult =
  | { ok: true; caps: WorkerMigrationCapabilities }
  | { ok: false; reason: string };

export async function probeWorkerMigrationCapabilities(
  userWorker: Fetcher,
  token: string,
  logger: DeployLogger,
): Promise<CapabilityProbeResult> {
  try {
    const response = await userWorker.fetch(
      new Request('https://internal/__void/migrate/capabilities', {
        headers: { 'x-void-internal': token },
        signal: AbortSignal.timeout(10_000),
      }),
    );
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        reason: `worker capabilities probe HTTP ${response.status}: ${text.slice(0, 200)}`,
      };
    }
    if (isCfAssetPlainText(text)) {
      return {
        ok: false,
        reason: 'worker not serving its own code yet (Cloudflare asset stub)',
      };
    }
    let data: WorkerMigrationCapabilities;
    try {
      data = JSON.parse(text) as WorkerMigrationCapabilities;
    } catch {
      return {
        ok: false,
        reason: `worker capabilities probe returned non-JSON: ${text.slice(0, 200)}`,
      };
    }
    if (
      data?.protocolVersion !== 2 ||
      (data?.dialect !== 'sqlite' && data?.dialect !== 'postgresql' && data?.dialect !== 'mysql') ||
      typeof data.classifierVersion !== 'number' ||
      typeof data.migrationListHash !== 'string' ||
      data.destructiveValidation !== 'passed'
    ) {
      return {
        ok: false,
        reason: `worker capabilities probe shape invalid: ${text.slice(0, 200)}`,
      };
    }
    return { ok: true, caps: data };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn('migrate', 'capability_probe_failed', {
      err: errMsg,
    });
    return {
      ok: false,
      reason: `worker capabilities probe request failed: ${errMsg}`,
    };
  }
}

export async function dispatchStableAppMigration(
  userWorker: Fetcher,
  token: string,
  attemptId: string,
  deploymentId: string,
  logger: DeployLogger,
): Promise<UserWorkerMigrationResult> {
  const request = new Request('https://internal/__void/migrate/app', {
    body: JSON.stringify({ attemptId, deploymentId }),
    headers: { 'content-type': 'application/json', 'x-void-internal': token },
    method: 'POST',
    signal: AbortSignal.timeout(300_000),
  });
  try {
    const response = await userWorker.fetch(request);
    const text = await response.text();
    if (isCfAssetPlainText(text)) {
      // oxlint-disable-next-line typescript/return-await -- A failed status reconciliation must propagate without invoking the same probe again.
      return reconcileStableAppMigration(userWorker, token, attemptId);
    }
    try {
      return normalizeUserWorkerMigrationResult(JSON.parse(text), text.slice(0, 500));
    } catch {
      // oxlint-disable-next-line typescript/return-await -- A failed status reconciliation must propagate without invoking the same probe again.
      return reconcileStableAppMigration(userWorker, token, attemptId);
    }
  } catch (err) {
    logger.warn('migrate', 'app_attempt_unknown', {
      attemptId,
      err: err instanceof Error ? err.message : String(err),
    });
    return reconcileStableAppMigration(userWorker, token, attemptId);
  }
}

async function reconcileStableAppMigration(
  userWorker: Fetcher,
  token: string,
  attemptId: string,
): Promise<UserWorkerMigrationResult> {
  const response = await userWorker.fetch(
    new Request(`https://internal/__void/migrate/app/attempt/${encodeURIComponent(attemptId)}`, {
      headers: { 'x-void-internal': token },
      signal: AbortSignal.timeout(30_000),
    }),
  );
  const text = await response.text();
  try {
    return normalizeUserWorkerMigrationResult(JSON.parse(text), text.slice(0, 500));
  } catch {
    return {
      ok: false,
      protocolVersion: 2,
      attemptId,
      migrations: [],
      error: `migration outcome unknown and reconciliation returned ${response.status}: ${text.slice(0, 200)}`,
    };
  }
}

export async function dispatchStableAuthMigration(
  userWorker: Fetcher,
  token: string,
): Promise<void> {
  const response = await userWorker.fetch(
    new Request('https://internal/__void/migrate/auth', {
      headers: { 'x-void-internal': token },
      method: 'POST',
      signal: AbortSignal.timeout(300_000),
    }),
  );
  const text = await response.text();
  let data: { ok?: boolean; error?: string };
  try {
    data = JSON.parse(text) as { ok?: boolean; error?: string };
  } catch {
    throw new Error(`auth migration failed (${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok || data.ok !== true) {
    throw new Error(`auth migration failed: ${data.error ?? response.status}`);
  }
}

// Migration dispatch: propagation lag is handled by the readiness probe,
// so this only retries genuine transient failures (e.g. network blips).
export const CF_MIGRATION_RETRY = { maxRetries: 2, delayMs: 1000 };
