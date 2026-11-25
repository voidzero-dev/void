import { PLATFORM_DISABLED_KEY, PLATFORM_DISABLED_VALUE } from '@void/platform';
import { processCronFiresBatch } from './cron-fires-queue.ts';
import type { CronFireMessage } from './cron-fires-queue.ts';
import { processDeploymentBatch } from './deployment-execution.ts';
import type { ApiEnv } from './env.ts';
import { armFastMaintenance } from './fast-maintenance.ts';
import { processUsageEventBatch } from './usage-queue.ts';

type PlatformQueueProcessors = Readonly<{
  cron: (batch: MessageBatch<CronFireMessage>, env: ApiEnv['Bindings']) => Promise<void>;
  usage: (batch: MessageBatch<unknown>, env: ApiEnv['Bindings']) => Promise<void>;
  deployments?: (batch: MessageBatch<unknown>, env: ApiEnv['Bindings']) => Promise<void>;
}>;

const defaultProcessors: PlatformQueueProcessors = {
  cron: processCronFiresBatch,
  usage: processUsageEventBatch,
  deployments: processDeploymentBatch,
};

export async function processPlatformQueue(
  batch: MessageBatch<unknown>,
  env: ApiEnv['Bindings'],
  processors: PlatformQueueProcessors = defaultProcessors,
): Promise<void> {
  if (batch.queue === (env.DEPLOYMENTS_QUEUE_NAME ?? 'void-deployments')) {
    // Admitted operations drain through maintenance; the database lifecycle
    // checkpoint closes new admission before a downgrade waits for this Queue.
    // A delivery that fails or is abandoned is recovered by the two-minute
    // outbox once its lease expires.
    await armFastMaintenance(env);
    await (processors.deployments ?? processDeploymentBatch)(batch, env);
    return;
  }
  const cronQueue = env.CRON_FIRES_QUEUE_NAME ?? 'void-cron-fires';
  if (batch.queue !== cronQueue) {
    // Usage is durable accounting data. It must drain even while application
    // traffic is disabled, and deliberately performs no lifecycle-gate read.
    await processors.usage(batch, env);
    return;
  }

  const blocked =
    env.PLATFORM_TRAFFIC_STATE === 'staging' ||
    env.PLATFORM_TRAFFIC_STATE === 'sandbox-drain' ||
    (env.PLATFORM_INSTALLATION_ID !== undefined &&
      (await env.ROUTING.get(PLATFORM_DISABLED_KEY)) === PLATFORM_DISABLED_VALUE);
  if (blocked) {
    // Cron invocations are time-bound actions rather than stored user data.
    // Running an old firing after a long disable would be more surprising and
    // dangerous than cancellation, so acknowledge it explicitly and leave an
    // auditable Worker log instead of silently returning from the queue event.
    console.warn(
      `[platform-lifecycle] canceled ${batch.messages.length} pending cron firing(s) for disabled installation ${env.PLATFORM_INSTALLATION_ID ?? 'staging'}`,
    );
    batch.ackAll();
    return;
  }

  await processors.cron(batch as MessageBatch<CronFireMessage>, env);
}
