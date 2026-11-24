import { count, desc, eq } from 'drizzle-orm';
import { getPlatformEventsByBatchId, updatePlatformEventStatus } from '../db.ts';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { generateId } from '../id.ts';
import {
  createWorkerDeployment,
  listWorkerDeployments,
  listWorkerVersions,
} from '../provisioning/workers-versions.ts';
import { platformEvents } from '../schema.ts';
import type { PlatformEvent, User } from '../types.ts';
import { OperatorError } from './common.ts';
import { PLATFORM_WORKERS, getScriptName, getWorkerByName } from './platform-workers.ts';
import type { PlatformEnv } from './platform-workers.ts';

export function requireHostedPlatform(env: ApiEnv['Bindings']) {
  if (env.PLATFORM_INSTALLATION_ID) {
    throw new OperatorError(
      501,
      'Manage this self-hosted Void platform with `void platform upgrade`.',
      'capability_unavailable',
      { capability: 'hosted-platform-operations' },
    );
  }
}

export function workerEnvironment(env: ApiEnv['Bindings'], raw?: unknown): PlatformEnv {
  requireHostedPlatform(env);
  const value = raw ?? env.PLATFORM_ENV ?? 'production';
  if (value !== 'production' && value !== 'staging') {
    throw new OperatorError(400, 'environment must be production or staging.');
  }
  return value;
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function workerDetail(
  env: ApiEnv['Bindings'],
  environment: PlatformEnv,
  name: string,
) {
  requireHostedPlatform(env);
  const worker = getWorkerByName(name);
  if (!worker) {
    throw new OperatorError(404, 'Worker not found.');
  }
  const scriptName = getScriptName(worker, environment);
  const results = await Promise.allSettled([
    listWorkerVersions(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, scriptName),
    listWorkerDeployments(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, scriptName),
  ]);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [toErrorMessage(result.reason)] : [],
  );
  return {
    ok: failures.length === 0,
    partial: failures.length > 0 && failures.length < results.length,
    worker,
    scriptName,
    environment,
    versions: results[0].status === 'fulfilled' ? results[0].value.items : [],
    deployment: results[1].status === 'fulfilled' ? results[1].value.deployments[0] : undefined,
    error: failures.join('; ') || undefined,
  };
}

export async function workerList(env: ApiEnv['Bindings'], environment: PlatformEnv) {
  requireHostedPlatform(env);
  const results = await Promise.allSettled(
    PLATFORM_WORKERS.map(async (worker) => {
      const scriptName = getScriptName(worker, environment);
      const { deployments } = await listWorkerDeployments(
        env.CF_ACCOUNT_ID,
        env.CF_API_TOKEN,
        scriptName,
      );
      const deployment = deployments[0];
      const current = deployment?.versions.find(
        (version) => version.percentage === 100,
      )?.version_id;
      const previousVersionId = deployments
        .find((candidate) =>
          candidate.versions.some(
            (version) => version.percentage === 100 && version.version_id !== current,
          ),
        )
        ?.versions.find((version) => version.percentage === 100)?.version_id;
      return { worker, scriptName, deployment, previousVersionId };
    }),
  );
  const workers = results.map((result, index) =>
    result.status === 'fulfilled'
      ? result.value
      : {
          worker: PLATFORM_WORKERS[index],
          scriptName: getScriptName(PLATFORM_WORKERS[index], environment),
          error: toErrorMessage(result.reason),
        },
  );
  const failureCount = results.filter((result) => result.status === 'rejected').length;
  return {
    ok: failureCount === 0,
    partial: failureCount > 0 && failureCount < results.length,
    workers,
    environment,
  };
}

export type RollbackTarget = {
  worker: (typeof PLATFORM_WORKERS)[number];
  scriptName: string;
  versionId: string;
};

export async function prepareWorkerRollback(
  env: ApiEnv['Bindings'],
  environment: PlatformEnv,
  name: string,
  versionId: string,
): Promise<RollbackTarget> {
  requireHostedPlatform(env);
  const worker = getWorkerByName(name);
  if (!worker) {
    throw new OperatorError(404, 'Worker not found.');
  }
  if (!versionId || versionId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(versionId)) {
    throw new OperatorError(400, 'Invalid versionId.');
  }
  const scriptName = getScriptName(worker, environment);
  const { items } = await listWorkerVersions(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, scriptName);
  if (!items.some((version) => version.id === versionId)) {
    throw new OperatorError(404, `Version ${versionId} was not found for ${scriptName}.`);
  }
  return { worker, scriptName, versionId };
}

