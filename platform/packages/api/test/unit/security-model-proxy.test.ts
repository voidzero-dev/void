import { securityModelCostNanoUsd } from '@void/platform/security-models';
import { defaultSecurityPolicy, type SecurityPolicy } from '@void/platform/security-policy';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { SecurityCallHold, SecurityCallRefusal } from '../../src/security/budget.ts';
import type { AdmitModelCallResult, ModelCallFailure } from '../../src/security/call-ledger.ts';
import {
  allowedAnthropicBetas,
  asChatCompletion,
  billedInputTokens,
  clampCallOutput,
  handleSecurityModelRequest,
  providerPolicyCode,
  readModelUsage,
  SECURITY_DEFAULT_CALL_OUTPUT_TOKENS,
  SECURITY_MODEL_FAILURE_PATH,
  SECURITY_MODEL_MAX_REQUEST_BYTES,
  SECURITY_RATE_WAIT_LIMIT_MS,
  SECURITY_STOP_HEADER,
  SseUsageReader,
  type SecurityModelProxyDeps,
  type SecurityModelScan,
  workersAiErrorStatus,
  gatewayModelName,
} from '../../src/security/model-proxy.ts';

// The runner's own mapping, so a proxy stop is checked end to end (spec §8.4). A
// variable path keeps the runner package out of this package's type check.
const RUNNER_STATUS = '../../../security-scanner/src/runner/status.ts';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const CF = '@cf/zai-org/glm-5.3';
const OPUS = 'anthropic/claude-opus-5.5';
const TERRA = 'openai/gpt-6.1-terra';

type Harness = {
  deps: SecurityModelProxyDeps;
  scan: { value: SecurityModelScan | undefined };
  policy: { value: SecurityPolicy };
  failures: Array<ModelCallFailure>;
  holds: Array<Parameters<SecurityModelProxyDeps['hold']>[0]>;
  settles: Array<Parameters<SecurityModelProxyDeps['settle']>[0]>;
  settleError: { value: Error | null };
  admit: ReturnType<typeof vi.fn>;
  rateLimited: ReturnType<typeof vi.fn>;
  hold: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  aiRun: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
  clock: { now: number };
};

function scanRow(overrides: Partial<SecurityModelScan> = {}): SecurityModelScan {
  return {
    scanId: 'ss_1',
    projectId: 'proj_1',
    status: 'running',
    attempt: 2,
    leaseUntil: '2026-11-18T13:00:00.000Z',
    projectStatus: 'active',
    modelUsed: CF,
    modelCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    projectNoticeVersion: 1,
    monthlyCapCents: null,
    capCeilingCents: null,
    planCap: 'inherit',
    ...overrides,
  };
}

function onPolicy(overrides: Partial<SecurityPolicy> = {}): SecurityPolicy {
  return {
    ...defaultSecurityPolicy(),
    mode: 'all',
    entitlement: {
      checkedAt: '2026-11-18T11:00:00.000Z',
      ok: true,
      missing: [],
      hosts: { openai: true, anthropic: true },
    },
    ...overrides,
  };
}

function harness(): Harness {
  const clock = { now: NOW };
  const scan = { value: scanRow() as SecurityModelScan | undefined };
  const policy = { value: onPolicy() };
  const failures: Array<ModelCallFailure> = [];
  const holds: Harness['holds'] = [];
  const settles: Harness['settles'] = [];
  const settleError: Harness['settleError'] = { value: null };
  const admit = vi.fn(async (): Promise<AdmitModelCallResult> => ({
    ok: true,
    sessionCalls: null,
  }));
  const hold = vi.fn(
    async (
      input: Parameters<SecurityModelProxyDeps['hold']>[0],
    ): Promise<SecurityCallHold | SecurityCallRefusal> => {
      holds.push(input);
      return { ok: true, month: '2026-11-01', holdNano: input.worstNano, modelCalls: 1 };
    },
  );
  const fetch = vi.fn(async () => Response.json({}));
  const rateLimited = vi.fn(async () => {});
  const aiRun = vi.fn(async () => ({}) as unknown);
  const sleep = vi.fn(async (ms: number) => {
    clock.now += ms;
  });
  const deps: SecurityModelProxyDeps = {
    now: () => clock.now,
    sleep,
    loadScan: async () => scan.value,
    readPolicy: async () => policy.value,
    admit,
    recordFailure: async (_scanId, _attempt, failure) => {
      failures.push(failure);
    },
    lastFailure: async () => failures.at(-1) ?? null,
    rateLimited,
    hold,
    settle: async (input) => {
      settles.push(input);
      if (settleError.value) {
        throw settleError.value;
      }
      return { projectSpentNano: 0, platformSpentNano: 0 };
    },
    scanTag: async (scanId) => `${scanId}.signedtag`,
    gatewayId: 'void-gw',
    accountId: 'acct_1',
    apiToken: 'cf-token',
    ai: { run: aiRun } as unknown as Ai,
    fetch: fetch as unknown as typeof globalThis.fetch,
  };
  return {
    deps,
    scan,
    policy,
    failures,
    holds,
    settles,
    settleError,
    admit,
    rateLimited,
    hold,
    fetch,
    aiRun,
    sleep,
    clock,
  };
}

