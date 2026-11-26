import { securityModelCostNanoUsd } from '@void/platform/security-models';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { SecurityCallHold, SecurityCallRefusal } from '../../src/security/budget.ts';
import type { AdmitModelCallResult, ModelCallFailure } from '../../src/security/call-ledger.ts';
import {
  handleSecurityModelRequest,
  SECURITY_DEFAULT_CALL_OUTPUT_TOKENS,
  SECURITY_RATE_WAIT_LIMIT_MS,
  SECURITY_STOP_HEADER,
} from '../../src/security/model-proxy.ts';
import type { SecurityModelProxyDeps, SecurityModelScan } from '../../src/security/model-proxy.ts';
import { onPolicy, passingEntitlement } from '../helpers/security-policy.ts';

// The runner's own mapping, so a proxy stop is checked end to end (spec §8.4). A
// variable path keeps the runner package out of this package's type check.
const RUNNER_STATUS = '../../../security-scanner/src/runner/status.ts';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const CF = '@cf/zai-org/glm-5.3';
const OPUS = 'anthropic/claude-opus-5.5';
const TERRA = 'openai/gpt-6.1-terra';

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

function harness() {
  const clock = { now: NOW };
  const state = {
    scan: scanRow() as SecurityModelScan | undefined,
    policy: onPolicy(),
    failures: [] as Array<ModelCallFailure>,
    holds: [] as Array<Parameters<SecurityModelProxyDeps['hold']>[0]>,
    settles: [] as Array<Parameters<SecurityModelProxyDeps['settle']>[0]>,
    clock,
    admit: vi.fn(async (): Promise<AdmitModelCallResult> => ({ ok: true, sessionCalls: null })),
    hold: vi.fn(
      async (
        input: Parameters<SecurityModelProxyDeps['hold']>[0],
      ): Promise<SecurityCallHold | SecurityCallRefusal> => {
        state.holds.push(input);
        return { ok: true, month: '2026-11-01', holdNano: input.worstNano, modelCalls: 1 };
      },
    ),
    fetch: vi.fn(async () => Response.json({})),
    aiRun: vi.fn(async () => ({})),
    sleep: vi.fn(async (ms: number) => {
      clock.now += ms;
    }),
  };
  const deps: SecurityModelProxyDeps = {
    now: () => clock.now,
    sleep: state.sleep,
    loadScan: async () => state.scan,
    readPolicy: async () => state.policy,
    admit: state.admit,
    recordFailure: async (_scanId, _attempt, failure) => {
      state.failures.push(failure);
    },
    lastFailure: async () => state.failures.at(-1) ?? null,
    rateLimited: async () => {},
    hold: state.hold,
    settle: async (input) => {
      state.settles.push(input);
      return { projectSpentNano: 0, platformSpentNano: 0 };
    },
    scanTag: async (scanId) => `${scanId}.signedtag`,
    gatewayId: 'void-gw',
    accountId: 'acct_1',
    apiToken: 'cf-token',
    ai: { run: state.aiRun } as unknown as Ai,
    fetch: state.fetch,
  };
  return Object.assign(state, { deps });
}

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
  // Failure paths log; keep the output quiet.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

function call(path: string, body: unknown, headers: Record<string, string> = {}) {
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

const chatBody = (overrides: Record<string, unknown> = {}) => ({
  model: CF,
  messages: [{ role: 'user', content: 'scan' }],
  tools: [],
  ...overrides,
});
const opusBody = (overrides: Record<string, unknown> = {}) => ({
  model: OPUS,
  max_tokens: 10,
  messages: [],
  ...overrides,
});
const stop = (response: Response) => response.headers.get(SECURITY_STOP_HEADER);

function sse(events: ReadonlyArray<unknown>): Response {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

/** What the nth gateway fetch sent. */
function sent(n = 0) {
  const [url, init] = h.fetch.mock.calls[n] as unknown as [string, RequestInit];
  return { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) };
}

function fetchOk() {
  h.fetch.mockImplementation(async () =>
    Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }),
  );
}

