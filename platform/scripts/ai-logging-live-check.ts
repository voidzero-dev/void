/**
 * Live checks for the AI Gateway logging modes (design doc 0094, checks A and B).
 * Run by hand against a scratch Cloudflare account before a release; not in CI.
 *
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... AI_LOGGING_CHECK_GATEWAY=... \
 *     node platform/scripts/ai-logging-live-check.ts
 *
 * The gateway must be a scratch gateway with request logging turned on, so a call
 * that sends no logging option is logged. The token needs Workers Scripts Edit,
 * Workers AI Read, AI Gateway Read and Account Analytics Read. The script uploads a
 * temporary Worker named `void-ai-logging-check-<time>` with an AI binding, calls it
 * once per mode, reads the gateway logs and analytics, and deletes the Worker.
 *
 * A: binding calls with `collectLog: true` and the `cf-aig-collect-log-payload: false`
 *    extra header store a log entry without bodies (`metadata` mode).
 * B: a binding call with `collectLog: false` still appears in
 *    `aiGatewayRequestsAdaptiveGroups` with its metadata and cost, which metering reads.
 * Provider calls (REST through the gateway with `cf-aig-collect-log*` headers) are
 * checked for every mode as well. Copy the printed summary into design doc 0094.
 */

const API = 'https://api.cloudflare.com/client/v4';
const MODEL = '@cf/meta/llama-3.2-1b-instruct';
const MODES = ['off', 'metadata', 'full'] as const;
type Mode = (typeof MODES)[number];
const POLL_MS = 15_000;
const LOG_TIMEOUT_MS = 5 * 60_000;
const ANALYTICS_TIMEOUT_MS = 15 * 60_000;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Set ${name}.`);
  }
  return value;
}

const accountId = required('CLOUDFLARE_ACCOUNT_ID');
const apiToken = required('CLOUDFLARE_API_TOKEN');
const gatewayId = required('AI_LOGGING_CHECK_GATEWAY');
const runId = String(Date.now());
const workerName = `void-ai-logging-check-${runId}`;

async function cloudflare<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiToken}`, ...init.headers },
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    result?: T;
    errors?: Array<{ message?: string }>;
  } | null;
  if (!response.ok || !body?.success) {
    const message = body?.errors?.map((error) => error.message).join('; ') || 'no details';
    // Never echo the token or request bodies; the path and status are enough.
    throw new Error(
      `Cloudflare ${init.method ?? 'GET'} ${path} failed (HTTP ${response.status}): ${message}`,
    );
  }
  return body.result as T;
}

const WORKER_SOURCE = `
const MODEL = ${JSON.stringify(MODEL)};
function options(env, mode, tag) {
  const gateway = { id: env.GATEWAY, metadata: { projectId: tag } };
  if (mode === 'off') return { gateway: { ...gateway, collectLog: false } };
  return {
    gateway: { ...gateway, collectLog: true },
    extraHeaders: { 'cf-aig-collect-log-payload': mode === 'full' ? 'true' : 'false' },
  };
}
export default {
  async fetch(request, env) {
    const { call, mode, tag } = await request.json();
    if (call === 'toMarkdown') {
      const file = { name: 'check.html', blob: new Blob(['<h1>' + tag + '</h1>'], { type: 'text/html' }) };
      await env.AI.toMarkdown([file], options(env, mode, tag));
    } else {
      await env.AI.run(MODEL, { prompt: 'Say ok. ' + tag, max_tokens: 4 }, options(env, mode, tag));
    }
    return Response.json({ ok: true });
  },
};
`;

async function uploadWorker(): Promise<string> {
  const form = new FormData();
  form.set(
    'metadata',
    JSON.stringify({
      main_module: 'worker.mjs',
      compatibility_date: '2026-10-01',
      bindings: [
        { type: 'ai', name: 'AI' },
        { type: 'plain_text', name: 'GATEWAY', text: gatewayId },
      ],
    }),
  );
  form.set(
    'worker.mjs',
    new Blob([WORKER_SOURCE], { type: 'application/javascript+module' }),
    'worker.mjs',
  );
  await cloudflare(`/accounts/${accountId}/workers/scripts/${workerName}`, {
    method: 'PUT',
    body: form,
  });
  await cloudflare(`/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  const { subdomain } = await cloudflare<{ subdomain: string }>(
    `/accounts/${accountId}/workers/subdomain`,
  );
  return `https://${workerName}.${subdomain}.workers.dev`;
}

async function deleteWorker(): Promise<void> {
  await cloudflare(`/accounts/${accountId}/workers/scripts/${workerName}?force=true`, {
    method: 'DELETE',
  }).catch((error: unknown) => {
    console.error(`Delete the Worker ${workerName} by hand: ${String(error)}`);
  });
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function callWorker(url: string, call: 'run' | 'toMarkdown', mode: Mode, tag: string) {
  // A new workers.dev name can take a moment to answer.
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ call, mode, tag }),
      signal: AbortSignal.timeout(60_000),
    });
    if (response.ok) {
      return;
    }
    if (attempt >= 8) {
      throw new Error(`Worker ${call} ${mode} failed (HTTP ${response.status}).`);
    }
    await response.body?.cancel();
    await wait(POLL_MS);
  }
}

const PROVIDER_HEADERS: Readonly<Record<Mode, Record<string, string>>> = {
  off: { 'cf-aig-collect-log': 'false' },
  metadata: { 'cf-aig-collect-log': 'true', 'cf-aig-collect-log-payload': 'false' },
  full: { 'cf-aig-collect-log': 'true', 'cf-aig-collect-log-payload': 'true' },
};

