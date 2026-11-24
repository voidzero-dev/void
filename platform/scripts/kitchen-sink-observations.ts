import type { Page } from 'playwright';

/** Observe the rendered app, excluding the unchanged SSR hydration payload. */
export async function waitForRenderedText(
  page: Page,
  text: string,
  present: boolean,
  timeoutMs: number,
): Promise<void> {
  await page.waitForFunction(
    ({ text, present }) => {
      const app = document.getElementById('app');
      return app !== null && app.innerText.includes(text) === present;
    },
    { text, present },
    { timeout: timeoutMs },
  );
}

type PollOptions = {
  timeoutMs: number;
  intervalMs?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
};

export async function resetKitchenSink(
  origin: string,
  headers: Record<string, string>,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<number> {
  const response = await fetcher(`${origin}/api/reset`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(
      `Fixture reset failed (HTTP ${response.status}); check the disposable app's database, KV, and storage bindings before testing.`,
    );
  }
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== 'object' || !('ok' in body) || body.ok !== true) {
    throw new Error(
      'Fixture reset did not confirm success with ok: true; verify that SMOKE_URL selects the disposable kitchen-sink app.',
    );
  }
  return now();
}

async function pollObservation(
  read: () => Promise<string | null>,
  accepts: (value: string | null, now: number) => boolean,
  description: string,
  options: PollOptions,
): Promise<string> {
  const now = options.now ?? Date.now;
  const wait =
    options.wait ??
    ((milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  const deadline = now() + options.timeoutMs;
  let latest: string | null = null;
  for (;;) {
    latest = await read();
    if (accepts(latest, now())) {
      return latest!;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(
        `${description} after ${options.timeoutMs}ms (last value: ${JSON.stringify(latest)}).`,
      );
    }
    await wait(Math.min(options.intervalMs ?? 3000, remaining));
  }
}

export function waitForFreshHeartbeat(
  read: () => Promise<string | null>,
  options: PollOptions & { notBefore?: number },
): Promise<string> {
  return pollObservation(
    read,
    (value, now) => {
      const timestamp = value === null ? Number.NaN : Date.parse(value);
      const age = now - timestamp;
      return (
        Number.isFinite(timestamp) &&
        timestamp >= (options.notBefore ?? -Infinity) &&
        age >= -1000 &&
        age < 5 * 60_000
      );
    },
    'No fresh cron heartbeat was observed; check cron registration and dispatch logs, then the fixture KV binding and cron:last-heartbeat key',
    options,
  );
}

export function waitForChangedRender(
  read: () => Promise<string | null>,
  previous: string,
  options: PollOptions,
): Promise<string> {
  return pollObservation(
    read,
    (value) => value !== null && value !== previous && Number.isFinite(Date.parse(value)),
    'The rendered timestamp did not change after revalidation; check the purge outcome, ISR cache configuration, and fixture loader',
    options,
  );
}

export function waitForIsrCacheHit(
  read: () => Promise<string | null>,
  options: PollOptions,
): Promise<string> {
  return pollObservation(
    read,
    (value) => value === 'HIT',
    'No ISR cache hit was observed; check the deployment ISR manifest and dispatch cache configuration',
    options,
  );
}
