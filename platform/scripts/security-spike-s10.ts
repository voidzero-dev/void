/**
 * Security audits Phase 0 spike S10: what the AI Gateway keeps for scan model calls.
 *
 * What it runs (plan "Phase 0 spikes" S10), all on the REST route the platform uses
 * (`/ai/v1/*` with `cf-aig-gateway-id`) plus one provider-native call
 * (`gateway.ai.cloudflare.com/.../compat/chat/completions`):
 *   - Makes sure gateway `void-spike-sa-gw` exists with logs off (`collect_logs: false`)
 *     and cache off (`cache_ttl: 0`); records what was sent and what reads back.
 *   - Calls a cheap `@cf` model (default `@cf/zai-org/glm-5.3-flash`, a few dozen tokens
 *     each) twice per case with the same body, and reads `cf-aig-cache-status`:
 *       scan       the proxy's headers (payload off, skip cache, `securityScan` metadata)
 *       plain      no cf-aig header (gateway defaults only)
 *       callerTtl  a caller-sent `cf-aig-cache-ttl: 60` (what a container could ask for if
 *                  the proxy passed `cf-aig-*` through)
 *       native     the provider-native endpoint with `cf-aig-authorization`
 *       control    payload logging forced on (`cf-aig-collect-log: true`), so an empty read
 *                  below means "not kept", not "the logs API is broken"
 *   - One call each to the third-party models (`anthropic/...` on Messages, `openai/...` on
 *     Responses) with the scan headers: answered or refused for credits, both are logged
 *     for Unified Billing.
 *   - --log-ids: also inspects log entries of earlier calls (the S2/S3 --local-gateway runs).
 *   - Polls the logs API for every `cf-aig-log-id`, then reads each entry's metadata, and
 *     its stored request and response bodies (only sizes and status are reported).
 *   - Deletes `void-spike-sa-gw` unless --keep and lists gateways afterwards.
 * Not covered: the Worker binding path (`env.AI.run`), which needs a deployed Worker.
 *
 * Run (from the repo root):
 *   NODE_USE_SYSTEM_CA=1 node platform/scripts/security-spike-s10.ts [--keep]
 *   Reads CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN, else ~/.config/void-spike/cf-ai-account
 *   and cf-ai-token (VOID_SPIKE_CREDENTIALS_DIR). The token needs Workers AI Read and
 *   AI Gateway Edit. Only `void-spike-sa-gw` is created or deleted.
 *
 * Pass: no scan call is cached or served from cache, no scan call has a stored body, the
 * control call does (the read works), and the gateway is gone afterwards. Prints one JSON
 * report and a PASS/FAIL line; exits 1 on FAIL.
 */
import { parseArgs } from 'node:util';
import { cfApi } from './security-spike-s1.ts';
import type { SpikeEnv } from './security-spike-s1.ts';
import { GATEWAY_ID, readAiGatewayEnv } from './security-spike-s2.ts';

export const GATEWAY_SETTINGS = {
  id: GATEWAY_ID,
  collect_logs: false,
  cache_ttl: 0,
  cache_invalidate_on_update: false,
  rate_limiting_interval: 0,
  rate_limiting_limit: 0,
  rate_limiting_technique: 'fixed',
};

/** The settings that decide what the gateway keeps, as read back. */
const KEPT_FIELDS = [
  'collect_logs',
  'cache_ttl',
  'cache_invalidate_on_update',
  'logpush',
  'log_classification',
  'log_management',
  'log_management_strategy',
  'authentication',
  'zdr',
  'workers_ai_billing_mode',
  'retry_max_attempts',
];

export async function ensureGateway(env: SpikeEnv) {
  const existing = await cfApi<Record<string, unknown>>(env, `/ai-gateway/gateways/${GATEWAY_ID}`);
  let created = false;
  let result = existing.result;
  if (!existing.ok) {
    const create = await cfApi<Record<string, unknown>>(env, '/ai-gateway/gateways', {
      method: 'POST',
      body: JSON.stringify(GATEWAY_SETTINGS),
    });
    if (!create.ok) {
      throw new Error(`gateway create failed: ${create.status} ${JSON.stringify(create.errors)}`);
    }
    created = true;
    result = create.result;
  }
  const readBack = Object.fromEntries(KEPT_FIELDS.map((name) => [name, result?.[name]]));
  return { created, sent: GATEWAY_SETTINGS, readBack };
}

const SCAN_HEADERS = (scanId: string) => ({
  'cf-aig-gateway-id': GATEWAY_ID,
  'cf-aig-collect-log-payload': 'false',
  'cf-aig-skip-cache': 'true',
  'cf-aig-metadata': JSON.stringify({ securityScan: scanId }),
});

type CallResult = {
  case: string;
  status: number;
  ms: number;
  cacheStatus: string | null;
  logId: string | null;
  usage?: unknown;
  error?: string;
};

