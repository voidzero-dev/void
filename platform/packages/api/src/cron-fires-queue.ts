import type { ApiEnv } from './env.ts';

/**
 * One enqueued cron firing. The CronScheduler DO writes one of these per
 * distinct cron expression whose minute matches `now`. The DO itself cannot reach the
 * user worker via `DISPATCH.get(...).fetch(...)` because workerd dispatches
 * such calls to a named entrypoint matching the calling DO's class —
 * "CronScheduler" — which doesn't exist on user workers, so every fetch fails
 * with `The entrypoint name CronScheduler was not found`. The queue handler
 * runs as a fresh fetch event outside of any DO/RPC context, so the
 * dispatched call resolves to the user worker's default entrypoint.
 */
export type CronFireMessage = Readonly<{
  workerName: string;
  cron: string;
  scheduledTime: number;
  proxyToken?: string;
}>;

type InvokeOutcome = Readonly<{
  /** True if a Response was received, regardless of status code. */
  responseReceived: boolean;
  status?: number;
  bodySnippet?: string;
  /** True only when the worker script no longer exists. */
  unreachable?: boolean;
}>;

/**
 * Cloudflare's WfP dispatch surfaces a missing-worker error as a thrown
 * Error whose message starts with "Worker not found". This predicate is
 * the only way to distinguish "user worker is permanently gone" from
 * other transient dispatch failures.
 */
function isWorkerNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('Worker not found');
}

async function invokeWorker(
  env: ApiEnv['Bindings'],
  message: CronFireMessage,
): Promise<InvokeOutcome> {
  const headers: Record<'Content-Type', string> & Partial<Record<'x-void-internal', string>> = {
    'Content-Type': 'application/json',
  };
  if (message.proxyToken) {
    headers['x-void-internal'] = message.proxyToken;
  }
  const body = JSON.stringify({ cron: message.cron, scheduledTime: message.scheduledTime });

  let res: Response;
  try {
    const worker = env.DISPATCH.get(message.workerName);
    res = await worker.fetch(
      new Request('https://internal/__void/scheduled', { method: 'POST', headers, body }),
    );
    // Legacy: workers deployed before /__void/* migration listened on /__scheduled.
    if (res.status === 404) {
      // Drain the orphaned 404 body before reassigning — same reason as
      // the success-path drain below. .catch() because this runs inside
      // the outer try; a throwing body read would otherwise route into the
      // `catch (err)` block and mis-categorize as a transport failure.
      await res.arrayBuffer().catch(() => {});
      res = await worker.fetch(
        new Request('https://internal/__scheduled', { method: 'POST', headers, body }),
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Not retried: see the at-most-once note in processCronFiresBatch.
    return {
      responseReceived: false,
      unreachable: isWorkerNotFoundError(err),
      bodySnippet: msg,
    };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      responseReceived: true,
      status: res.status,
      bodySnippet: text.slice(0, 200),
    };
  }
  // Fully consume the response body so the dispatch subrequest finalizes cleanly,
  // otherwise workerd flags the user worker's tail event as
  // `outcome: "canceled"` even though the handler ran to completion.
  // arrayBuffer() (not cancel()) is required: cancel() aborts the stream rather
  // than reading it, so workerd still sees an unfinished subrequest.
  // Swallow rejection from the body read locally: a stream errored mid-drain
  // would otherwise throw out of invokeWorker, get swallowed by
  // Promise.allSettled in processCronFiresBatch, and skip msg.ack() — which CF
  // Queues treats as "retry the message", duplicating cron execution. The
  // whole point of this file is at-most-once for cron handlers; cosmetic
  // tail-log polish must not weaken that contract.
  await res.arrayBuffer().catch(() => {});
  return { responseReceived: true, status: res.status };
}

export async function processCronFiresBatch(
  batch: MessageBatch<CronFireMessage>,
  env: ApiEnv['Bindings'],
): Promise<void> {
  await Promise.allSettled(
    batch.messages.map(async (msg) => {
      const outcome = await invokeWorker(env, msg.body);

      // A Response came back — the user worker's handler ran (or the runtime
      // made a routing decision, e.g. 404 on missing handler). Either way the
      // request was delivered exactly once. Retrying would risk duplicate
      // side effects (emails, payments, DB writes) for handlers that fail
      // mid-execution. Application-level failure is the user's problem.
      if (outcome.responseReceived) {
        const status = outcome.status;
        if (status === 401 || status === 403) {
          // Auth drift between CronScheduler's stored proxyToken and the
          // user worker's baked __VOID_PROXY_TOKEN. Retrying would yield
          // the same 401 (same token in, same status out), so we ack; the
          // next deploy's /sync resyncs the token. Logged with a stable
          // greppable marker so ops can alert on this. Right after a token
          // rotation patches the Worker, its old version can still answer
          // for a moment; that fire is dropped too, never replayed with
          // another token, because the Worker's own middleware already ran.
          console.error(
            `[cron-fires] AUTH_DRIFT non-delivery for ${msg.body.workerName} (cron ${msg.body.cron}): status=${status} body=${outcome.bodySnippet ?? ''}; acking — next deploy will resync token`,
          );
        } else if (status !== null && status !== undefined && status >= 400) {
          console.warn(
            `[cron-fires] non-ok response from ${msg.body.workerName} (cron ${msg.body.cron}): status=${status} body=${outcome.bodySnippet ?? ''}`,
          );
        }
        msg.ack();
        return;
      }

      // Worker is gone (deleted or evicted) — drop the message rather than
      // retrying forever. The CronScheduler DO is cleared by the deploy /
      // rollback / project-deletion paths that delete the worker script (see
      // the invariant comment at the top of cron-scheduler.ts).
      if (outcome.unreachable) {
        console.warn(
          `[cron-fires] dropping message: worker not found for ${msg.body.workerName} (cron ${msg.body.cron})`,
        );
        msg.ack();
        return;
      }

      // Some other thrown error — could be a true transport failure (dispatch
      // never reached the worker) OR an exception that surfaced from inside
      // the dispatched worker after it partially executed (CPU limit, OOM,
      // top-level uncaught). We can't tell these apart from the error string,
      // so we ack to preserve at-most-once semantics for cron handlers. The
      // next matching minute will fire again. We deliberately accept transient
      // delivery-failure data loss to prevent duplicate executions.
      console.error(
        `[cron-fires] dispatch error not classified as missing-worker; acked to preserve at-most-once for cron handlers: ${msg.body.workerName} (cron ${msg.body.cron}): ${outcome.bodySnippet ?? ''}`,
      );
      msg.ack();
    }),
  );
}