async function callProvider(mode: Mode, tag: string): Promise<void> {
  const response = await fetch(
    `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/workers-ai/${MODEL}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
        'cf-aig-metadata': JSON.stringify({ projectId: tag }),
        ...PROVIDER_HEADERS[mode],
      },
      body: JSON.stringify({ prompt: `Say ok. ${tag}`, max_tokens: 4 }),
      signal: AbortSignal.timeout(60_000),
    },
  );
  await response.body?.cancel();
  if (!response.ok) {
    throw new Error(`Provider call ${mode} failed (HTTP ${response.status}).`);
  }
}

type LogEntry = Readonly<{ id: string; text: string }>;

async function recentLogs(): Promise<Array<LogEntry>> {
  const query = new URLSearchParams({ per_page: '50', order_by: 'created_at', direction: 'desc' });
  const result = await cloudflare<Array<Record<string, unknown>>>(
    `/accounts/${accountId}/ai-gateway/gateways/${gatewayId}/logs?${query}`,
  );
  return result.map((entry) => ({ id: String(entry.id), text: JSON.stringify(entry) }));
}

/** Whether the gateway stored a request body for this log entry. */
async function hasBody(logId: string): Promise<boolean> {
  const response = await fetch(
    `${API}/accounts/${accountId}/ai-gateway/gateways/${gatewayId}/logs/${logId}/request`,
    { headers: { Authorization: `Bearer ${apiToken}` }, signal: AbortSignal.timeout(60_000) },
  );
  const text = await response.text();
  return response.ok && text.length > 0 && text !== 'null';
}

type LogResult = 'no entry' | 'entry without body' | 'entry with body';

async function logResult(tag: string, expectEntry: boolean): Promise<LogResult> {
  const deadline = Date.now() + (expectEntry ? LOG_TIMEOUT_MS : 2 * 60_000);
  for (;;) {
    const entry = (await recentLogs()).find((log) => log.text.includes(tag));
    if (entry) {
      return (await hasBody(entry.id)) ? 'entry with body' : 'entry without body';
    }
    if (Date.now() > deadline) {
      return 'no entry';
    }
    await wait(POLL_MS);
  }
}

/** The metering read in api/src/routes/usage.ts: rows for this tag, and their cost. */
async function analyticsRow(tag: string, since: Date): Promise<{ rows: number; cost: number }> {
  const query = `query {
  viewer {
    accounts(filter: { accountTag: ${JSON.stringify(accountId)} }) {
      aiGatewayRequestsAdaptiveGroups(
        limit: 1
        filter: {
          gateway: ${JSON.stringify(gatewayId)}
          metadataRaw: ${JSON.stringify(JSON.stringify({ projectId: tag }))}
          datetime_geq: ${JSON.stringify(since.toISOString())}
        }
      ) { count sum { cost } }
    }
  }
}`;
  const deadline = Date.now() + ANALYTICS_TIMEOUT_MS;
  for (;;) {
    const response = await fetch(`${API}/graphql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await response.json()) as {
      data?: {
        viewer?: {
          accounts?: Array<{
            aiGatewayRequestsAdaptiveGroups?: Array<{ count?: number; sum?: { cost?: number } }>;
          }>;
        };
      };
    };
    const group = body.data?.viewer?.accounts?.[0]?.aiGatewayRequestsAdaptiveGroups?.[0];
    if (group?.count) {
      return { rows: group.count, cost: group.sum?.cost ?? 0 };
    }
    if (Date.now() > deadline) {
      return { rows: 0, cost: 0 };
    }
    await wait(POLL_MS);
  }
}

const EXPECTED: Readonly<Record<Mode, LogResult>> = {
  off: 'no entry',
  metadata: 'entry without body',
  full: 'entry with body',
};

async function main(): Promise<void> {
  const since = new Date(Date.now() - 60_000);
  const url = await uploadWorker();
  const results: Array<{ call: string; mode: Mode; result: LogResult; pass: boolean }> = [];
  let checkB = false;
  try {
    for (const call of ['run', 'toMarkdown', 'provider'] as const) {
      for (const mode of MODES) {
        const tag = `void-check-${runId}-${call}-${mode}`;
        if (call === 'provider') {
          await callProvider(mode, tag);
        } else {
          await callWorker(url, call, mode, tag);
        }
        const result = await logResult(tag, mode !== 'off');
        results.push({ call, mode, result, pass: result === EXPECTED[mode] });
        if (call === 'run' && mode === 'off') {
          const analytics = await analyticsRow(tag, since);
          checkB = analytics.rows > 0 && analytics.cost > 0;
          console.log(`B: analytics rows ${analytics.rows}, cost ${analytics.cost}`);
        }
      }
    }
  } finally {
    await deleteWorker();
  }
  for (const { call, mode, result, pass } of results) {
    console.log(`${pass ? 'pass' : 'FAIL'}  ${call.padEnd(10)} ${mode.padEnd(8)} ${result}`);
  }
  const checkA = results
    .filter(({ call, mode }) => call !== 'provider' && mode === 'metadata')
    .every(({ pass }) => pass);
  console.log(`\nA (binding payload header works): ${checkA ? 'pass' : 'fail'}`);
  console.log(`B (collectLog false keeps the metering row): ${checkB ? 'pass' : 'fail'}`);
  console.log(
    checkA
      ? 'Keep the binding mapping for metadata in platform/packages/proxy/src/ai-logging.ts.'
      : 'Change binding metadata to { collectLog: false, payload: false } in platform/packages/proxy/src/ai-logging.ts.',
  );
  process.exitCode = checkA && checkB && results.every(({ pass }) => pass) ? 0 : 1;
}

await main();