async function call(
  env: SpikeEnv,
  name: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<CallResult> {
  const started = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: { usage?: unknown } = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  return {
    case: name,
    status: response.status,
    ms: Date.now() - started,
    cacheStatus: response.headers.get('cf-aig-cache-status'),
    logId: response.headers.get('cf-aig-log-id'),
    usage: parsed.usage,
    error: response.ok ? undefined : text.replaceAll(env.accountId, '<account>').slice(0, 300),
  };
}

type LogEntry = Record<string, unknown> & { id: string };

async function listLogs(env: SpikeEnv): Promise<Array<LogEntry>> {
  const logs: Array<LogEntry> = [];
  for (let page = 1; page <= 5; page++) {
    const listed = await cfApi<Array<LogEntry>>(
      env,
      `/ai-gateway/gateways/${GATEWAY_ID}/logs?per_page=50&page=${page}`,
    );
    if (!listed.ok) {
      throw new Error(`logs list failed: ${listed.status} ${JSON.stringify(listed.errors)}`);
    }
    logs.push(...(listed.result ?? []));
    if ((listed.result ?? []).length < 50) {
      break;
    }
  }
  return logs;
}

/** Status and size of a stored body; the content itself is never reported. */
async function storedBody(env: SpikeEnv, logId: string, part: 'request' | 'response') {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.accountId}/ai-gateway/gateways/${GATEWAY_ID}/logs/${logId}/${part}`,
    { headers: { Authorization: `Bearer ${env.token}` } },
  );
  const text = await response.text();
  let empty = text.length === 0;
  try {
    const parsed = JSON.parse(text) as { result?: unknown; success?: boolean };
    if ('result' in parsed || 'success' in parsed) {
      empty = parsed.result === null || parsed.result === undefined || parsed.result === '';
    }
  } catch {
    // raw body
  }
  return { status: response.status, bytes: text.length, hasBody: response.ok && !empty };
}

async function main() {
  const { values } = parseArgs({
    options: {
      keep: { type: 'boolean', default: false },
      'cf-model': { type: 'string', default: '@cf/zai-org/glm-5.3-flash' },
      'anthropic-model': { type: 'string', default: 'anthropic/claude-sonnet-5.5' },
      'openai-model': { type: 'string', default: 'openai/gpt-6.1-terra' },
      'log-wait-s': { type: 'string', default: '120' },
      // Log ids from earlier runs on the same gateway (S2/S3 --local-gateway --keep).
      'log-ids': { type: 'string', default: '' },
    },
  });
  const env = readAiGatewayEnv();
  const report: Record<string, unknown> = { spike: 'S10', gatewayId: GATEWAY_ID };
  const failures: Array<string> = [];
  const scanId = `spike-s10-${crypto.randomUUID().slice(0, 8)}`;
  report.scanId = scanId;
  try {
    report.gateway = await ensureGateway(env);
    const readBack = (report.gateway as { readBack: Record<string, unknown> }).readBack;
    if (readBack.collect_logs !== false || readBack.cache_ttl !== 0) {
      failures.push(`gateway settings not as sent: ${JSON.stringify(readBack)}`);
    }
    const rest = `https://api.cloudflare.com/client/v4/accounts/${env.accountId}/ai/v1`;
    const auth = { Authorization: `Bearer ${env.token}` };
    // A nonce per run, so no earlier run's entry can answer.
    const nonce = crypto.randomUUID().slice(0, 8);
    const chat = (model: string) => ({
      model,
      max_tokens: 24,
      messages: [{ role: 'user', content: `Reply with the word ok. (${nonce})` }],
    });
    const cases: Array<[string, string, Record<string, string>, unknown]> = [
      [
        'scan',
        `${rest}/chat/completions`,
        { ...auth, ...SCAN_HEADERS(scanId) },
        chat(values['cf-model']),
      ],
      [
        'plain',
        `${rest}/chat/completions`,
        { ...auth, 'cf-aig-gateway-id': GATEWAY_ID },
        chat(values['cf-model']),
      ],
      [
        'callerTtl',
        `${rest}/chat/completions`,
        { ...auth, 'cf-aig-gateway-id': GATEWAY_ID, 'cf-aig-cache-ttl': '60' },
        chat(values['cf-model']),
      ],
      [
        'native',
        `https://gateway.ai.cloudflare.com/v1/${env.accountId}/${GATEWAY_ID}/compat/chat/completions`,
        {
          'cf-aig-authorization': `Bearer ${env.token}`,
          'cf-aig-collect-log-payload': 'false',
          'cf-aig-skip-cache': 'true',
          'cf-aig-metadata': JSON.stringify({ securityScan: scanId }),
        },
        chat(`workers-ai/${values['cf-model']}`),
      ],
      [
        'control',
        `${rest}/chat/completions`,
        {
          ...auth,
          'cf-aig-gateway-id': GATEWAY_ID,
          'cf-aig-collect-log': 'true',
          'cf-aig-collect-log-payload': 'true',
          'cf-aig-skip-cache': 'true',
        },
        chat(values['cf-model']),
      ],
    ];
    const calls: Array<CallResult> = [];
    for (const [name, url, headers, body] of cases) {
      const repeats = name === 'control' ? 1 : 2;
      for (let index = 0; index < repeats; index++) {
        calls.push(await call(env, `${name}#${index + 1}`, url, headers, body));
      }
    }
    calls.push(
      await call(
        env,
        'anthropic',
        `${rest}/messages`,
        { ...auth, ...SCAN_HEADERS(scanId) },
        {
          model: values['anthropic-model'],
          max_tokens: 16,
          messages: [{ role: 'user', content: `Say ok (${nonce})` }],
        },
      ),
      await call(
        env,
        'openai',
        `${rest}/responses`,
        { ...auth, ...SCAN_HEADERS(scanId) },
        {
          model: values['openai-model'],
          input: `Say ok (${nonce})`,
          max_output_tokens: 16,
          access_programs: { cyber: 'standard' },
        },
      ),
    );
    for (const id of values['log-ids'].split(',').filter(Boolean)) {
      calls.push({ case: 'earlier-run', status: 0, ms: 0, cacheStatus: null, logId: id });
    }
    report.calls = calls;
    for (const result of calls) {
      if (
        ['callerTtl', 'anthropic', 'openai', 'earlier-run'].some((name) =>
          result.case.startsWith(name),
        )
      ) {
        continue;
      }
      if (result.status !== 200) {
        failures.push(`${result.case}: HTTP ${result.status} ${result.error ?? ''}`);
      }
      if (result.cacheStatus === 'HIT') {
        failures.push(`${result.case}: served from cache`);
      }
    }
    const callerTtlHit = calls.some((c) => c.case === 'callerTtl#2' && c.cacheStatus === 'HIT');
    report.callerCacheTtlTurnsCacheOn = callerTtlHit;
    // Logs land a little after the answer: poll until every log id shows or the wait ends.
    const wanted = new Set(calls.flatMap((c) => (c.logId ? [c.logId] : [])));
    const deadline = Date.now() + Number(values['log-wait-s']) * 1000;
    let logs: Array<LogEntry> = [];
    for (;;) {
      logs = await listLogs(env);
      const seen = new Set(logs.map((l) => l.id));
      if ([...wanted].every((id) => seen.has(id)) || Date.now() > deadline) {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 10_000);
      });
    }
    const byId = new Map(logs.map((l) => [l.id, l]));
    const entries: Array<Record<string, unknown>> = [];
    for (const result of calls) {
      const log = result.logId ? byId.get(result.logId) : undefined;
      const entry: Record<string, unknown> = { case: result.case, logged: Boolean(log) };
      if (log && result.logId) {
        entry.fields = Object.keys(log).sort();
        entry.metadata = log.metadata;
        entry.cost = log.cost;
        entry.cached = log.cached;
        entry.tokensIn = log.tokens_in;
        entry.tokensOut = log.tokens_out;
        entry.model = log.model;
        entry.provider = log.provider;
        entry.statusCode = log.status_code;
        entry.request = await storedBody(env, result.logId, 'request');
        entry.response = await storedBody(env, result.logId, 'response');
      }
      entries.push(entry);
    }
    report.logs = { total: logs.length, entries };
    for (const entry of entries) {
      const stored =
        (entry.request as { hasBody?: boolean } | undefined)?.hasBody ||
        (entry.response as { hasBody?: boolean } | undefined)?.hasBody;
      if (String(entry.case).startsWith('control')) {
        if (!entry.logged || !stored) {
          failures.push(
            `control call has no stored body, so the read proves nothing: ${JSON.stringify(entry)}`,
          );
        }
      } else if (stored) {
        failures.push(`${entry.case}: body stored with payload logging off`);
      }
      if (entry.cached === true && !String(entry.case).startsWith('callerTtl')) {
        failures.push(`${entry.case}: log says cached`);
      }
    }
  } catch (error) {
    failures.push(String(error instanceof Error ? (error.stack ?? error.message) : error));
  } finally {
    if (!values.keep) {
      const deleted = await cfApi(env, `/ai-gateway/gateways/${GATEWAY_ID}`, { method: 'DELETE' });
      const after = await cfApi<Array<{ id: string }>>(env, '/ai-gateway/gateways?per_page=50');
      const left = (after.result ?? [])
        .map((g) => g.id)
        .filter((id) => id.startsWith('void-spike-sa-'));
      report.cleanup = {
        deleteStatus: deleted.status,
        listStatus: after.status,
        gatewaysAfter: (after.result ?? []).map((g) => g.id),
      };
      if (!after.ok || left.length > 0) {
        failures.push(`leftover spike gateways: ${JSON.stringify(left)}`);
      }
    }
  }
  report.failures = failures;
  console.log(JSON.stringify(report, null, 2));
  console.log(failures.length ? 'S10 FAIL' : 'S10 PASS');
  process.exitCode = failures.length ? 1 : 0;
}

if (import.meta.main) {
  await main();
}