describe('metering (I7)', () => {
  it('runs @cf on the binding with fixed gateway options and settles the hold to the real cost', async () => {
    h.aiRun.mockResolvedValue({
      response: 'ok',
      usage: { prompt_tokens: 1000, completion_tokens: 200 },
    });
    expect((await call('/v1/chat/completions', chatBody())).status).toBe(200);
    const [model, inputs, options] = h.aiRun.mock.calls[0] as unknown as [string, object, object];
    expect(model).toBe(CF);
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
    expect(h.settles).toEqual([
      expect.objectContaining({
        holdNano: h.holds[0].worstNano,
        actualNano: securityModelCostNanoUsd(CF, 1000, 200),
        inputTokens: 1000,
        outputTokens: 200,
      }),
    ]);
  });

  it('keeps the worst case charged for a lost call or an answer with no usage', async () => {
    h.aiRun.mockRejectedValueOnce(new Error('Network connection lost.'));
    expect((await call('/v1/chat/completions', chatBody())).status).toBe(502);
    h.aiRun.mockResolvedValueOnce({ response: 'ok' });
    expect((await call('/v1/chat/completions', chatBody())).status).toBe(200);
    for (const [index, settled] of h.settles.entries()) {
      expect(settled.actualNano).toBe(h.holds[index].worstNano);
      expect(settled.inputTokens).toBeGreaterThan(0);
    }
    // A known status means no answer was made: it costs nothing.
    h.aiRun.mockRejectedValueOnce(new Error('3040: Capacity temporarily exceeded'));
    await call('/v1/chat/completions', chatBody());
    expect(h.settles[2]).toMatchObject({ actualNano: 0, inputTokens: 0, outputTokens: 0 });
  });

  it('keeps the worst case for a stream that is dropped, cut short or ends in an error', async () => {
    h.scan = scanRow({ modelUsed: OPUS });
    const start = {
      type: 'message_start',
      message: { usage: { input_tokens: 5000, output_tokens: 1 } },
    };
    const text = { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } };
    const streams = [
      [start, text],
      [start, text, { type: 'error', error: { type: 'overloaded_error' } }],
    ];
    for (const events of streams) {
      h.fetch.mockResolvedValueOnce(sse(events));
      await (await call('/v1/messages', opusBody({ max_tokens: 1000, stream: true }))).text();
    }
    h.fetch.mockResolvedValueOnce(sse([start, text]));
    await (await call('/v1/messages', opusBody({ stream: true }))).body!.cancel();
    expect(h.settles).toHaveLength(3);
    for (const [index, settled] of h.settles.entries()) {
      expect(settled.actualNano).toBe(h.holds[index].worstNano);
    }

    const done = { type: 'message_delta', delta: {}, usage: { output_tokens: 450 } };
    h.fetch.mockResolvedValueOnce(sse([start, text, done, { type: 'message_stop' }]));
    await (await call('/v1/messages', opusBody({ max_tokens: 1000, stream: true }))).text();
    expect(h.settles[3]).toMatchObject({
      inputTokens: 5000,
      outputTokens: 450,
      actualNano: securityModelCostNanoUsd(OPUS, 5000, 450),
    });
  });
});

