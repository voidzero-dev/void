/**
 * Security audits Phase 0 spike S9 (local part): refusal mapping on recorded fixtures.
 *
 * What it runs (design doc 0095 "Phase 0 spikes", spec §20 S9, §8.4):
 *   - Each fixture in `fixtures/security-refusals.json` goes through the real scanner
 *     runner (`runScan`: phases, the engine, status.json) with the real engine code:
 *     Engine B (`void-loop.ts`) on a scripted model, Engine A (`claude.ts`) and Engine C
 *     (`codex.ts`) on a stand-in SDK that yields the fixture's messages or events. The
 *     status.json the runner wrote then goes through the real API ingest rules
 *     (`parseRunnerStatus`, `securityScanOutcome`, `shouldRetrySecurityScan`).
 *   - Proxy chains: a provider refusal sent through the real model proxy
 *     (`handleSecurityModelRequest`), then into the engine as the CLI would show it
 *     (wording recorded in S2/S3 and read from the local Claude Code / Codex binaries).
 *
 * Pass (spec §20 S9, mapping part): every `refusal` fixture ends `refused`, and no
 * `refusal` or `unsignalled` fixture ends `succeeded`; controls end as expected.
 * `risk` fixtures (a refusal that looks like a clean report) are listed, not counted.
 * Live refusal rates (10 runs × 4 third-party models) need Unified Billing credits.
 *
 * Run (from the repo root): node platform/scripts/security-spike-refusals.ts [--out report.json]
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  finishSpike,
  REPO,
  relaunchWithLocalLoader,
  type SpikeCheck,
} from './security-spike-local.ts';

relaunchWithLocalLoader(import.meta.url);

const { runScan } = await import('../packages/security-scanner/src/runner/run.ts');
const { createVoidLoopEngine } =
  await import('../packages/security-scanner/src/runner/engines/void-loop.ts');
const { createClaudeEngine } =
  await import('../packages/security-scanner/src/runner/engines/claude.ts');
const { createCodexEngine } =
  await import('../packages/security-scanner/src/runner/engines/codex.ts');
const proxy = await import('../packages/api/src/security/model-proxy.ts');
const ledger = await import('../packages/api/src/security/call-ledger.ts');
const ingest = await import('../packages/api/src/security/ingest.ts');
const policyModule = await import('../../packages/platform/src/security-policy.ts');
const models = await import('../../packages/platform/src/security-models.ts');

type Fixture = {
  id: string;
  engine: 'void_loop' | 'agent_sdk' | 'codex_sdk';
  kind: 'refusal' | 'unsignalled' | 'control' | 'risk';
  expect?: string;
  expectCategory?: string;
  source: string;
  replies?: Array<{ json?: unknown; binding?: unknown }>;
  messages?: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
  report?: unknown;
  proxyFailure?: { reason: string; httpStatus: number };
};

const MODEL_FOR: Record<Fixture['engine'], string> = {
  void_loop: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
  agent_sdk: 'anthropic/claude-opus-5.5',
  codex_sdk: 'openai/gpt-6.1-terra',
};
const BASE_URL = 'http://model.void.internal';

// ---------------------------------------------------------------------------
// One fixture through the runner and the ingest rules
// ---------------------------------------------------------------------------

type Mapped = {
  runner: {
    status: string;
    reason: string | null;
    error_class: string | null;
    refusal_category: string | null;
  };
  scan: {
    status: string;
    reason: string | null;
    failureCause: string | null;
    refusalCategory: string | null;
  };
  retried: boolean;
};

/** A fetch that answers the proxy's `last-failure` route: nothing before, `after` after. */
function lastFailureFetch(after: { reason: string; httpStatus: number } | null) {
  let calls = 0;
  return async (input: string | URL | Request): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/v1/void/last-failure')) {
      calls++;
      const failure = calls === 1 || after === null ? null : { ...after, at: 1000 + calls };
      return Response.json({ failure });
    }
    return new Response('not expected', { status: 500 });
  };
}

