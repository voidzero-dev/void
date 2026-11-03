import { CLOUDFLARE_DEPLOY_BUILD_ENV, CLOUDFLARE_QUEUE_NAMES_BUILD_ENV } from '../shared/env.ts';

/**
 * Cloudflare queue names for `void deploy --platform cloudflare`.
 *
 * Queue names are unique per account, so a deploy names each queue after its
 * Worker: `queues/jobs.ts` in Worker `app-staging` becomes `app-staging-jobs`.
 * A queue the Worker already consumes keeps its name, so apps deployed before
 * this rule keep their queue and its backlog. Dev, previews and the hosted
 * platform keep the plain queue name.
 */

/** Logical queue name (from `queues/`) to Cloudflare queue name. */
export type CloudflareQueueNames = Readonly<Record<string, string>>;

/**
 * An existing Cloudflare queue, listed by its consumers: the Worker script
 * name, or `null` for a consumer that is not a Worker (HTTP pull). `null` for
 * the whole value means the queue does not exist.
 */
export type CloudflareQueueState = { consumers: ReadonlyArray<string | null> } | null;

/** `workerPrefix` is the Worker name in resource-name form (lowercase, `_` as `-`). */
export function scopedCloudflareQueueName(workerPrefix: string, queueName: string): string {
  return `${workerPrefix}-${queueName}`;
}

const consumedBy = (state: CloudflareQueueState, workerName: string): boolean =>
  state?.consumers.includes(workerName) ?? false;

/**
 * Pick the Cloudflare name for one queue: its scoped name, or its plain name
 * when this Worker already consumes that queue. `plain` may be `undefined`
 * when it was not looked up, which is only needed when the Worker does not
 * already consume the scoped queue.
 */
export function chooseCloudflareQueueName(input: {
  workerName: string;
  queueName: string;
  scopedName: string;
  scoped: CloudflareQueueState;
  plain: CloudflareQueueState | undefined;
}): { name: string; kept: boolean } {
  if (
    !consumedBy(input.scoped, input.workerName) &&
    consumedBy(input.plain ?? null, input.workerName)
  ) {
    return { name: input.queueName, kept: true };
  }
  return { name: input.scopedName, kept: false };
}

/** Consumers of a queue other than this Worker. A queue has one consumer. */
export function otherQueueConsumers(
  state: CloudflareQueueState,
  workerName: string,
): Array<string | null> {
  return state?.consumers.filter((consumer) => consumer !== workerName) ?? [];
}

/**
 * The names `void deploy` chose, read inside its Vite build. Returns undefined
 * outside that build, where queues keep their plain names.
 */
export function readDeployBuildQueueNames(): CloudflareQueueNames | undefined {
  if (process.env[CLOUDFLARE_DEPLOY_BUILD_ENV] !== '1') {
    return undefined;
  }
  const raw = process.env[CLOUDFLARE_QUEUE_NAMES_BUILD_ENV];
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((name) => typeof name !== 'string' || name === '')
  ) {
    throw new Error(`queue: ${CLOUDFLARE_QUEUE_NAMES_BUILD_ENV} is not a valid queue name map.`);
  }
  return parsed as CloudflareQueueNames;
}

/** The Cloudflare name of a queue: the deploy's choice, or its plain name. */
export function cloudflareQueueName(
  queueName: string,
  names: CloudflareQueueNames | undefined,
): string {
  return names && Object.hasOwn(names, queueName) ? names[queueName]! : queueName;
}