describe('third-party calls through AI Gateway REST (I3)', () => {
  beforeEach(() => {
    h.scan = scanRow({ modelUsed: OPUS });
  });

  it('adds the token, drops every caller credential and cf-aig-* header, and never returns it', async () => {
    h.fetch.mockResolvedValue(Response.json({ usage: { input_tokens: 100, output_tokens: 10 } }));
    const response = await call('/v1/messages', opusBody({ max_tokens: 4096 }), {
      authorization: 'Bearer stolen',
      'x-api-key': 'placeholder',
      'anthropic-version': '2023-06-01',
      'cf-aig-metadata': '{"projectId":"other"}',
      'cf-aig-gateway-id': 'attacker',
      'cf-aig-collect-log-payload': 'true',
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify([...response.headers]) + (await response.text())).not.toContain(
      'cf-token',
    );
    const { url, headers, body } = sent();
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct_1/ai/v1/messages');
    expect(Object.fromEntries(headers.entries())).toEqual({
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
    expect(body).toEqual({ model: 'claude-opus-5.5', max_tokens: 4096, messages: [] });

    // An upstream 401 (a token problem) is never passed on to the engine.
    h.fetch.mockResolvedValue(new Response('{"error":"nope"}', { status: 401 }));
    expect((await call('/v1/messages', opusBody())).status).toBe(502);
  });

  it('clamps the output to what is left and forces the openai access program', async () => {
    h.scan = scanRow({ modelUsed: TERRA, tokensOut: 119_000 });
    fetchOk();
    await call('/v1/responses', {
      model: TERRA,
      input: 'x',
      max_output_tokens: 50_000,
      access_programs: { cyber: 'none' },
    });
    expect(sent().body).toEqual({
      model: 'gpt-6.1-terra',
      input: 'x',
      max_output_tokens: 1000,
      access_programs: { cyber: 'standard' },
    });
  });

  it('refuses tools the provider runs, mcp_servers, container and background', async () => {
    const refused: Array<[string, Record<string, unknown>]> = [
      ['/v1/messages', opusBody({ tools: [{ type: 'web_search_20260209', name: 'web_search' }] })],
      ['/v1/messages', opusBody({ tools: [{ type: 'mcp_toolset', mcp_server_name: 'x' }] })],
      ['/v1/messages', opusBody({ mcp_servers: [{ type: 'url', url: 'https://evil.example' }] })],
      ['/v1/messages', opusBody({ container: { skills: [] } })],
    ];
    for (const [path, body] of refused) {
      const response = await call(path, body);
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({ error: 'tool_not_allowed' });
    }
    h.scan = scanRow({ modelUsed: TERRA });
    const responses = { model: TERRA, input: 'x' };
    for (const body of [
      { ...responses, tools: [{ type: 'code_interpreter', container: { type: 'auto' } }] },
      { ...responses, tools: [{ type: 'namespace', name: 'n', tools: [{ type: 'web_search' }] }] },
      { ...responses, background: true },
    ]) {
      expect((await call('/v1/responses', body)).status).toBe(422);
    }
    expect(h.hold).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();

    fetchOk();
    const tools = [{ type: 'function', name: 'submit', parameters: { type: 'object' } }];
    expect((await call('/v1/responses', { ...responses, tools })).status).toBe(200);
  });

  // I10: a provider refusal ends the scan refused, never clean.
  it('passes a provider cyber_policy refusal on, so the scan ends refused', async () => {
    h.scan = scanRow({ modelUsed: TERRA });
    const flagged = {
      error: { message: 'flagged', type: 'invalid_request_error', code: 'cyber_policy' },
    };
    h.fetch.mockResolvedValue(Response.json(flagged, { status: 400 }));
    const response = await call('/v1/responses', { model: TERRA, input: 'x' });
    expect(response.status).toBe(400);
    expect(stop(response)).toBeNull();
    const text = await response.text();
    const failure = h.failures.at(-1)!;
    expect(failure).toMatchObject({ reason: 'refused', httpStatus: 400 });
    expect(h.settles[0].actualNano).toBe(0);

    const runner = (await import(/* @vite-ignore */ RUNNER_STATUS)) as {
      classifyCodexRun(signal: unknown): unknown;
      readProxyStopReason(value: string | null): unknown;
    };
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
});

describe('refusals and caps before a call is sent', () => {
  it('refuses another model, a blocked model, a missing notice, a stale attempt and audits off', async () => {
    expect((await call('/v1/chat/completions', chatBody({ model: OPUS }))).status).toBe(422);
    h.policy = onPolicy({ blockedModels: [CF] });
    expect((await call('/v1/chat/completions', chatBody())).status).toBe(422);
    h.policy = onPolicy({
      entitlement: passingEntitlement({ hosts: { openai: true, anthropic: false } }),
    });
    h.scan = scanRow({ modelUsed: OPUS });
    expect((await call('/v1/messages', opusBody())).status).toBe(422);
    h.policy = onPolicy();
    h.scan = scanRow({ modelUsed: OPUS, projectNoticeVersion: null });
    expect((await call('/v1/messages', opusBody())).status).toBe(422);
    // T10: a stale attempt or a scan past its lease gets no stop header.
    for (const scan of [scanRow({ attempt: 3 }), scanRow({ leaseUntil: '2026-11-18T11:00:00Z' })]) {
      h.scan = scan;
      const stale = await call('/v1/chat/completions', chatBody());
      expect(stale.status).toBe(409);
      expect(stop(stale)).toBeNull();
    }
    h.scan = scanRow();
    h.policy = onPolicy({ mode: 'disabled' });
    expect((await call('/v1/chat/completions', chatBody())).status).toBe(409);
    expect(h.hold).not.toHaveBeenCalled();
    expect(h.aiRun).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('stops the scan at the call, token and session caps', async () => {
    const cases: Array<[SecurityModelScan, string]> = [
      [scanRow({ modelCalls: 80 }), 'scan_calls'],
      [scanRow({ tokensIn: 1_200_000 }), 'tokens'],
      [scanRow({ tokensOut: 120_000 }), 'tokens'],
    ];
    for (const [scan, reason] of cases) {
      h.scan = scan;
      const response = await call('/v1/chat/completions', chatBody());
      expect(response.status).toBe(429);
      expect(stop(response)).toBe(reason);
    }
    h.scan = scanRow();
    h.admit.mockResolvedValue({ ok: false, reason: 'session_calls' });
    const session = await call('/v1/chat/completions', chatBody(), { 'x-void-scan-session': '3' });
    expect(stop(session)).toBe('session_calls');
    expect(h.admit).toHaveBeenCalledWith(expect.objectContaining({ session: 3 }));
    expect(h.hold).not.toHaveBeenCalled();
  });

  it('gives up after waiting too long for a rate token, without using a model call', async () => {
    h.admit.mockResolvedValue({ ok: false, reason: 'rate', waitMs: 60_000 });
    const response = await call('/v1/chat/completions', chatBody());
    expect(response.status).toBe(503);
    expect(stop(response)).toBeNull();
    expect(h.holds).toHaveLength(0);
    expect(h.clock.now - NOW).toBeGreaterThanOrEqual(SECURITY_RATE_WAIT_LIMIT_MS);
  });

  it('stops the scan as incomplete (budget) when the call could cross a monthly cap', async () => {
    h.hold.mockResolvedValue({
      ok: false,
      reason: 'budget',
      cap: 'project',
      capNano: 100,
      spentNano: 100,
    });
    const response = await call('/v1/chat/completions', chatBody());
    expect(response.status).toBe(429);
    expect(stop(response)).toBe('budget');
    expect(h.aiRun).not.toHaveBeenCalled();
    const runner = (await import(/* @vite-ignore */ RUNNER_STATUS)) as {
      classifyProxyStop(status: number, reason: unknown): unknown;
      readProxyStopReason(value: string | null): unknown;
      outcomeStatus(outcome: unknown): { status: string; reason: string | null };
    };
    const outcome = runner.classifyProxyStop(
      response.status,
      runner.readProxyStopReason(stop(response)),
    );
    expect(runner.outcomeStatus(outcome)).toMatchObject({ status: 'incomplete', reason: 'budget' });
  });
});