function call(
  h: Harness,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handleSecurityModelRequest(
    h.deps,
    'ss_1',
    2,
    new Request(`http://model.void.internal${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function chatBody(overrides: Record<string, unknown> = {}) {
  return { model: CF, messages: [{ role: 'user', content: 'scan' }], tools: [], ...overrides };
}

function sse(events: ReadonlyArray<unknown>): ReadableStream<Uint8Array> {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  // Split mid-line so the reader has to join chunks.
  const cut = Math.floor(bytes.length / 2);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, cut));
      controller.enqueue(bytes.slice(cut));
      controller.close();
    },
  });
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('Workers AI calls (@cf, Engine B)', () => {
  it('runs the binding with the fixed gateway options and the signed scan tag', async () => {
    h.aiRun.mockResolvedValue({
      response: 'ok',
      usage: { prompt_tokens: 1000, completion_tokens: 200 },
    });
    const response = await call(h, '/v1/chat/completions', chatBody());
    expect(response.status).toBe(200);
    expect(h.aiRun).toHaveBeenCalledTimes(1);
    const [model, inputs, options] = h.aiRun.mock.calls[0]!;
    expect(model).toBe(CF);
    expect(inputs).not.toHaveProperty('model');
    expect(inputs).toMatchObject({ max_tokens: SECURITY_DEFAULT_CALL_OUTPUT_TOKENS });
    expect(options).toEqual({
      gateway: {
        id: 'void-gw',
        skipCache: true,
        collectLog: true,
        metadata: { securityScan: 'ss_1.signedtag' },
      },
      extraHeaders: { 'cf-aig-collect-log-payload': 'false', 'cf-aig-skip-cache': 'true' },
    });
    expect(h.admit).toHaveBeenCalledWith(
      expect.objectContaining({ scanId: 'ss_1', attempt: 2, rateModel: CF, session: null }),
    );
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('meters tokens × list price and settles the hold to it', async () => {
    h.aiRun.mockResolvedValue({
      response: 'ok',
      usage: { prompt_tokens: 1000, completion_tokens: 200 },
    });
    await call(h, '/v1/chat/completions', chatBody());
    expect(h.holds).toHaveLength(1);
    expect(h.settles).toEqual([
      {
        scanId: 'ss_1',
        projectId: 'proj_1',
        month: '2026-11-01',
        holdNano: h.holds[0]!.worstNano,
        // $1.40 / M in, $4.40 / M out.
        actualNano: 1000 * 1400 + 200 * 4400,
        inputTokens: 1000,
        outputTokens: 200,
      },
    ]);
    expect(securityModelCostNanoUsd(CF, 1000, 200)).toBe(1000 * 1400 + 200 * 4400);
  });

  it('hands the month totals and caps to the cap alert after a settle, and survives its failure', async () => {
    const notices: Array<unknown> = [];
    let fail = false;
    const settled = { projectSpentNano: 80, platformSpentNano: 7 };
    h.deps = {
      ...h.deps,
      settle: async () => settled,
      notifyCaps: async (input) => {
        notices.push(input);
        if (fail) {
          throw new Error('db down');
        }
      },
    };
    h.aiRun.mockResolvedValue({
      response: 'ok',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    expect((await call(h, '/v1/chat/completions', chatBody())).status).toBe(200);
    expect(notices).toMatchObject([
      { projectId: 'proj_1', month: '2026-11-01', settlement: settled },
    ]);
    // A failed alert never fails the model call.
    fail = true;
    expect((await call(h, '/v1/chat/completions', chatBody())).status).toBe(200);
    expect(notices).toHaveLength(2);
  });

  it('answers in chat-completions shape, which the Void loop reads', async () => {
    h.aiRun.mockResolvedValue({
      response: null,
      tool_calls: [{ name: 'read_file', arguments: { path: 'src/a.ts' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const response = await call(h, '/v1/chat/completions', chatBody());
    await expect(response.json()).resolves.toEqual({
      object: 'chat.completion',
      model: CF,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_0',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  });

  it('waits for a rate token without using a model call, then gives up', async () => {
    h.admit
      .mockResolvedValueOnce({ ok: false, reason: 'rate', waitMs: 6000 })
      .mockResolvedValueOnce({ ok: true, sessionCalls: null });
    h.aiRun.mockResolvedValue({
      response: 'ok',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    expect((await call(h, '/v1/chat/completions', chatBody())).status).toBe(200);
    expect(h.sleep).toHaveBeenCalledWith(6000);
    expect(h.holds).toHaveLength(1);

    h.admit.mockResolvedValue({ ok: false, reason: 'rate', waitMs: 60_000 });
    const response = await call(h, '/v1/chat/completions', chatBody());
    expect(response.status).toBe(503);
    expect(response.headers.get(SECURITY_STOP_HEADER)).toBeNull();
    expect(h.holds).toHaveLength(1);
    expect(h.clock.now - NOW).toBeGreaterThanOrEqual(SECURITY_RATE_WAIT_LIMIT_MS);
  });

  it('reads a binding credits error as a credits stop', async () => {
    h.aiRun.mockRejectedValue(Object.assign(new Error('Insufficient balance'), { status: 402 }));
    const response = await call(h, '/v1/chat/completions', chatBody());
    expect(response.status).toBe(402);
    expect(response.headers.get(SECURITY_STOP_HEADER)).toBe('credits');
    expect(h.settles[0]).toMatchObject({ actualNano: 0, inputTokens: 0, outputTokens: 0 });
  });

  it('does not read a binding error text as credits without a 402', async () => {
    h.aiRun.mockRejectedValue(Object.assign(new Error('Insufficient resources'), { status: 500 }));
    const response = await call(h, '/v1/chat/completions', chatBody());
    expect(response.status).toBe(500);
    expect(response.headers.get(SECURITY_STOP_HEADER)).toBeNull();
    expect(h.failures.at(-1)?.reason).toBe('upstream');
  });

  it('backs the @cf rate bucket off on a Workers AI 429, and only there', async () => {
    h.aiRun.mockRejectedValue(Object.assign(new Error('Too many requests'), { status: 429 }));
    const response = await call(h, '/v1/chat/completions', chatBody());
    expect(response.status).toBe(429);
    expect(response.headers.get(SECURITY_STOP_HEADER)).toBeNull();
    expect(h.rateLimited).toHaveBeenCalledWith(CF, NOW);

    h.rateLimited.mockClear();
    h.scan.value = scanRow({ modelUsed: OPUS });
    h.fetch.mockResolvedValue(new Response('slow down', { status: 429 }));
    await call(h, '/v1/messages', { model: OPUS, max_tokens: 10, messages: [] });
    expect(h.rateLimited).not.toHaveBeenCalled();
  });

  it('reads a 429 from a Workers AI error that carries only its code (3040)', async () => {
    h.aiRun.mockRejectedValue(new Error('3040: Capacity temporarily exceeded, please try again.'));
    const response = await call(h, '/v1/chat/completions', chatBody());
    expect(response.status).toBe(429);
    expect(h.rateLimited).toHaveBeenCalledWith(CF, NOW);
  });

  it('maps Workers AI error codes, also after a class name, and nothing else', () => {
    expect(workersAiErrorStatus(new Error('3040: Capacity temporarily exceeded'))).toBe(429);
    expect(workersAiErrorStatus(new Error('InferenceUpstreamError: 3040: busy'))).toBe(429);
    expect(workersAiErrorStatus('3036: You have used up your daily free allocation')).toBe(429);
    expect(workersAiErrorStatus(new Error('5007: No such model'))).toBeNull();
    expect(workersAiErrorStatus(new Error('Too many requests'))).toBeNull();
    expect(workersAiErrorStatus(new Error('at 12:30: 3040: late'))).toBeNull();
    expect(workersAiErrorStatus({ status: 429 })).toBeNull();
  });

  it('keeps the worst case, tokens included, when a JSON answer has no usage', async () => {
    h.aiRun.mockResolvedValue({ response: 'ok' });
    const response = await call(h, '/v1/chat/completions', chatBody());
    expect(response.status).toBe(200);
    const hold = h.holds[0]!;
    expect(h.settles[0]).toMatchObject({
      holdNano: hold.worstNano,
      actualNano: hold.worstNano,
      outputTokens: SECURITY_DEFAULT_CALL_OUTPUT_TOKENS,
    });
    expect(h.settles[0]!.inputTokens).toBeGreaterThan(0);
    expect(hold.worstNano).toBe(
      securityModelCostNanoUsd(CF, h.settles[0]!.inputTokens, SECURITY_DEFAULT_CALL_OUTPUT_TOKENS),
    );
  });

  it('still answers when settle throws; the hold stays charged', async () => {
    h.settleError.value = new Error('db down');
    h.aiRun.mockResolvedValue({
      response: 'ok',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await call(h, '/v1/chat/completions', chatBody());
    expect(response.status).toBe(200);
    expect(h.settles).toHaveLength(1);
    expect(spy).toHaveBeenCalledWith('[security-model-proxy] settle failed', expect.anything());
    spy.mockRestore();
  });
});

describe('third-party calls through AI Gateway REST', () => {
  beforeEach(() => {
    h.scan.value = scanRow({ modelUsed: OPUS });
  });

  it('sends fixed gateway headers and drops every caller credential and cf-aig-* header', async () => {
    h.fetch.mockResolvedValue(
      Response.json({ usage: { input_tokens: 100, output_tokens: 10 }, content: [] }),
    );
    const response = await call(
      h,
      '/v1/messages',
      { model: OPUS, max_tokens: 4096, messages: [] },
      {
        authorization: 'Bearer stolen',
        'x-api-key': 'placeholder',
        'anthropic-version': '2023-06-01',
        'cf-aig-metadata': '{"projectId":"other"}',
        'cf-aig-gateway-id': 'attacker',
        'cf-aig-collect-log-payload': 'true',
        'cf-aig-skip-cache': 'false',
        'cf-aig-cache-key': 'x',
      },
    );
    expect(response.status).toBe(200);
    const [url, init] = h.fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct_1/ai/v1/messages');
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    expect(headers).toEqual({
      accept: 'application/json',
      authorization: 'Bearer cf-token',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'cf-aig-gateway-id': 'void-gw',
      'cf-aig-metadata': '{"securityScan":"ss_1.signedtag"}',
      'cf-aig-collect-log': 'true',
      'cf-aig-collect-log-payload': 'false',
      'cf-aig-skip-cache': 'true',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'claude-opus-5.5',
      max_tokens: 4096,
      messages: [],
    });
    expect(h.admit).toHaveBeenCalledWith(expect.objectContaining({ rateModel: null }));
    expect(h.settles[0]).toMatchObject({ inputTokens: 100, outputTokens: 10 });
  });

  it('adds access_programs to every openai/* body and clamps the output to what is left', async () => {
    h.scan.value = scanRow({ modelUsed: TERRA, tokensOut: 119_000 });
    h.fetch.mockResolvedValue(Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }));
    await call(h, '/v1/responses', {
      model: TERRA,
      input: 'x',
      max_output_tokens: 50_000,
      access_programs: { cyber: 'none' },
    });
    const [url, init] = h.fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct_1/ai/v1/responses');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'gpt-6.1-terra',
      input: 'x',
      max_output_tokens: 1000,
      access_programs: { cyber: 'standard' },
    });
    expect(new Headers(init.headers).get('anthropic-version')).toBeNull();
  });

  it('passes an SSE stream through and meters the usage it carries', async () => {
    h.scan.value = scanRow({ modelUsed: TERRA });
    const events = [
      { type: 'response.created', response: { id: 'r1' } },
      { type: 'response.output_text.delta', delta: 'hi' },
      {
        type: 'response.completed',
        response: { usage: { input_tokens: 5000, output_tokens: 300 } },
      },
    ];
    h.fetch.mockResolvedValue(
      new Response(sse(events), { headers: { 'content-type': 'text/event-stream' } }),
    );
    const response = await call(h, '/v1/responses', { model: TERRA, input: 'x', stream: true });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const text = await response.text();
    expect(text).toBe(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    expect(h.settles).toEqual([
      expect.objectContaining({
        inputTokens: 5000,
        outputTokens: 300,
        actualNano: securityModelCostNanoUsd(TERRA, 5000, 300),
      }),
    ]);
  });

  it('keeps the worst case charged when the reader drops the stream', async () => {
    h.scan.value = scanRow({ modelUsed: TERRA });
    h.fetch.mockResolvedValue(new Response(sse([{ type: 'response.created' }])));
    const response = await call(h, '/v1/responses', { model: TERRA, input: 'x', stream: true });
    await response.body!.cancel();
    expect(h.settles).toHaveLength(1);
    expect(h.settles[0]!.actualNano).toBe(h.holds[0]!.worstNano);
  });

  it('answers 402 as a credits stop and records why for the runner (Engine C)', async () => {
    h.scan.value = scanRow({ modelUsed: TERRA });
    h.fetch.mockResolvedValue(new Response('{"error":"insufficient credits"}', { status: 402 }));
    const response = await call(h, '/v1/responses', { model: TERRA, input: 'x' });
    expect(response.status).toBe(402);
    expect(response.headers.get(SECURITY_STOP_HEADER)).toBe('credits');
    expect(h.settles[0]!.actualNano).toBe(0);
    const why = await handleSecurityModelRequest(
      h.deps,
      'ss_1',
      2,
      new Request(`http://model.void.internal${SECURITY_MODEL_FAILURE_PATH}`),
    );
    await expect(why.json()).resolves.toEqual({
      failure: { reason: 'credits', httpStatus: 402, at: NOW },
    });
  });

  it('keeps only allowlisted anthropic-beta values', async () => {
    h.fetch.mockResolvedValue(Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }));
    await call(
      h,
      '/v1/messages',
      { model: OPUS, max_tokens: 10, messages: [] },
      {
        'anthropic-beta':
          'context-1m-2025-08-07, interleaved-thinking-2025-05-14,web-fetch-2025-09-10,claude-code-20250219',
      },
    );
    const [, init] = h.fetch.mock.calls[0]! as [string, RequestInit];
    expect(new Headers(init.headers).get('anthropic-beta')).toBe(
      'interleaved-thinking-2025-05-14,claude-code-20250219',
    );

    await call(
      h,
      '/v1/messages',
      { model: OPUS, max_tokens: 10, messages: [] },
      { 'anthropic-beta': 'mcp-client-2025-11-20' },
    );
    const [, second] = h.fetch.mock.calls[1]! as [string, RequestInit];
    expect(new Headers(second.headers).has('anthropic-beta')).toBe(false);
  });

  it('refuses a Messages tool the provider runs, and mcp_servers / container (T2)', async () => {
    const base = { model: OPUS, max_tokens: 10, messages: [] };
    const refused = [
      { ...base, tools: [{ type: 'web_search_20260209', name: 'web_search' }] },
      { ...base, tools: [{ type: 'web_fetch_20260209', name: 'web_fetch' }] },
      { ...base, tools: [{ type: 'code_execution_20260521', name: 'code_execution' }] },
      { ...base, tools: [{ type: 'mcp_toolset', mcp_server_name: 'x' }] },
      { ...base, mcp_servers: [{ type: 'url', url: 'https://evil.example', name: 'x' }] },
      { ...base, container: { skills: [] } },
    ];
    for (const body of refused) {
      const response = await call(h, '/v1/messages', body);
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({ error: 'tool_not_allowed' });
    }
    expect(h.failures.at(-1)?.reason).toBe('not_allowed');
    expect(h.hold).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();

    h.fetch.mockResolvedValue(Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }));
    const tools = [
      { name: 'read_file', input_schema: { type: 'object' } },
      { type: 'custom', name: 'grep', input_schema: { type: 'object' } },
    ];
    expect((await call(h, '/v1/messages', { ...base, tools })).status).toBe(200);
  });

  it('refuses a Responses tool the provider runs, and background (T2)', async () => {
    h.scan.value = scanRow({ modelUsed: TERRA });
    const base = { model: TERRA, input: 'x' };
    const refused = [
      { ...base, tools: [{ type: 'web_search' }] },
      { ...base, tools: [{ type: 'mcp', server_label: 'x', server_url: 'https://evil.example' }] },
      { ...base, tools: [{ type: 'code_interpreter', container: { type: 'auto' } }] },
      { ...base, tools: [{ type: 'file_search', vector_store_ids: ['vs_1'] }] },
      { ...base, tools: [{ type: 'namespace', name: 'n', tools: [{ type: 'web_search' }] }] },
      {
        ...base,
        input: [{ type: 'additional_tools', tools: [{ type: 'web_search_preview' }] }],
      },
      { ...base, background: true },
    ];
    for (const body of refused) {
      expect((await call(h, '/v1/responses', body)).status).toBe(422);
    }
    expect(h.hold).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();

    h.fetch.mockResolvedValue(Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }));
    const tools = [
      { type: 'function', name: 'submit', parameters: { type: 'object' } },
      { type: 'custom', name: 'apply' },
      {
        type: 'namespace',
        name: 'mcp__void_scan',
        tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
      },
    ];
    expect((await call(h, '/v1/responses', { ...base, tools })).status).toBe(200);
  });

  it('takes the gateway name of the scan model and sends that name on', async () => {
    h.fetch.mockResolvedValue(Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }));
    expect(
      (await call(h, '/v1/messages', { model: 'claude-opus-5.5', max_tokens: 10, messages: [] }))
        .status,
    ).toBe(200);
    const [, init] = h.fetch.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body)).model).toBe('claude-opus-5.5');
    // Another model, with or without a provider, is still refused.
    const other = await call(h, '/v1/messages', {
      model: 'claude-sonnet-5.5',
      max_tokens: 10,
      messages: [],
    });
    expect(other.status).toBe(422);
    expect(gatewayModelName('@cf/zai-org/glm-5.3')).toBe('@cf/zai-org/glm-5.3');
    expect(gatewayModelName(TERRA)).toBe('gpt-6.1-terra');
  });

  it('never passes an upstream 401 on to the engine', async () => {
    h.fetch.mockResolvedValue(new Response('{"error":"nope"}', { status: 401 }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await call(h, '/v1/messages', { model: OPUS, max_tokens: 10, messages: [] });
    spy.mockRestore();
    expect(response.status).toBe(502);
    expect(response.headers.get(SECURITY_STOP_HEADER)).toBeNull();
  });

  it('keeps the worst case charged when a 2xx answer is not JSON', async () => {
    h.fetch.mockResolvedValue(new Response('<html>', { status: 200 }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await call(h, '/v1/messages', { model: OPUS, max_tokens: 10, messages: [] });
    spy.mockRestore();
    expect(response.status).toBe(502);
    expect(response.headers.get(SECURITY_STOP_HEADER)).toBeNull();
    expect(h.settles[0]).toMatchObject({ actualNano: h.holds[0]!.worstNano, outputTokens: 10 });
    expect(h.failures.at(-1)?.reason).toBe('upstream');
  });

  it('prices Anthropic cache writes at 1.25× (5 min) and 2× (1 h) input', async () => {
    h.fetch.mockResolvedValue(
      Response.json({
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 1000,
          cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 },
          cache_read_input_tokens: 50,
          output_tokens: 10,
        },
      }),
    );
    await call(h, '/v1/messages', { model: OPUS, max_tokens: 10, messages: [] });
    expect(h.settles[0]).toMatchObject({
      inputTokens: 1150,
      outputTokens: 10,
      // 100 + 50 at 1×, 600 at 1.25×, 400 at 2×.
      actualNano: securityModelCostNanoUsd(OPUS, 150 + 750 + 800, 10),
    });
  });

  it('answers a tokens stop when what is left is below the provider minimum', async () => {
    h.scan.value = scanRow({ modelUsed: TERRA, tokensOut: 119_990 });
    const response = await call(h, '/v1/responses', { model: TERRA, input: 'x' });
    expect(response.status).toBe(429);
    expect(response.headers.get(SECURITY_STOP_HEADER)).toBe('tokens');
    expect(h.hold).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('lowers a thinking budget with the output limit, or stops when it cannot', async () => {
    h.scan.value = scanRow({ modelUsed: OPUS, tokensOut: 118_500 });
    h.fetch.mockResolvedValue(Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }));
    const thinking = { type: 'enabled', budget_tokens: 4000 };
    await call(h, '/v1/messages', { model: OPUS, max_tokens: 8000, thinking, messages: [] });
    const [, init] = h.fetch.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      max_tokens: 1500,
      thinking: { type: 'enabled', budget_tokens: 1499 },
    });

    h.scan.value = scanRow({ modelUsed: OPUS, tokensOut: 119_000 });
    const response = await call(h, '/v1/messages', {
      model: OPUS,
      max_tokens: 8000,
      thinking,
      messages: [],
    });
    expect(response.headers.get(SECURITY_STOP_HEADER)).toBe('tokens');
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('passes a provider cyber_policy refusal on, so the scan ends refused (spike S9 P1)', async () => {
    h.scan.value = scanRow({ modelUsed: TERRA });
    h.fetch.mockResolvedValue(
      Response.json(
        {
          error: {
            message:
              'This request has been flagged for potentially high-risk cybersecurity activity.',
            type: 'invalid_request_error',
            code: 'cyber_policy',
          },
        },
        { status: 400 },
      ),
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await call(h, '/v1/responses', { model: TERRA, input: 'x' });
    spy.mockRestore();
    expect(response.status).toBe(400);
    expect(response.headers.get(SECURITY_STOP_HEADER)).toBeNull();
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: 'cyber_policy' });
    expect(h.failures.at(-1)).toMatchObject({ reason: 'refused', httpStatus: 400 });
    expect(h.settles[0]!.actualNano).toBe(0);

    // Codex shows the answer as `unexpected status 400 Bad Request: <body>` (spike S3).
    const runner = (await import(/* @vite-ignore */ RUNNER_STATUS)) as {
      classifyCodexRun(signal: unknown): unknown;
      readProxyStopReason(value: string | null): unknown;
    };
    const failure = h.failures.at(-1)!;
    expect(
      runner.classifyCodexRun({
        submitted: null,
        failure: { message: `unexpected status 400 Bad Request: ${text}` },
        finalMessage: null,
        exitCode: 1,
        proxyStop: {
          httpStatus: failure.httpStatus,
          reason: runner.readProxyStopReason(failure.reason),
        },
      }),
    ).toEqual({ kind: 'refused', category: 'cyber_policy' });
  });

  it('reads a policy code only from the provider error object', () => {
    expect(providerPolicyCode('{"error":{"code":"trusted_access_for_cyber"}}')).toBe(
      'trusted_access_for_cyber',
    );
    expect(providerPolicyCode('[{"error":{"code":"cyber_policy"}}]')).toBe('cyber_policy');
    expect(providerPolicyCode('{"error":{"code":"rate_limit_exceeded"}}')).toBeNull();
    expect(providerPolicyCode('{"error":{"message":"cyber_policy"}}')).toBeNull();
    expect(providerPolicyCode('overloaded')).toBeNull();
  });

  it('reads a policy code from other error envelopes and from a body cut short', () => {
    expect(providerPolicyCode('{"errors":[{"code":"cyber_policy","message":"x"}]}')).toBe(
      'cyber_policy',
    );
    expect(providerPolicyCode('{"error":[{"code":"cyber_policy"}]}')).toBe('cyber_policy');
    expect(providerPolicyCode('{"error":{"type":"cyber_policy"}}')).toBe('cyber_policy');
    const nested = JSON.stringify({ error: { code: 'cyber_policy', message: 'flagged' } });
    expect(providerPolicyCode(JSON.stringify({ errors: [{ code: 7000, message: nested }] }))).toBe(
      'cyber_policy',
    );
    const long = `{"error":{"code":"trusted_access_for_cyber","message":"${'x'.repeat(9000)}"}}`;
    expect(providerPolicyCode(long.slice(0, 8000))).toBe('trusted_access_for_cyber');
    // An escaped echo of the request text is not a code.
    expect(
      providerPolicyCode(`{"error":{"message":"bad input: \\"cyber_policy\\" ${'x'.repeat(10)}`),
    ).toBeNull();
    expect(
      providerPolicyCode('{"type":"error","error":{"type":"invalid_request_error"}}'),
    ).toBeNull();
  });

  it('keeps a 402 with a policy code a credits stop', async () => {
    h.fetch.mockResolvedValue(new Response('{"error":{"code":"cyber_policy"}}', { status: 402 }));
    const response = await call(h, '/v1/messages', { model: OPUS, max_tokens: 10, messages: [] });
    expect(response.status).toBe(402);
    expect(response.headers.get(SECURITY_STOP_HEADER)).toBe('credits');
    expect(h.failures.at(-1)?.reason).toBe('credits');
  });

  it('passes another upstream failure as a plain failure the runner retries', async () => {
    h.fetch.mockResolvedValue(new Response('overloaded', { status: 529 }));
    const response = await call(h, '/v1/messages', { model: OPUS, max_tokens: 10, messages: [] });
    expect(response.status).toBe(529);
    expect(response.headers.get(SECURITY_STOP_HEADER)).toBeNull();
    expect(h.failures.at(-1)?.reason).toBe('upstream');
  });
});

