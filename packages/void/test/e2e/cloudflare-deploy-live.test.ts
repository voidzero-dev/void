import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createIsolatedPlayground } from '../../../../test/integration-helpers.ts';
import { renderVoidConfig } from '../../src/config-write.ts';
import { readConfig } from '../../src/config.ts';

// Gated live-account e2e for the `void deploy --platform cloudflare` path. Runs only when
// VOID_E2E_CF_TOKEN and VOID_E2E_CF_ACCOUNT_ID are set, and skips each test otherwise. See
// README.md in this directory for prerequisites, CI wiring, and resource naming and retention.

// Read env inside hooks and tests, never at module load: Vitest collects this file before the
// runner injects the job env, so a top-level read sees empty credentials.
function cfToken(): string {
  return process.env.VOID_E2E_CF_TOKEN ?? '';
}
function cfAccountId(): string {
  return process.env.VOID_E2E_CF_ACCOUNT_ID ?? '';
}
// Live cf calls are unverified on Windows; cloudflare-deploy-build.test.ts covers the build there.
function e2eEnabled(): boolean {
  return cfToken().length > 0 && cfAccountId().length > 0 && process.platform !== 'win32';
}
const NO_CREDS_NOTE =
  'VOID_E2E_CF_TOKEN + VOID_E2E_CF_ACCOUNT_ID not set (or win32) — live deploy skipped';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PACKAGE_ROOT = join(ROOT, 'packages', 'void');
const CLI_ENTRY = join(PACKAGE_ROOT, 'dist', 'cli', 'cli.mjs');
// `spawn.sync` blocks the event loop, so Vitest cannot time out a hung call.
// Bound every spawn below its hook timeout.
const DEPLOY_TIMEOUT_MS = 480_000;
const REQUEST_TIMEOUT_MS = 20_000;
let app = '';
let workerName = '';
let d1Name = '';
let kvTitle = '';
let deployOutput = '';
let deployStatus: number | null = null;
let firstResourceIds: ReturnType<typeof resourceIds>;
let createdEmail = '';
let kvKey = '';
let kvValue = '';

// Randomness belongs in test records, never in retained remote resource names.
function uniqueRecordSuffix(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function resourceIds() {
  const config = JSON.parse(readFileSync(join(app, '.void-wrangler.jsonc'), 'utf8')) as {
    d1_databases?: Array<{ binding: string; database_id: string }>;
    kv_namespaces?: Array<{ binding: string; id: string }>;
  };
  return {
    d1: config.d1_databases?.find((binding) => binding.binding === 'DB')?.database_id,
    kv: config.kv_namespaces?.find((binding) => binding.binding === 'KV')?.id,
  };
}

/** The credentialed env every real Cloudflare call shares. */
function cloudEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: cfToken(),
    CLOUDFLARE_ACCOUNT_ID: cfAccountId(),
  };
  // The CLI receives only its standard token variable, which it strips from app builds.
  delete env.VOID_E2E_CF_TOKEN;
  // The direct fetches and the CLI must use the same public Cloudflare API.
  delete env.CLOUDFLARE_API_BASE_URL;
  delete env.CF_API_BASE_URL;
  delete env.WRANGLER_API_ENVIRONMENT;
  delete env.CLOUDFLARE_COMPLIANCE_REGION;
  return env;
}

/** Extract the deployed workers.dev URL the CLI prints on a successful deploy. */
function extractWorkerUrl(output: string): string | undefined {
  // The host has two labels before workers.dev: `<worker>.<account-subdomain>`.
  return output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev(?:\/[^\s]*)?/)?.[0];
}

/** A `setTimeout` delay that also resolves immediately when `signal` aborts, so a pending retry wait
 * never outlives a timed-out test. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Poll until a 200, retrying any other status: a new workers.dev host can 404 while its route
 * propagates. Returns the last response, or throws when no attempt got a response.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  attempts = 40,
  delayMs = 3000,
  signal?: AbortSignal,
): Promise<Response> {
  let lastResponse: Response | undefined;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    // Stop once the test times out, so retries do not leak into later tests.
    if (signal?.aborted) {
      break;
    }
    try {
      const res = await fetch(url, {
        ...init,
        signal:
          init.signal ??
          (signal
            ? AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal])
            : AbortSignal.timeout(REQUEST_TIMEOUT_MS)),
      });
      if (res.status === 200) {
        return res;
      }
      lastResponse = res;
      lastError = undefined;
    } catch (error) {
      lastError = error;
      lastResponse = undefined;
    }
    if (i < attempts - 1) {
      await abortableDelay(delayMs, signal);
    }
  }
  if (lastResponse) {
    return lastResponse;
  }
  throw lastError ?? new Error(`worker at ${url} never answered`);
}

/** Report whether the worker's workers.dev route is enabled, to diagnose a persistent 404. */
async function workersDevEnabled(): Promise<string> {
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfAccountId()}/workers/scripts/${workerName}/subdomain`,
      {
        headers: { Authorization: `Bearer ${cfToken()}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    const body = (await res.json().catch(() => ({}))) as { result?: unknown };
    return `workers.dev subdomain endpoint ${res.status}: ${JSON.stringify(body.result ?? body)}`;
  } catch (error) {
    return `workers.dev subdomain check errored: ${String(error)}`;
  }
}

