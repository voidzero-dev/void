import type { ApiEnv } from './env.ts';

export type CronSyncState = Readonly<{
  workerName: string;
  schedules: ReadonlyArray<{ name: string; cron: string }>;
  proxyToken?: string;
}>;

/**
 * Retry an async DO RPC a small number of times before giving up. Same-account
 * DO calls are local in-isolate and almost always succeed, but they can fail
 * during DO eviction, storage hiccups, or worker-process recycling. Without a
 * retry, a single transient failure here would leave the CronScheduler DO out
 * of sync until the next user-triggered deploy — for sync, the DO points at a
 * stale workerName; for clear after a worker-deletion path, the DO keeps
 * firing until the cron-fires queue ack-drops as `Worker not found`. Caller
 * still catches+logs the final failure as a safety net.
 */
async function callWithRetry(
  label: string,
  projectId: string,
  fn: () => Promise<Response>,
): Promise<Response> {
  const delaysMs = [0, 100, 400];
  let lastErr: unknown;
  for (const delay of delaysMs) {
    if (delay > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, delay);
      });
    }
    try {
      const response = await fn();
      if (!response.ok) {
        throw new Error(`CronScheduler ${label} returned HTTP ${response.status}`);
      }
      return response;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `CronScheduler ${label} failed for ${projectId} after ${delaysMs.length} attempts`,
    { cause: lastErr },
  );
}

/**
 * Resync the per-project CronScheduler DO with the current live deployment's
 * cron schedules. Failures propagate after retry so deployment and rollback
 * cutovers cannot report success with stale scheduler state.
 */
export async function syncCronScheduler(
  env: Pick<ApiEnv['Bindings'], 'CRON_SCHEDULER'>,
  projectId: string,
  state: CronSyncState,
): Promise<void> {
  await callWithRetry('sync', projectId, () =>
    env.CRON_SCHEDULER.get(env.CRON_SCHEDULER.idFromName(projectId)).fetch(
      new Request('https://do/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      }),
    ),
  );
}

/**
 * Clear the per-project CronScheduler DO. Idempotent (handleClear is
 * deleteAll + deleteAlarm, both no-ops on empty DOs). Used from every code
 * path that deletes a user worker so stale alarms do not churn.
 */
export async function clearCronScheduler(
  env: Pick<ApiEnv['Bindings'], 'CRON_SCHEDULER'>,
  projectId: string,
): Promise<void> {
  await callWithRetry('clear', projectId, () =>
    env.CRON_SCHEDULER.get(env.CRON_SCHEDULER.idFromName(projectId)).fetch(
      new Request('https://do/clear', { method: 'POST' }),
    ),
  );
}

/** Read the exact state required to compensate a failed cutover. */
export async function snapshotCronScheduler(
  env: Pick<ApiEnv['Bindings'], 'CRON_SCHEDULER'>,
  projectId: string,
): Promise<CronSyncState | null> {
  const response = await callWithRetry('snapshot', projectId, () =>
    env.CRON_SCHEDULER.get(env.CRON_SCHEDULER.idFromName(projectId)).fetch(
      new Request('https://do/snapshot'),
    ),
  );
  const body = await response.json<{ state: CronSyncState | null }>();
  return body.state;
}

/** Restore a previously captured scheduler state after a failed cutover. */
export async function restoreCronScheduler(
  env: Pick<ApiEnv['Bindings'], 'CRON_SCHEDULER'>,
  projectId: string,
  state: CronSyncState | null,
): Promise<void> {
  if (state) {
    await syncCronScheduler(env, projectId, state);
  } else {
    await clearCronScheduler(env, projectId);
  }
}
