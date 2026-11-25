import type { CloudflareTriggerConfig } from '@void/deploy-cloudflare';
import { isRecord } from '@void/deploy-core';

type ReadCloudflare = (path: string) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function sameStrings(actual: ReadonlyArray<string>, expected: ReadonlyArray<string>): boolean {
  const sortedExpected = [...expected].sort();
  return (
    actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === sortedExpected[index])
  );
}

function desiredQueue(value: unknown): Record<string, unknown> | null {
  const queue = record(value);
  if (
    !queue ||
    typeof queue.queue !== 'string' ||
    Object.keys(queue).some(
      (key) =>
        ![
          'queue',
          'max_batch_size',
          'max_batch_timeout',
          'max_retries',
          'max_concurrency',
          'retry_delay',
          'dead_letter_queue',
        ].includes(key),
    ) ||
    ['max_batch_size', 'max_batch_timeout', 'max_retries', 'max_concurrency', 'retry_delay'].some(
      (key) => queue[key] !== undefined && typeof queue[key] !== 'number',
    ) ||
    (queue.dead_letter_queue !== undefined && typeof queue.dead_letter_queue !== 'string')
  ) {
    return null;
  }
  return queue;
}

function matchesQueueConsumer(
  liveValue: unknown,
  desired: Record<string, unknown>,
  workerName: string,
): boolean {
  const live = record(liveValue);
  const settings = record(live?.settings);
  if (
    !live ||
    live.type !== 'worker' ||
    (live.script_name !== undefined && live.script_name !== workerName) ||
    live.queue_name !== desired.queue ||
    !settings
  ) {
    return false;
  }
  const expected = {
    batch_size: desired.max_batch_size ?? 10,
    max_wait_time_ms: Number(desired.max_batch_timeout ?? 5) * 1000,
    max_retries: desired.max_retries ?? 3,
    max_concurrency: desired.max_concurrency ?? null,
    retry_delay: desired.retry_delay ?? 0,
  };
  return (
    Object.entries(expected).every(([key, value]) =>
      key === 'max_concurrency' ? (settings[key] ?? null) === value : settings[key] === value,
    ) && (live.dead_letter_queue ?? '') === (desired.dead_letter_queue ?? '')
  );
}

/**
 * Read every surface that `triggers deploy` can mutate for a platform Worker. An incomplete
 * response, unsupported trigger kind, or read failure requires normal trigger publication.
 */
export async function platformWorkerLiveTriggersMatch(options: {
  accountId: string;
  workerName: string;
  desired: CloudflareTriggerConfig;
  readCloudflare: ReadCloudflare;
}): Promise<boolean> {
  const { accountId, workerName, desired, readCloudflare } = options;
  if (
    desired.preserve ||
    desired.addresses !== undefined ||
    desired.workflows.length > 0 ||
    !desired.crons.every((cron) => typeof cron === 'string')
  ) {
    return false;
  }
  const queues = desired.queueConsumers.map(desiredQueue);
  if (queues.some((queue) => queue === null)) {
    return false;
  }
  const base = `/accounts/${encodeURIComponent(accountId)}`;
  const script = `${base}/workers/scripts/${encodeURIComponent(workerName)}`;
  try {
    const [workerValue, schedulesValue, workflowsValue, nextWorkflowsValue] = await Promise.all([
      readCloudflare(`${base}/workers/workers/${encodeURIComponent(workerName)}`),
      readCloudflare(`${script}/schedules`),
      readCloudflare(`${base}/workflows?page=1&per_page=100`),
      readCloudflare(`${base}/workflows?page=2&per_page=100`),
    ]);
    const worker = record(workerValue);
    const subdomain = record(worker?.subdomain);
    const schedules = record(schedulesValue)?.schedules;
    const references = record(worker?.references)?.queues;
    if (
      worker?.name !== workerName ||
      !subdomain ||
      (!desired.preserveWorkersDev && subdomain.enabled !== desired.workers_dev) ||
      (!desired.preservePreviewUrls && subdomain.previews_enabled !== desired.preview_urls) ||
      !Array.isArray(schedules) ||
      !Array.isArray(references) ||
      !Array.isArray(workflowsValue) ||
      workflowsValue.length >= 100 ||
      !Array.isArray(nextWorkflowsValue) ||
      nextWorkflowsValue.length !== 0
    ) {
      return false;
    }
    const liveCrons = schedules.map((entry) => record(entry)?.cron);
    if (
      !liveCrons.every((cron) => typeof cron === 'string') ||
      !sameStrings(liveCrons, desired.crons) ||
      workflowsValue.some((entry) => {
        const workflow = record(entry);
        return (
          !workflow ||
          typeof workflow.script_name !== 'string' ||
          workflow.script_name === workerName
        );
      })
    ) {
      return false;
    }
    if (references.length !== queues.length) {
      return false;
    }
    const matched = new Set<string>();
    const consumers = await Promise.all(
      references.map(async (value) => {
        const reference = record(value);
        if (
          typeof reference?.queue_id !== 'string' ||
          typeof reference.queue_consumer_id !== 'string' ||
          typeof reference.queue_name !== 'string'
        ) {
          return null;
        }
        return {
          queueName: reference.queue_name,
          consumer: await readCloudflare(
            `${base}/queues/${encodeURIComponent(reference.queue_id)}/consumers/${encodeURIComponent(reference.queue_consumer_id)}`,
          ),
        };
      }),
    );
    for (const entry of consumers) {
      if (!entry || matched.has(entry.queueName)) {
        return false;
      }
      const desiredQueueConfig = queues.find((queue) => queue?.queue === entry.queueName);
      if (
        !desiredQueueConfig ||
        !matchesQueueConsumer(entry.consumer, desiredQueueConfig, workerName)
      ) {
        return false;
      }
      matched.add(entry.queueName);
    }
    return matched.size === queues.length;
  } catch {
    return false;
  }
}
