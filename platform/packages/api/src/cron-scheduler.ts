import { DurableObject } from 'cloudflare:workers';
import { CronExpressionParser } from 'cron-parser';
import type { CronSyncState as CronState } from './cron-scheduler-client.ts';
import type { ApiEnv } from './env.ts';
import { projectSuspensionKey } from './suspension.ts';

/**
 * Convert a CF/Quartz-style cron expression to Unix-style for cron-parser.
 *
 * Cloudflare uses Quartz day-of-week numbering (1=Sun … 7=Sat).
 * cron-parser uses Unix convention (0=Sun … 6=Sat, 7=Sun).
 * This only affects numeric values in the DOW field — abbreviations (MON, FRI)
 * are unambiguous and passed through unchanged.
 */
export function cfCronToUnix(expr: string): string {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return expr;
  }

  fields[4] = fields[4]
    .split(',')
    .map((part) => {
      // Handle range with optional step: "2-6/2" → "1-5/2"
      const [rangeOrValue, step] = part.split('/');
      const stepSuffix = step != null ? `/${step}` : '';

      if (rangeOrValue === '*') {
        return `*${stepSuffix}`;
      }

      // Handle range: "2-6" → "1-5"
      if (rangeOrValue.includes('-')) {
        const [start, end] = rangeOrValue.split('-').map((value) => shiftDow(value));
        return `${start}-${end}${stepSuffix}`;
      }

      // Single value (may have L/# suffix)
      return `${shiftDow(rangeOrValue)}${stepSuffix}`;
    })
    .join(',');

  return fields.join(' ');
}

function shiftDow(value: string): string {
  // Preserve abbreviations (MON, FRI, etc.) and L/# suffixes
  const match = value.match(/^(\d+)(.*)/);
  if (!match) {
    return value;
  } // abbreviation like MON, SUN
  const shiftedDayOfWeek = Math.max(0, parseInt(match[1], 10) - 1);
  return `${shiftedDayOfWeek}${match[2]}`;
}

/** Check if a cron expression matches the given minute. */
export function cronMatchesMinute(cronExpr: string, now: number): boolean {
  try {
    // Add 1ms so prev() returns the current minute when now is exactly on the boundary.
    // Cron resolution is per-minute so this is safe.
    const interval = CronExpressionParser.parse(cfCronToUnix(cronExpr), {
      currentDate: new Date(now + 1),
      tz: 'UTC',
    });
    const prev = interval.prev().toDate().getTime();
    const nowMinute = Math.floor(now / 60_000) * 60_000;
    return prev >= nowMinute && prev < nowMinute + 60_000;
  } catch {
    return false;
  }
}

/** Compute the earliest next fire time across all schedules. Returns null if none. */
export function getNextFireTime(
  schedules: ReadonlyArray<{ cron: string }>,
  now: number,
): number | null {
  let earliest = Infinity;
  for (const schedule of schedules) {
    try {
      const interval = CronExpressionParser.parse(cfCronToUnix(schedule.cron), {
        currentDate: new Date(now),
        tz: 'UTC',
      });
      const next = interval.next().toDate().getTime();
      if (next < earliest) {
        earliest = next;
      }
    } catch {
      // Skip invalid cron expressions
    }
  }
  return earliest < Infinity ? earliest : null;
}

/** CF Queues `sendBatch` is capped at 100 messages or 256 KiB per call. */
const SEND_BATCH_CHUNK_SIZE = 100;

/**
 * Cap workerd alarm retries we accept before abandoning the firing window.
 *
 * Workerd retries `alarm()` ~6 times after a throw; once that budget is
 * exhausted, the alarm is permanently dropped and never re-invoked until
 * `setAlarm()` is called again. If the all-fail branch keeps throwing past
 * the workerd cap, the DO is left with `state.schedules.length > 0` and no
 * alarm — a permanent silent failure that requires a deploy or manual
 * `/sync` to recover.
 *
 * We cap at 5 (one less than the workerd cap) so we still get one workerd-
 * managed retry AND we keep the DO armed for the next firing window. The
 * cost is losing one fire window for sparse crons (e.g. `0 * * * *`) or one
 * minute for per-minute crons — both recoverable on the next valid alarm.
 */