/** Authenticated GET against the Cloudflare API for THIS deployed worker (Bearer `cfToken()`). */
async function cfWorkerApi(path: string, signal?: AbortSignal): Promise<Response> {
  return fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cfAccountId()}/workers/scripts/${workerName}${path}`,
    {
      headers: { Authorization: `Bearer ${cfToken()}` },
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
}

describe('void deploy --platform cloudflare (live account)', () => {
  beforeAll(() => {
    if (!e2eEnabled()) {
      return;
    }
    const namespace = process.env.VOID_E2E_NAMESPACE?.trim();
    if (!namespace) {
      throw new Error(
        'Set VOID_E2E_NAMESPACE to a stable namespace reserved for this test account.',
      );
    }
    workerName = `void-e2e-cf-deploy-${namespace}`;
    d1Name = `${workerName}-db`;
    kvTitle = `${workerName}-kv`;
    app = createIsolatedPlayground(ROOT, 'playground/spa').root;
    // Start from fixture source, not an operator's environment or old provider identity.
    for (const name of readdirSync(app)) {
      if (
        name === '.env' ||
        name.startsWith('.env.') ||
        name === '.dev.vars' ||
        name.startsWith('.dev.vars.') ||
        [
          '.void-wrangler.jsonc',
          'void.lock.json',
          'wrangler.jsonc',
          'wrangler.json',
          'wrangler.toml',
        ].includes(name)
      ) {
        rmSync(join(app, name), { force: true });
      }
    }

    // The explicit account-local namespace is reserved for this suite. The production provisioner
    // discovers and pins its actual D1/KV IDs, including on retry after a partial deployment.
    const config = readConfig(app);
    writeFileSync(
      join(app, 'void.config.ts'),
      renderVoidConfig({
        ...config,
        cloudflare: {
          name: workerName,
          account_id: cfAccountId(),
        },
      }),
    );

    const res = spawn.sync('node', [CLI_ENTRY, 'deploy', '--platform', 'cloudflare'], {
      cwd: app,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: cloudEnv(),
      timeout: DEPLOY_TIMEOUT_MS,
    });
    deployStatus = res.status;
    deployOutput = `${res.stdout ?? ''}${res.stderr ?? ''}${res.error ? `\n${res.error}` : ''}`;
  }, 600_000);

  afterAll(() => {
    if (app) {
      // Keep the lockfile and remote resources for the next run and any failure investigation.
      console.info(
        `Live E2E targets retained when created: ${workerName}, ${d1Name}, ${kvTitle}. Fixture: ${app}`,
      );
    }
  });

  it('deploys the worker to the live account', (ctx) => {
    ctx.skip(!e2eEnabled(), NO_CREDS_NOTE);
    expect(deployStatus, deployOutput).toBe(0);
    const url = extractWorkerUrl(deployOutput);
    expect(url, deployOutput).toBeDefined();
    const workerLabel = new URL(url!).hostname.split('.')[0];
    expect(workerLabel, `deployed host for ${url}`).toBe(workerName);
    firstResourceIds = resourceIds();
    expect(firstResourceIds.d1).toBeTruthy();
    expect(firstResourceIds.kv).toBeTruthy();
  });

  it('serves a live 200 from the deployed worker', async (ctx) => {
    ctx.skip(!e2eEnabled(), NO_CREDS_NOTE);
    const base = extractWorkerUrl(deployOutput);
    expect(base, deployOutput).toBeDefined();
    const url = `${base!.replace(/\/$/, '')}/api/hello`;
    const res = await fetchWithRetry(url, {}, 40, 3000, ctx.signal);
    const diagnostic =
      res.status === 200 ? '' : ` — GET ${url} → ${res.status}; ${await workersDevEnabled()}`;
    expect(res.status, `worker ${workerName}${diagnostic}`).toBe(200);
  }, 200_000);

  it('persists data through the live D1 binding', async (ctx) => {
    ctx.skip(!e2eEnabled(), NO_CREDS_NOTE);
    const base = extractWorkerUrl(deployOutput);
    expect(base, deployOutput).toBeDefined();
    const root = base!.replace(/\/$/, '');
    // Submit once: a failed response does not establish that the insert was rejected.
    const email = `e2e-${uniqueRecordSuffix()}@example.com`;
    createdEmail = email;
    const created = await fetch(`${root}/api/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'E2E User', email }),
      signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ctx.signal]),
    });
    const createdBody = await created.text();
    expect(created.status, createdBody).toBe(200);
    expect(JSON.parse(createdBody)).toEqual({ created: true });

    const list = await fetchWithRetry(`${root}/api/users`, {}, 15, 2000, ctx.signal);
    const listBody = await list.text();
    expect(list.status, listBody).toBe(200);
    const rows = JSON.parse(listBody) as Array<{ email: string }>;
    expect(
      rows.some((u) => u.email === email),
      `posted user ${email} not found in ${listBody}`,
    ).toBe(true);
  }, 120_000);

  it('round-trips a value through the live KV binding', async (ctx) => {
    ctx.skip(!e2eEnabled(), NO_CREDS_NOTE);
    const base = extractWorkerUrl(deployOutput);
    expect(base, deployOutput).toBeDefined();
    const root = base!.replace(/\/$/, '');
    const key = `probe-${uniqueRecordSuffix()}`;
    const value = `kv-${Date.now().toString(36)}`;
    kvKey = key;
    kvValue = value;
    const put = await fetchWithRetry(
      `${root}/api/kv/${key}`,
      { method: 'PUT', body: value },
      15,
      2000,
      ctx.signal,
    );
    expect(put.status, `PUT /api/kv/${key}`).toBe(200);
    // KV can cache a first-read miss for ~60s, so poll past that window.
    const got = await fetchWithRetry(`${root}/api/kv/${key}`, {}, 40, 2000, ctx.signal);
    const gotBody = await got.text();
    expect(got.status, gotBody).toBe(200);
    expect(gotBody).toBe(value);
  }, 150_000);

  it('registers the cron trigger on the deployed worker', async (ctx) => {
    ctx.skip(!e2eEnabled(), NO_CREDS_NOTE);
    // Check the registered schedule through the CF API instead of waiting for the hourly run.
    let crons: Array<string | undefined> = [];
    let diag = 'no response';
    for (let attempt = 0; attempt < 8; attempt++) {
      if (ctx.signal.aborted) {
        break;
      }
      try {
        const res = await cfWorkerApi('/schedules', ctx.signal);
        const body = (await res.json().catch(() => ({}))) as {
          result?: { schedules?: Array<{ cron?: string }> };
        };
        diag = `status ${res.status}: ${JSON.stringify(body)}`;
        if (res.status === 200) {
          crons = (body.result?.schedules ?? []).map((s) => s.cron);
          if (crons.includes('0 * * * *')) {
            break;
          }
        }
      } catch (error) {
        diag = `fetch threw: ${String(error)}`;
      }
      if (attempt < 7) {
        await abortableDelay(2000, ctx.signal);
      }
    }
    expect(crons, `registered schedules — ${diag}`).toContain('0 * * * *');
  }, 60_000);

  it('re-deploys idempotently to the same worker', async (ctx) => {
    ctx.skip(!e2eEnabled(), NO_CREDS_NOTE);
    // Runs last: redeploys with the config the first deploy wrote, reusing the worker, D1 and KV.
    const res = spawn.sync('node', [CLI_ENTRY, 'deploy', '--platform', 'cloudflare'], {
      cwd: app,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: cloudEnv(),
      timeout: DEPLOY_TIMEOUT_MS,
    });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}${res.error ? `\n${res.error}` : ''}`;
    expect(res.status, output).toBe(0);
    // Read the URL from this deploy's own output, not the first deploy's.
    const base = extractWorkerUrl(output);
    expect(base, output).toBeDefined();
    expect(new URL(base!).hostname.split('.')[0], output).toBe(workerName);
    const root = base!.replace(/\/$/, '');
    expect(resourceIds()).toEqual(firstResourceIds);
    // Verify the records survive the update, not only that the bindings answer.
    const served = await fetchWithRetry(`${root}/api/hello`, {}, 15, 2000, ctx.signal);
    expect(served.status).toBe(200);
    const dbRoute = await fetchWithRetry(`${root}/api/users`, {}, 15, 2000, ctx.signal);
    const users = (await dbRoute.json()) as Array<{ email: string }>;
    expect(dbRoute.status).toBe(200);
    expect(users.some((user) => user.email === createdEmail)).toBe(true);
    const kv = await fetchWithRetry(`${root}/api/kv/${kvKey}`, {}, 40, 2000, ctx.signal);
    expect(kv.status).toBe(200);
    expect(await kv.text()).toBe(kvValue);
  }, 600_000);
});