describe('refusals before a call is sent', () => {
  it('refuses a model other than the scan model with 422', async () => {
    const response = await call(h, '/v1/chat/completions', chatBody({ model: OPUS }));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: 'security model not allowed' });
    expect(h.hold).not.toHaveBeenCalled();
    expect(h.aiRun).not.toHaveBeenCalled();
    expect(h.failures.at(-1)?.reason).toBe('not_allowed');
  });

  it('refuses a route that does not belong to the model host', async () => {
    const response = await call(h, '/v1/messages', { model: CF, max_tokens: 10, messages: [] });
    expect(response.status).toBe(422);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('refuses a blocked model, a host that failed check 5 and a missing provider notice', async () => {
    h.policy.value = onPolicy({ blockedModels: [CF] });
    expect((await call(h, '/v1/chat/completions', chatBody())).status).toBe(422);

    h.policy.value = onPolicy({
      entitlement: {
        checkedAt: '2026-11-18T11:00:00.000Z',
        ok: true,
        missing: [],
        hosts: { openai: true, anthropic: false },
      },
    });
    h.scan.value = scanRow({ modelUsed: OPUS });
    expect(
      (await call(h, '/v1/messages', { model: OPUS, max_tokens: 1, messages: [] })).status,
    ).toBe(422);

    h.policy.value = onPolicy();
    h.scan.value = scanRow({ modelUsed: OPUS, projectNoticeVersion: null });
    const response = await call(h, '/v1/messages', { model: OPUS, max_tokens: 1, messages: [] });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: 'provider notice not accepted',
    });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.hold).not.toHaveBeenCalled();
  });

  it('refuses every call while security audits are off', async () => {
    h.policy.value = onPolicy({ mode: 'disabled' });
    expect((await call(h, '/v1/chat/completions', chatBody())).status).toBe(409);
    expect(h.aiRun).not.toHaveBeenCalled();
  });

  it('refuses a stale attempt or a scan past its lease without a stop header (T10)', async () => {
    h.scan.value = scanRow({ attempt: 3 });
    const stale = await call(h, '/v1/chat/completions', chatBody());
    expect(stale.status).toBe(409);
    expect(stale.headers.get(SECURITY_STOP_HEADER)).toBeNull();

    h.scan.value = scanRow({ leaseUntil: '2026-11-18T11:00:00.000Z' });
    expect((await call(h, '/v1/chat/completions', chatBody())).status).toBe(409);
    expect(h.hold).not.toHaveBeenCalled();
  });

  it('stops the scan at the call cap and the token caps', async () => {
    h.scan.value = scanRow({ modelCalls: 80 });
    const calls = await call(h, '/v1/chat/completions', chatBody());
    expect(calls.status).toBe(429);
    expect(calls.headers.get(SECURITY_STOP_HEADER)).toBe('scan_calls');

    h.scan.value = scanRow({ tokensIn: 1_200_000 });
    expect(
      (await call(h, '/v1/chat/completions', chatBody())).headers.get(SECURITY_STOP_HEADER),
    ).toBe('tokens');
    h.scan.value = scanRow({ tokensOut: 120_000 });
    expect(
      (await call(h, '/v1/chat/completions', chatBody())).headers.get(SECURITY_STOP_HEADER),
    ).toBe('tokens');
    expect(h.hold).not.toHaveBeenCalled();
  });

  it('stops a session at 40 calls (Codex has no max-turns setting)', async () => {
    h.admit.mockResolvedValue({ ok: false, reason: 'session_calls' });
    const response = await call(h, '/v1/chat/completions', chatBody(), {
      'x-void-scan-session': '3',
    });
    expect(response.headers.get(SECURITY_STOP_HEADER)).toBe('session_calls');
    expect(h.admit).toHaveBeenCalledWith(expect.objectContaining({ session: 3 }));
    for (const value of ['-1', '64', 'abc']) {
      const bad = await call(h, '/v1/chat/completions', chatBody(), {
        'x-void-scan-session': value,
      });
      expect(bad.status).toBe(400);
    }
  });

  it('refuses a body over the size limit with 413', async () => {
    const big = 'x'.repeat(SECURITY_MODEL_MAX_REQUEST_BYTES);
    const response = await call(h, '/v1/chat/completions', chatBody({ messages: [big] }));
    expect(response.status).toBe(413);
    expect(h.hold).not.toHaveBeenCalled();
  });

  it('stops the scan when the call could cross a monthly cap → incomplete (budget)', async () => {
    h.hold.mockResolvedValue({
      ok: false,
      reason: 'budget',
      cap: 'project',
      capNano: 100,
      spentNano: 100,
    });
    const response = await call(h, '/v1/chat/completions', chatBody());
    expect(response.status).toBe(429);
    expect(response.headers.get(SECURITY_STOP_HEADER)).toBe('budget');
    expect(h.aiRun).not.toHaveBeenCalled();
    const runner = (await import(/* @vite-ignore */ RUNNER_STATUS)) as {
      classifyProxyStop(status: number, reason: unknown): unknown;
      readProxyStopReason(value: string | null): unknown;
      outcomeStatus(outcome: unknown): { status: string; reason: string | null };
    };
    const outcome = runner.classifyProxyStop(
      response.status,
      runner.readProxyStopReason(response.headers.get(SECURITY_STOP_HEADER)),
    );
    expect(runner.outcomeStatus(outcome)).toMatchObject({ status: 'incomplete', reason: 'budget' });
  });

  it('holds each call against the plan cap with project caps off, and stops at it (M27)', async () => {
    h.policy.value = onPolicy({
      budgets: { ...defaultSecurityPolicy().budgets, platformCapOn: false, projectCapsOn: false },
    });
    h.scan.value = scanRow({ planCap: 1000 });
    h.hold.mockResolvedValue({
      ok: false,
      reason: 'budget',
      cap: 'project',
      capNano: 10_000_000_000,
      spentNano: 10_000_000_000,
    });
    const response = await call(h, '/v1/chat/completions', chatBody());
    expect(h.hold).toHaveBeenCalledWith(
      expect.objectContaining({ caps: { projectNano: 10_000_000_000, platformNano: null } }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get(SECURITY_STOP_HEADER)).toBe('budget');
    expect(h.aiRun).not.toHaveBeenCalled();
  });

  it('refuses unknown routes and bodies that are not JSON objects', async () => {
    expect((await call(h, '/v1/embeddings', {})).status).toBe(404);
    expect((await call(h, '/v1/chat/completions', [1])).status).toBe(400);
    expect(h.hold).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('reads usage in all three shapes, cache tokens as input', () => {
    const plain = { cacheWrite5m: 0, cacheWrite1h: 0 };
    expect(readModelUsage({ usage: { prompt_tokens: 3, completion_tokens: 4 } })).toEqual({
      input: 3,
      output: 4,
      ...plain,
    });
    expect(
      readModelUsage({
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 2,
            output_tokens: 1,
          },
        },
      }),
    ).toEqual({ input: 17, output: 1, cacheWrite5m: 5, cacheWrite1h: 0 });
    expect(readModelUsage({ response: { usage: { input_tokens: 8, output_tokens: 9 } } })).toEqual({
      input: 8,
      output: 9,
      ...plain,
    });
    expect(billedInputTokens({ input: 10, output: 0, cacheWrite5m: 5, cacheWrite1h: 3 })).toBe(
      10 + 2 + 3,
    );
    expect(readModelUsage({ usage: {} })).toBeNull();
  });

  it('keeps the highest cumulative counts across an Anthropic stream', () => {
    const reader = new SseUsageReader();
    reader.push('event: message_start\r\ndata: {"type":"message_start","message":{"usage":');
    reader.push('{"input_tokens":120,"output_tokens":1}}}\r\n\r\n');
    reader.push('data: {"type":"message_delta","usage":{"output_tokens":450}}\n\ndata: [DONE]');
    reader.end();
    expect(reader.usage).toEqual({ input: 120, output: 450, cacheWrite5m: 0, cacheWrite1h: 0 });
  });

  it('clamps the output limit per route', () => {
    const chat: Record<string, unknown> = { max_tokens: 900, max_completion_tokens: 500 };
    expect(clampCallOutput('chat', chat, 10_000)).toBe(500);
    expect(chat).toEqual({ max_tokens: 500 });
    const messages: Record<string, unknown> = {};
    expect(clampCallOutput('messages', messages, 100)).toBe(100);
    expect(messages).toEqual({ max_tokens: 100 });
    expect(clampCallOutput('responses', {}, 15)).toBeNull();
    expect(clampCallOutput('responses', {}, 16)).toBe(16);
    const thinking: Record<string, unknown> = {
      max_tokens: 5000,
      thinking: { type: 'enabled', budget_tokens: 1023 },
    };
    // The budget would have to drop below 1,024 to stay under the limit.
    expect(clampCallOutput('messages', thinking, 1000)).toBeNull();
  });

  it('filters anthropic-beta values', () => {
    expect(allowedAnthropicBetas(null)).toBeNull();
    expect(allowedAnthropicBetas('context-1m-2025-08-07')).toBeNull();
    expect(allowedAnthropicBetas(' claude-code-20250219 ,claude-code-20250219')).toBe(
      'claude-code-20250219',
    );
  });

  it('keeps an answer that already has choices', () => {
    const value = { choices: [{ message: { content: 'x' } }] };
    expect(asChatCompletion(CF, value)).toBe(value);
  });
});