const ALARM_RETRY_BUDGET = 5;

/** Split `items` into chunks of at most `size` (size must be >= 1). */
export function chunkMessages<T>(
  items: ReadonlyArray<T>,
  size: number,
): ReadonlyArray<ReadonlyArray<T>> {
  if (size < 1) {
    throw new Error('chunkMessages: size must be >= 1');
  }
  const chunks: Array<ReadonlyArray<T>> = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

// Every code path that calls deleteDispatchScript on a user worker MUST also
// call clearCronScheduler / syncCronScheduler from cron-scheduler-client.ts.
export class CronScheduler extends DurableObject<ApiEnv['Bindings']> {
  private state: CronState | null = null;

  private async getState(): Promise<CronState | null> {
    if (this.state) {
      return this.state;
    }
    const stored = await this.ctx.storage.get<CronState>('state');
    this.state = stored ?? null;
    return this.state;
  }

  private async saveState(state: CronState): Promise<void> {
    this.state = state;
    await this.ctx.storage.put('state', state);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/sync') {
      return this.handleSync(request);
    }
    if (request.method === 'POST' && path === '/clear') {
      return this.handleClear();
    }
    if (request.method === 'GET' && path === '/status') {
      return this.handleStatus();
    }
    if (request.method === 'GET' && path === '/snapshot') {
      return Response.json({ state: await this.getState() });
    }

    return new Response('not found', { status: 404 });
  }

  private async handleSync(request: Request): Promise<Response> {
    const body = await request.json<CronState>();
    await this.saveState(body);
    await this.scheduleNextAlarm();
    return Response.json({ ok: true });
  }

  private async handleClear(): Promise<Response> {
    this.state = null;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    return Response.json({ ok: true });
  }

  private async handleStatus(): Promise<Response> {
    const state = await this.getState();
    const alarm = await this.ctx.storage.getAlarm();
    // Omit proxyToken from status response to avoid leaking secrets.
    const { proxyToken: _, ...safeState } = state ?? {};
    return Response.json({ state: state ? safeState : null, nextAlarm: alarm });
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    const state = await this.getState();
    if (!state || state.schedules.length === 0) {
      return;
    }

    // State without a proxyToken has no auth credentials.
    // Skip invocation to avoid sending unauthenticated requests — the next
    // deploy will resync state with the token.
    if (!state.proxyToken) {
      console.warn(
        `CronScheduler: missing proxyToken for ${state.workerName}, skipping until next deploy resync`,
      );
      return;
    }

    // Use `alarmInfo.scheduledTime` (the cron minute the alarm was originally
    // scheduled for) rather than `Date.now()`. Workerd retries `alarm()` after
    // a throw, but `Date.now()` reads wall-clock at retry time — so:
    //   - Queue-message `scheduledTime` would carry the retry instant rather
    //     than the original cron minute (wrong for downstream consumers).
    //   - If a retry crosses a minute boundary, `cronMatchesMinute` would
    //     evaluate the wrong minute. For sparse crons (`0 * * * *`) the cross-
    //     minute case yields `matching.length === 0` → the firing is silently
    //     lost.
    // Using the scheduled time pins both checks to the same minute regardless
    // of when the retry executes.
    //
    // Invariant: workerd always passes `alarmInfo` to `alarm()` on modern
    // runtimes (the `alarmInfo?` optionality in `@cloudflare/workers-types` is
    // a source-compat artifact). The `?? Date.now()` and `?? 0` retryCount
    // fallbacks below are defensive — they only matter for unit tests that
    // invoke `alarm()` directly without an `alarmInfo` argument.
    const now = alarmInfo?.scheduledTime ?? Date.now();
    const matching = state.schedules.filter((schedule) => cronMatchesMinute(schedule.cron, now));

    if (matching.length === 0) {
      await this.scheduleNextAlarm();
      return;
    }

    if (await this.isProjectSuspended()) {
      console.warn(
        `CronScheduler: owner suspended by an administrator; skipping fire for ${state.workerName}`,
      );
      await this.scheduleNextAlarm();
      return;
    }

    // Hand off to the cron-fires queue: this DO cannot dispatch to the user
    // worker directly (see `CronFireMessage`).
    // The worker fans an expression out to every matching job. Deliver the
    // expression once, even when multiple named jobs share it.
    const expressions = [...new Set(matching.map((schedule) => schedule.cron))];
    const messages = expressions.map((cron) => ({
      body: {
        workerName: state.workerName,
        cron,
        scheduledTime: now,
        proxyToken: state.proxyToken,
      },
    }));
    const chunks = chunkMessages(messages, SEND_BATCH_CHUNK_SIZE);
    const results = await Promise.allSettled(
      chunks.map((chunk) => this.env.CRON_FIRES_QUEUE.sendBatch(chunk)),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    if (failures.length > 0) {
      const reasons = failures
        .map((failure) =>
          failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
        )
        .join('; ');
      console.error(
        `CronScheduler: ${failures.length}/${chunks.length} sendBatch chunks failed for ${state.workerName}: ${reasons}`,
      );
      if (failures.length === chunks.length) {
        const retryCount = alarmInfo?.retryCount ?? 0;
        if (retryCount >= ALARM_RETRY_BUDGET) {
          // Workerd retries are about to exhaust. If we throw again, the
          // alarm would be permanently dropped — leaving the DO with active
          // schedules but no alarm, requiring a deploy or manual `/sync` to
          // recover. Accept that this firing is lost, schedule the NEXT cron
          // minute, and return. Sparse crons lose one fire window; per-minute
          // crons lose at most one minute. Either is recoverable on the next
          // valid alarm.
          console.error(
            `CronScheduler: retry budget exhausted (retryCount=${retryCount}) for ${state.workerName}; abandoning this fire and scheduling next alarm`,
          );
          await this.scheduleNextAlarm();
          return;
        }
        // No fires were enqueued (likely CF Queues API outage). Within retry
        // budget: throw so workerd retries the alarm with backoff. The retry
        // re-evaluates via `alarmInfo.scheduledTime`, so the original cron
        // minute is preserved. Safe because nothing succeeded — there is no
        // double-fire risk. Critically, we throw BEFORE calling
        // scheduleNextAlarm() so the runtime keeps the current alarm in place
        // for retry. See:
        // https://developers.cloudflare.com/durable-objects/api/alarms/#alarm-handler-method
        throw new Error(`CronScheduler: all sendBatch chunks failed: ${reasons}`);
      }
      // Partial success: some fires landed, others were lost. Re-running
      // would double-fire the successful chunks, so we accept the loss and
      // let the next matching minute proceed normally.
    }

    await this.scheduleNextAlarm();
  }

  /** The DO is always addressed by idFromName(projectId) (cron-scheduler-client.ts). */
  private async isProjectSuspended(): Promise<boolean> {
    const projectId = this.ctx.id.name;
    if (!projectId) {
      // Alarms armed before the runtime stored names: fire as before until the next sync.
      return false;
    }
    try {
      return (
        (await this.env.ROUTING.get(projectSuspensionKey(projectId), { cacheTtl: 60 })) !== null
      );
    } catch (error) {
      console.error(`CronScheduler: suspension check failed for ${projectId}; firing`, error);
      return false;
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    const state = await this.getState();
    if (!state || state.schedules.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const next = getNextFireTime(state.schedules, Date.now());
    if (next != null) {
      await this.ctx.storage.setAlarm(next);
    }
  }
}