export async function prepareAllWorkerRollbacks(
  env: ApiEnv['Bindings'],
  environment: PlatformEnv,
  input?: unknown,
): Promise<ReadonlyArray<RollbackTarget>> {
  requireHostedPlatform(env);
  let versions: Record<string, unknown>;
  if (input === undefined) {
    const inventory = await workerList(env, environment);
    if (!inventory.ok) {
      throw new OperatorError(
        502,
        'Could not inspect every hosted worker. Retry the preview after Cloudflare recovers.',
        'worker_read_failed',
        { partial: inventory.partial, workers: inventory.workers },
      );
    }
    const { workers } = inventory;
    versions = Object.fromEntries(
      workers.map((entry) => [
        entry.worker.name,
        'previousVersionId' in entry ? entry.previousVersionId : undefined,
      ]),
    );
  } else {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new OperatorError(400, 'versions must map every worker name to a version ID.');
    }
    versions = input as Record<string, unknown>;
    if (Object.keys(versions).some((name) => !getWorkerByName(name))) {
      throw new OperatorError(400, 'versions contains an unknown worker.');
    }
  }
  const order = [...PLATFORM_WORKERS].sort((a, b) => b.deployOrder - a.deployOrder);
  if (order.some((worker) => typeof versions[worker.name] !== 'string' || !versions[worker.name])) {
    throw new OperatorError(
      409,
      'Every worker needs a rollback target. Inspect worker history and specify all version IDs.',
    );
  }
  return Promise.all(
    order.map((worker) =>
      prepareWorkerRollback(env, environment, worker.name, versions[worker.name] as string),
    ),
  );
}

/** Persist intent before external mutations; stop on first failure and report exact per-worker outcomes. */
export async function executeWorkerRollbacks(
  db: Db,
  env: ApiEnv['Bindings'],
  user: User,
  environment: PlatformEnv,
  targets: ReadonlyArray<RollbackTarget>,
  batch = false,
) {
  requireHostedPlatform(env);
  const batchId = batch ? generateId('batch') : null;
  const events = await db
    .insert(platformEvents)
    .values(
      targets.map((target) => ({
        id: generateId('pevt'),
        batch_id: batchId,
        action: batch ? ('rollback_all' as const) : ('rollback' as const),
        worker_name: target.worker.name,
        environment,
        version_id: target.versionId,
        script_name: target.scriptName,
        status: 'pending' as const,
        error_message: null,
        admin_user_id: user.id,
        admin_login: user.login,
      })),
    )
    .returning();
  const eventByWorker = new Map(events.map((event) => [event.worker_name, event]));
  const outcomes: Array<PlatformEvent & { auditError?: string }> = [];
  let stopped = false;
  for (const target of targets) {
    const event = eventByWorker.get(target.worker.name)!;
    let status: PlatformEvent['status'] = stopped ? 'skipped' : 'success';
    let error: string | undefined;
    if (!stopped) {
      try {
        await createWorkerDeployment(
          env.CF_ACCOUNT_ID,
          env.CF_API_TOKEN,
          target.scriptName,
          target.versionId,
        );
      } catch (cause) {
        status = 'failed';
        error = toErrorMessage(cause);
        stopped = true;
      }
    }
    let auditError: string | undefined;
    try {
      await updatePlatformEventStatus(db, event.id, status, error);
    } catch (cause) {
      auditError = toErrorMessage(cause);
      stopped = true;
    }
    outcomes.push({
      ...event,
      status,
      error_message: error ?? null,
      ...(auditError ? { auditError } : {}),
    });
  }
  const ok = outcomes.every((event) => event.status === 'success' && !event.auditError);
  return {
    ok,
    partial: !ok && outcomes.some((event) => event.status === 'success'),
    batchId,
    environment,
    events: outcomes,
  };
}

export async function workerEvents(
  db: Db,
  env: ApiEnv['Bindings'],
  environment: PlatformEnv,
  options: { page: number; limit: number; offset: number },
) {
  requireHostedPlatform(env);
  const where = eq(platformEvents.environment, environment);
  const [events, totals] = await Promise.all([
    db
      .select()
      .from(platformEvents)
      .where(where)
      .orderBy(desc(platformEvents.created_at), desc(platformEvents.id))
      .limit(options.limit)
      .offset(options.offset),
    db.select({ total: count() }).from(platformEvents).where(where),
  ]);
  return {
    events,
    environment,
    page: options.page,
    limit: options.limit,
    total: totals[0]?.total ?? 0,
  };
}

export async function workerBatch(
  db: Db,
  env: ApiEnv['Bindings'],
  id: string,
  environment?: PlatformEnv,
) {
  requireHostedPlatform(env);
  const events = await getPlatformEventsByBatchId(db, id);
  if (!events.length || (environment && events[0].environment !== environment)) {
    throw new OperatorError(404, 'Batch not found.');
  }
  return { batchId: id, environment: events[0].environment, events };
}