async function runFixture(fixture: Fixture, work: string): Promise<Mapped> {
  const root = mkdtempSync(join(work, `${fixture.id}-`));
  mkdirSync(join(root, 'input'), { recursive: true });
  mkdirSync(join(root, 'memory'), { recursive: true });
  writeFileSync(
    join(root, 'input', 'app.ts'),
    'export default { fetch() { return new Response("ok"); } };\n',
  );
  writeFileSync(
    join(root, 'task.json'),
    JSON.stringify({
      version: 1,
      scan_id: 'ss_s9',
      attempt: 1,
      engine: fixture.engine,
      model: MODEL_FOR[fixture.engine],
      tier: 'full',
      changed_files: [],
    }),
  );
  const home = join(root, 'home');
  mkdirSync(home);

  const status = await runScan({
    root,
    baseUrl: BASE_URL,
    retryDelayMs: 0,
    engineFactory: (task, context) => {
      if (fixture.engine === 'void_loop') {
        const replies = [...(fixture.replies ?? [])];
        return createVoidLoopEngine({
          model: task.model,
          tools: context.tools,
          baseUrl: BASE_URL,
          retryDelayMs: 0,
          fetch: async () => {
            const next = replies.shift();
            if (!next) {
              return new Response('no scripted reply', { status: 500 });
            }
            const body =
              next.binding !== undefined
                ? proxy.asChatCompletion(task.model, next.binding)
                : next.json;
            return Response.json(body);
          },
        });
      }
      if (fixture.engine === 'agent_sdk') {
        return createClaudeEngine({
          model: task.model,
          root,
          baseUrl: BASE_URL,
          configBase: home,
          fetch: lastFailureFetch(fixture.proxyFailure ?? null) as typeof fetch,
          loadSdk: async () => ({
            query: ({ options }: { options: Record<string, unknown> }) =>
              (async function* () {
                // Claude Code runs the PreToolUse hook before each tool call.
                const hooks = options.hooks as {
                  PreToolUse: Array<{
                    hooks: Array<(input: Record<string, unknown>) => Promise<unknown>>;
                  }>;
                };
                const hook = hooks.PreToolUse[0]!.hooks[0]!;
                for (const message of fixture.messages ?? []) {
                  const inner = message.message as { content?: unknown } | undefined;
                  for (const block of Array.isArray(inner?.content) ? inner.content : []) {
                    const part = block as { type?: string; name?: string; input?: unknown };
                    if (part.type === 'tool_use') {
                      await hook({ tool_name: part.name, tool_input: part.input });
                    }
                  }
                  yield message as { type: string };
                }
              })(),
          }),
        });
      }
      return createCodexEngine({
        model: task.model,
        root,
        baseUrl: `${BASE_URL}/v1`,
        image: { homeBase: home },
        fetch: lastFailureFetch(fixture.proxyFailure ?? null) as typeof fetch,
        loadSdk: async () => ({
          Codex: class {
            private readonly config: Record<string, unknown>;
            constructor(options: { config: Record<string, unknown> }) {
              this.config = options.config;
            }
            startThread() {
              const config = this.config;
              return {
                runStreamed: async () => {
                  if (fixture.report !== undefined) {
                    // What the void-scan MCP server writes when submit_findings is accepted.
                    const servers = config.mcp_servers as Record<string, { args: Array<string> }>;
                    const args = servers['void-scan']!.args;
                    writeFileSync(args[args.indexOf('--out') + 1]!, JSON.stringify(fixture.report));
                  }
                  return {
                    events: (async function* () {
                      for (const event of fixture.events ?? []) {
                        yield event as { type: string };
                      }
                    })(),
                  };
                },
              };
            }
          },
        }),
      });
    },
  });
  const findingsText = readFileSync(join(root, 'out', 'findings.json'), 'utf8');
  const parsed = ingest.parseRunnerStatus(status, 'ss_s9', 1);
  const outcome = ingest.securityScanOutcome(parsed, ingest.parseFindingsReport(findingsText));
  rmSync(root, { recursive: true, force: true });
  return {
    runner: {
      status: status.status,
      reason: status.reason,
      error_class: status.error_class,
      refusal_category: status.refusal_category,
    },
    scan: {
      status: outcome.status,
      reason: outcome.reason,
      failureCause: outcome.failureCause,
      refusalCategory: outcome.refusalCategory,
    },
    retried: ingest.shouldRetrySecurityScan(parsed, 1),
  };
}

// ---------------------------------------------------------------------------
// The real model proxy with in-memory parts (call ledger is the real code)
// ---------------------------------------------------------------------------

function memoryStorage() {
  const data = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
    },
    delete: async (keys: string | Array<string>) => {
      const list = Array.isArray(keys) ? keys : [keys];
      let count = 0;
      for (const key of list) {
        count += data.delete(key) ? 1 : 0;
      }
      return Array.isArray(keys) ? count : count > 0;
    },
    list: async ({ prefix }: { prefix?: string }) =>
      new Map([...data].filter(([key]) => !prefix || key.startsWith(prefix))),
  };
}

function proxyFor(model: string, upstream: (request: Request) => Promise<Response>) {
  const storage = memoryStorage();
  const policy = {
    ...policyModule.defaultSecurityPolicy(),
    mode: 'all' as const,
    entitlement: {
      checkedAt: new Date().toISOString(),
      ok: true,
      missing: [],
      hosts: { openai: true, anthropic: true },
    },
  };
  const scan = {
    scanId: 'ss_s9',
    projectId: 'proj_s9',
    status: 'running',
    attempt: 1,
    leaseUntil: new Date(Date.now() + 3_600_000).toISOString(),
    projectStatus: 'active',
    modelUsed: model,
    modelCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    projectNoticeVersion: models.SECURITY_PROVIDER_NOTICE_VERSION,
    monthlyCapCents: null,
    capCeilingCents: null,
  };
  const deps = {
    now: () => Date.now(),
    sleep: async () => undefined,
    loadScan: async () => scan,
    readPolicy: async () => policy,
    admit: (input: Parameters<typeof ledger.admitModelCall>[1]) =>
      ledger.admitModelCall(storage as never, input),
    recordFailure: (
      scanId: string,
      attempt: number,
      failure: Parameters<typeof ledger.recordModelCallFailure>[3],
    ) => ledger.recordModelCallFailure(storage as never, scanId, attempt, failure),
    lastFailure: (scanId: string, attempt: number) =>
      ledger.readModelCallFailure(storage as never, scanId, attempt),
    rateLimited: async () => undefined,
    hold: async (input: { worstNano: number }) => ({
      ok: true as const,
      month: '2026-11',
      holdNano: input.worstNano,
      modelCalls: 1,
    }),
    settle: async () => ({ projectSpentNano: 0, platformSpentNano: 0 }),
    scanTag: async () => 'spike-tag',
    gatewayId: 'spike-gateway',
    accountId: 'spike-account',
    apiToken: 'spike-token-not-real',
    ai: undefined,
    fetch: (async (input: string | URL | Request, init?: RequestInit) =>
      upstream(new Request(input, init))) as typeof fetch,
  };
  return {
    call: (request: Request) =>
      proxy.handleSecurityModelRequest(deps as never, 'ss_s9', 1, request),
    lastFailure: () => ledger.readModelCallFailure(storage as never, 'ss_s9', 1),
  };
}

function sse(events: Array<{ event?: string; data: unknown }>): string {
  return events
    .map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${JSON.stringify(e.data)}\n\n`)
    .join('');
}

type Chain = { fixture: Fixture; proxySaw: Record<string, unknown> };

/** Provider refusals sent through the real proxy, turned into what each CLI shows. */
async function proxyChains(): Promise<Array<Chain>> {
  const chains: Array<Chain> = [];
  const responsesBody = JSON.stringify({ model: 'gpt-6.1-terra', input: [], stream: true });

  // P1: OpenAI answers HTTP 400 with code cyber_policy before streaming.
  {
    const upstreamError = {
      error: {
        message: 'This request has been flagged for potentially high-risk cybersecurity activity.',
        type: 'invalid_request_error',
        code: 'cyber_policy',
      },
    };
    const p = proxyFor('openai/gpt-6.1-terra', async () =>
      Response.json(upstreamError, { status: 400 }),
    );
    const answer = await p.call(
      new Request(`${BASE_URL}/v1/responses`, { method: 'POST', body: responsesBody }),
    );
    const text = await answer.text();
    const failure = await p.lastFailure();
    chains.push({
      proxySaw: {
        upstream: { status: 400, code: 'cyber_policy' },
        proxyAnswer: { status: answer.status, body: text },
        lastFailure: failure,
        codeReachesEngine: text.includes('cyber_policy'),
      },
      fixture: {
        id: 'P1-openai-400-cyber-policy-via-proxy',
        engine: 'codex_sdk',
        kind: 'refusal',
        source:
          'proxy answer recorded here; Codex wording `unexpected status <code> <reason>: <body>` recorded in S3 (402 case)',
        proxyFailure: failure
          ? { reason: failure.reason, httpStatus: failure.httpStatus }
          : undefined,
        events: [
          {
            type: 'turn.failed',
            error: { message: `unexpected status ${answer.status} Bad Request: ${text}` },
          },
        ],
      },
    });
  }

  // P2: OpenAI fails the stream with response.failed / cyber_policy.
  {
    const stream = sse([
      { event: 'response.created', data: { type: 'response.created', response: { id: 'r1' } } },
      {
        event: 'response.failed',
        data: {
          type: 'response.failed',
          response: {
            id: 'r1',
            status: 'failed',
            error: {
              code: 'cyber_policy',
              message:
                'This request has been flagged for potentially high-risk cybersecurity activity.',
            },
          },
        },
      },
    ]);
    const p = proxyFor(
      'openai/gpt-6.1-terra',
      async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    );
    const answer = await p.call(
      new Request(`${BASE_URL}/v1/responses`, { method: 'POST', body: responsesBody }),
    );
    const text = await answer.text();
    chains.push({
      proxySaw: {
        upstream: 'SSE response.failed code cyber_policy',
        proxyAnswer: { status: answer.status, streamIntact: text === stream },
        codeReachesEngine: text.includes('cyber_policy'),
      },
      fixture: {
        id: 'P2-openai-stream-cyber-policy-via-proxy',
        engine: 'codex_sdk',
        kind: 'refusal',
        source:
          'proxy stream recorded here; Codex turns a cyber_policy failure into `cyber policy: <message>` (codex-cli 0.162.1 strings) and `codex exec --json` keeps only that message',
        events: [
          {
            type: 'turn.failed',
            error: {
              message:
                'cyber policy: This request has been flagged for potentially high-risk cybersecurity activity.',
            },
          },
        ],
      },
    });
  }

  // P3: Anthropic streams a refusal (stop_reason refusal, stop_details.category cyber).
  {
    const stream = sse([
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: 'm1',
            role: 'assistant',
            model: 'claude-opus-5.5',
            content: [],
            usage: { input_tokens: 1200, output_tokens: 0 },
          },
        },
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } },
          usage: { output_tokens: 0 },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const p = proxyFor(
      'anthropic/claude-opus-5.5',
      async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    );
    const answer = await p.call(
      new Request(`${BASE_URL}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-opus-5.5',
          max_tokens: 1000,
          messages: [],
          stream: true,
        }),
      }),
    );
    const text = await answer.text();
    chains.push({
      proxySaw: {
        upstream: 'SSE message_delta stop_reason refusal, category cyber',
        proxyAnswer: { status: answer.status, streamIntact: text === stream },
        refusalReachesEngine: text.includes('"stop_reason":"refusal"'),
      },
      fixture: {
        id: 'P3-anthropic-stream-refusal-via-proxy',
        engine: 'agent_sdk',
        kind: 'refusal',
        expectCategory: 'cyber',
        source: 'proxy stream recorded here; SDK messages as in A1 (Claude Code 2.1.328 schema)',
        messages: [
          {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [],
              stop_reason: 'refusal',
              stop_details: { type: 'refusal', category: 'cyber' },
            },
          },
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            num_turns: 1,
            result: '',
            stop_reason: 'refusal',
          },
        ],
      },
    });
  }
  return chains;
}

// ---------------------------------------------------------------------------

function judge(fixture: Fixture, mapped: Mapped): { ok: boolean; why: string } {
  const final = mapped.scan.status;
  switch (fixture.kind) {
    case 'refusal': {
      if (final !== 'refused') {
        return {
          ok: false,
          why: `refusal ended ${final}${mapped.scan.reason ? ` (${mapped.scan.reason})` : ''}`,
        };
      }
      if (fixture.expectCategory && mapped.scan.refusalCategory !== fixture.expectCategory) {
        return {
          ok: false,
          why: `refused, but category ${JSON.stringify(mapped.scan.refusalCategory)} (expected ${fixture.expectCategory})`,
        };
      }
      return { ok: true, why: 'refused' };
    }
    case 'unsignalled':
      return final === 'succeeded'
        ? { ok: false, why: 'a refusal counted as succeeded' }
        : {
            ok: true,
            why: `not succeeded (${final}${mapped.scan.reason ? ` ${mapped.scan.reason}` : ''})`,
          };
    case 'control': {
      const got =
        mapped.scan.reason && final !== 'succeeded' ? `${final}:${mapped.scan.reason}` : final;
      return got === fixture.expect
        ? { ok: true, why: got }
        : { ok: false, why: `expected ${fixture.expect}, got ${got}` };
    }
    case 'risk':
      return { ok: true, why: `known risk: ends ${final}` };
  }
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  const file = JSON.parse(
    readFileSync(join(REPO, 'platform/scripts/fixtures/security-refusals.json'), 'utf8'),
  ) as { fixtures: Array<Fixture> };
  const chains = await proxyChains();
  const all: Array<{ fixture: Fixture; proxySaw?: Record<string, unknown> }> = [
    ...file.fixtures.map((fixture) => ({ fixture })),
    ...chains,
  ];
  const work = mkdtempSync(join(tmpdir(), 'void-spike-s9-'));
  const rows: Array<Record<string, unknown>> = [];
  const checks: Array<SpikeCheck> = [];
  try {
    for (const { fixture, proxySaw } of all) {
      const mapped = await runFixture(fixture, work);
      const verdict = judge(fixture, mapped);
      rows.push({
        id: fixture.id,
        engine: fixture.engine,
        kind: fixture.kind,
        source: fixture.source,
        ...(proxySaw ? { proxy: proxySaw } : {}),
        runner: mapped.runner,
        scan: mapped.scan,
        retriedAsInfrastructure: mapped.retried,
        ok: verdict.ok,
        why: verdict.why,
      });
      if (fixture.kind !== 'risk') {
        checks.push({ name: `${fixture.id}: ${verdict.why}`, ok: verdict.ok });
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const byKind = (kind: Fixture['kind']) => rows.filter((row) => row.kind === kind);
  const refusals = byKind('refusal');
  const refused = refusals.filter(
    (row) => (row.scan as Mapped['scan']).status === 'refused',
  ).length;
  const succeededAmongRefusals = [...refusals, ...byKind('unsignalled')].filter(
    (row) => (row.scan as Mapped['scan']).status === 'succeeded',
  ).length;
  const perEngine = Object.fromEntries(
    (['void_loop', 'agent_sdk', 'codex_sdk'] as const).map((engine) => {
      const list = refusals.filter((row) => row.engine === engine);
      return [
        engine,
        {
          refusals: list.length,
          refused: list.filter((row) => (row.scan as Mapped['scan']).status === 'refused').length,
        },
      ];
    }),
  );
  const report = {
    summary: {
      refusalFixtures: refusals.length,
      mappedRefused: refused,
      refusedShare: refusals.length === 0 ? null : Number((refused / refusals.length).toFixed(3)),
      refusalsCountedSucceeded: succeededAmongRefusals,
      unsignalled: byKind('unsignalled').map((row) => ({ id: row.id, ends: row.scan })),
      risks: byKind('risk').map((row) => ({
        id: row.id,
        ends: (row.scan as Mapped['scan']).status,
      })),
      perEngine,
      liveRates:
        'BLOCKED: needs Unified Billing credits for anthropic/* and openai/* (see S2/S3 notes)',
    },
    fixtures: rows,
  };
  if (values.out) {
    writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  finishSpike('S9 refusal mapping', report, checks);
}

await main();
