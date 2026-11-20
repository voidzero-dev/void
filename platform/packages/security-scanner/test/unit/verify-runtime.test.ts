import { describe, expect, test, vi } from 'vite-plus/test';
import type { Engine, SessionOutcome, SessionSpec } from '../../src/runner/engines/types.ts';
import { createVoidLoopEngine } from '../../src/runner/engines/void-loop.ts';
import { runPhases } from '../../src/runner/phases.ts';
import type { ScanReport } from '../../src/runner/report.ts';
import {
  COPY_LIMITS,
  CopyClient,
  isCopyControlPath,
  withVerdictSource,
  withoutRuntimeFields,
} from '../../src/runner/runtime/copy.ts';
import type { OutcomeBody } from '../../src/runner/status.ts';
import { parseTask } from '../../src/runner/task.ts';
import type { FsTools } from '../../src/runner/tools/fs.ts';
import { validateFindingsValue } from '../../src/runner/validate-findings.ts';
import { confirmed, lead, record, report } from '../helpers/findings.ts';

// M30: verify sessions send test requests to the scan's throwaway copy, and a
// confirmation that names a request the copy answered becomes "confirmed (runtime)".

const BASE = {
  version: 1,
  scan_id: 'ss_1',
  attempt: 1,
  engine: 'void_loop',
  model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
  tier: 'built_diff',
  changed_files: ['src/users.ts'],
};
const RUNTIME_TASK = parseTask({ ...BASE, runtime_copy: true });
const STATIC_TASK = parseTask(BASE);

type CopyCall = { url: string; method: string; headers: Headers; body: string | null };

/** A fake copy route: `ready` decides the ready check, `answer` every other request. */
function fakeCopy(
  options: {
    ready?: Array<'dispatched' | 'unavailable' | 'deny'>;
    answer?: (call: CopyCall) => Response;
  } = {},
) {
  const calls: Array<CopyCall> = [];
  const ready = [...(options.ready ?? ['dispatched'])];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call: CopyCall = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(call);
    if (url.endsWith('/__void_copy/ready')) {
      const state = ready.length > 1 ? ready.shift()! : ready[0]!;
      if (state === 'deny') {
        return new Response('egress denied: copy.void.internal', { status: 403 });
      }
      return state === 'dispatched'
        ? Response.json({ ready: true }, { headers: { 'x-void-copy': 'dispatched' } })
        : new Response('no copy', { status: 503, headers: { 'x-void-copy': 'unavailable' } });
    }
    return (
      options.answer?.(call) ??
      Response.json({ ok: true }, { headers: { 'x-void-copy': 'dispatched' } })
    );
  });
  return { calls, fetch: fetchFn as unknown as typeof fetch };
}

function submitted(raws: Array<Record<string, unknown>>): OutcomeBody {
  return {
    kind: 'submitted',
    report: { run_status: 'complete', findings: raws.map(record), notes: '' },
    repaired: false,
  };
}

/** A scripted engine; `sessionTools` says whether it can offer the copy tool. */
function scriptedEngine(
  script: Array<(spec: SessionSpec) => Promise<OutcomeBody> | OutcomeBody>,
  sessionTools = true,
): Engine & { specs: Array<SessionSpec> } {
  const specs: Array<SessionSpec> = [];
  return {
    id: 'void_loop',
    version: 'test',
    sessionTools,
    specs,
    async runSession(spec) {
      specs.push(spec);
      const next = script.shift();
      if (!next) {
        throw new Error(`no scripted session for ${spec.phase}`);
      }
      return {
        ...(await next(spec)),
        stats: { turns: 1, modelCalls: 1, inputTokens: 1, outputTokens: 1 },
      } as SessionOutcome;
    },
  };
}

describe('CopyClient.waitReady', () => {
  test('is ready once the copy itself answers', async () => {
    const copy = fakeCopy({ ready: ['unavailable', 'unavailable', 'dispatched'] });
    const client = new CopyClient({ fetch: copy.fetch, readyWaitMs: 1000, readyPollMs: 1 });
    expect(await client.waitReady()).toBe(true);
    expect(copy.calls.map((call) => call.url)).toEqual([
      'http://copy.void.internal/__void_copy/ready',
      'http://copy.void.internal/__void_copy/ready',
      'http://copy.void.internal/__void_copy/ready',
    ]);
  });

  test('stops at once when the controller has no copy route (the catch-all deny)', async () => {
    const copy = fakeCopy({ ready: ['deny'] });
    const client = new CopyClient({ fetch: copy.fetch, readyWaitMs: 60_000, readyPollMs: 1 });
    expect(await client.waitReady()).toBe(false);
    expect(copy.calls).toHaveLength(1);
  });

  test('gives up after the wait when no copy comes', async () => {
    const copy = fakeCopy({ ready: ['unavailable'] });
    const client = new CopyClient({ fetch: copy.fetch, readyWaitMs: 20, readyPollMs: 5 });
    expect(await client.waitReady()).toBe(false);
  });
});

describe('copy_request tool', () => {
  test('sends only paths on the copy, records each request with an id', async () => {
    const copy = fakeCopy({
      answer: (call) =>
        call.url.endsWith('/api/invoices/2')
          ? Response.json({ customer: 'Globex' }, { headers: { 'x-void-copy': 'dispatched' } })
          : new Response('nope', { status: 401, headers: { 'x-void-copy': 'dispatched' } }),
    });
    const { tool, requests } = new CopyClient({ fetch: copy.fetch }).sessionTool();
    const first = await tool.run({
      method: 'get',
      path: '/api/invoices/2',
      headers: { cookie: 'inv_session=x', host: 'evil.example', 'x-void-copy': 'dispatched' },
    });
    expect(first.ok).toBe(true);
    expect(first.text).toContain('id: r1');
    expect(first.text).toContain('status: 200');
    expect(first.text).toContain('Globex');
    expect(copy.calls[0]!.url).toBe('http://copy.void.internal/api/invoices/2');
    // The model cannot pick the host or forge the copy marker.
    expect(copy.calls[0]!.headers.get('cookie')).toBe('inv_session=x');
    expect(copy.calls[0]!.headers.has('host')).toBe(false);
    expect(copy.calls[0]!.headers.has('x-void-copy')).toBe(false);

    const second = await tool.run({ method: 'POST', path: '/api/login', body: '{"a":1}' });
    expect(second.text).toContain('id: r2');
    expect(copy.calls[1]!.body).toBe('{"a":1}');
    expect(requests).toEqual([
      {
        id: 'r1',
        method: 'GET',
        path: '/api/invoices/2',
        status: 200,
        dispatched: true,
        control: false,
      },
      {
        id: 'r2',
        method: 'POST',
        path: '/api/login',
        status: 401,
        dispatched: true,
        control: false,
      },
    ]);
  });

  test('refuses URLs, other hosts and bad requests without sending anything', async () => {
    const copy = fakeCopy();
    const { tool, requests } = new CopyClient({ fetch: copy.fetch }).sessionTool();
    for (const args of [
      { method: 'GET', path: 'https://api.cloudflare.com/client/v4/' },
      { method: 'GET', path: '//example.com/x' },
      { method: 'GET', path: '/a b' },
      { method: 'TRACE', path: '/' },
      { method: 'GET', path: '/', body: 'x' },
      { method: 'POST', path: '/', body: 'x'.repeat(COPY_LIMITS.bodyBytes + 1) },
    ]) {
      const result = await tool.run(args);
      expect(result.ok).toBe(false);
      expect(result.text.startsWith('error:')).toBe(true);
    }
    expect(copy.calls).toEqual([]);
    expect(requests).toEqual([]);
  });

  test('cuts long answers and stops after the per-session limit', async () => {
    const copy = fakeCopy({
      answer: () =>
        new Response('x'.repeat(COPY_LIMITS.answerChars * 2), {
          headers: { 'x-void-copy': 'dispatched' },
        }),
    });
    const { tool } = new CopyClient({ fetch: copy.fetch }).sessionTool();
    const first = await tool.run({ method: 'GET', path: '/' });
    expect(first.text).toContain(`[cut at ${COPY_LIMITS.answerChars} characters]`);
    for (let index = 1; index < COPY_LIMITS.requestsPerSession; index++) {
      await tool.run({ method: 'GET', path: '/' });
    }
    const over = await tool.run({ method: 'GET', path: '/' });
    expect(over).toEqual({ ok: false, text: 'error: no copy requests left in this session' });
  });

  test('says when the copy was not there to answer', async () => {
    const copy = fakeCopy({
      answer: () =>
        new Response('runtime copy unavailable', {
          status: 503,
          headers: { 'x-void-copy': 'unavailable' },
        }),
    });
    const { tool, requests } = new CopyClient({ fetch: copy.fetch }).sessionTool();
    expect((await tool.run({ method: 'GET', path: '/' })).text).toContain('(copy unavailable)');
    expect(requests[0]!.dispatched).toBe(false);
  });
});

describe('verdict source', () => {
  const requests = [
    {
      id: 'r1',
      method: 'GET' as const,
      path: '/api/invoices/2',
      status: 200,
      dispatched: true,
      control: false,
    },
    {
      id: 'r2',
      method: 'GET' as const,
      path: '/x',
      status: 503,
      dispatched: false,
      control: false,
    },
  ];

  test('a confirmation that names a request the copy answered is runtime', () => {
    const out = withVerdictSource(record(confirmed({ proof_request: 'r1' })), requests);
    expect(out.verdict_source).toBe('runtime');
    expect(out.runtime_proof).toEqual({
      request: 'r1',
      method: 'GET',
      path: '/api/invoices/2',
      status: 200,
    });
    expect('proof_request' in out).toBe(false);
    // The findings file the API ingests accepts it.
    expect(validateFindingsValue(report([out])).ok).toBe(true);
  });

  test('stays static for an unknown id, an unavailable copy, a lead or no proof', () => {
    for (const raw of [
      confirmed({ proof_request: 'r9' }),
      confirmed({ proof_request: 'r2' }),
      confirmed({ proof_request: null }),
      lead({ proof_request: 'r1' }),
    ]) {
      const out = withVerdictSource(record(raw), requests);
      expect(out.verdict_source).toBeUndefined();
      expect(out.runtime_proof).toBeUndefined();
    }
  });

  test('a seeding or ready request of the copy itself is never proof', async () => {
    const copy = fakeCopy({
      answer: () => Response.json({ ok: true }, { headers: { 'x-void-copy': 'dispatched' } }),
    });
    const client = new CopyClient({ fetch: copy.fetch }).sessionTool();
    await client.tool.run({ method: 'POST', path: '/__void_copy/d1', body: '{}' });
    await client.tool.run({ method: 'GET', path: '/__void_copy/ready' });
    // The same route reached through a dot segment, as fetch and the entry read it.
    await client.tool.run({ method: 'POST', path: '/api/../__void_copy/kv', body: '{}' });
    expect(client.requests.map((request) => request.control)).toEqual([true, true, true]);
    for (const id of ['r1', 'r2', 'r3']) {
      const out = withVerdictSource(record(confirmed({ proof_request: id })), client.requests);
      expect(out.verdict_source).toBeUndefined();
      expect(out.runtime_proof).toBeUndefined();
    }
    expect(isCopyControlPath('/__void_copy_x')).toBe(false);
    expect(isCopyControlPath('/api/__void_copy/d1')).toBe(false);
  });

  test('never keeps runtime fields the model set itself', () => {
    const forged = record(
      confirmed({
        verdict_source: 'runtime',
        runtime_proof: { request: 'r1', method: 'GET', path: '/', status: 200 },
      }),
    );
    expect(withoutRuntimeFields(forged)).not.toHaveProperty('verdict_source');
    expect(withVerdictSource(forged, [])).not.toHaveProperty('runtime_proof');
  });

  test('the validator refuses a runtime source without proof or on a lead', () => {
    expect(validateFindingsValue(report([confirmed({ verdict_source: 'runtime' })])).ok).toBe(
      false,
    );
    expect(
      validateFindingsValue(
        report([
          lead({
            verdict_source: 'runtime',
            runtime_proof: { request: 'r1', method: 'GET', path: '/', status: 200 },
          }),
        ]),
      ).ok,
    ).toBe(false);
    // An empty proof id from a model is no proof, not a broken report.
    expect(record(confirmed({ proof_request: '' })).proof_request).toBeNull();
  });
});

describe('runPhases with a runtime copy', () => {
  test('verify sessions get copy_request and a runtime proof is kept', async () => {
    const copy = fakeCopy({
      answer: () =>
        Response.json({ number: 'INV-2' }, { headers: { 'x-void-copy': 'dispatched' } }),
    });
    const client = new CopyClient({ fetch: copy.fetch, readyWaitMs: 100, readyPollMs: 1 });
    const engine = scriptedEngine([
      // The hunt tries to claim a runtime proof itself; it is dropped.
      () =>
        submitted([
          confirmed({
            verdict_source: 'runtime',
            runtime_proof: { request: 'r1', method: 'GET', path: '/', status: 200 },
          }),
          lead(),
        ]),
      async (spec) => {
        const tool = spec.tools?.find((candidate) => candidate.name === 'copy_request');
        expect(tool).toBeDefined();
        await tool!.run({ method: 'GET', path: "/api/invoices/search?q=%25'%20OR%201%3D1--" });
        return submitted([confirmed({ proof_request: 'r1' })]);
      },
      // The lead stays a lead: a request that shows nothing is no proof.
      async (spec) => {
        await spec.tools![0]!.run({ method: 'GET', path: '/proxy?url=http://169.254.169.254/' });
        return submitted([lead({ proof_request: 'r2' })]);
      },
    ]);
    const result = await runPhases({ engine, task: RUNTIME_TASK, hasMemory: false, copy: client });
    expect(result.status).toBe('succeeded');
    const [sql, ssrf] = result.findings;
    expect(sql).toMatchObject({
      verdict: 'confirmed',
      verdict_source: 'runtime',
      runtime_proof: {
        request: 'r1',
        method: 'GET',
        path: "/api/invoices/search?q=%25'%20OR%201%3D1--",
        status: 200,
      },
    });
    expect(ssrf!.verdict).toBe('needs_validation');
    expect(ssrf).not.toHaveProperty('verdict_source');
    expect(ssrf).not.toHaveProperty('proof_request');
    // Only verify sessions get the tool and the runtime text; the hunt never does.
    expect(engine.specs[0]!.tools).toBeUndefined();
    expect(engine.specs[1]!.prompt).toContain('copy_request');
    expect(engine.specs[1]!.prompt).not.toContain('from the code alone');
    // Each verify session numbers its own requests from the client's counter.
    expect(copy.calls.filter((call) => !call.url.endsWith('/ready'))).toHaveLength(2);
    expect(validateFindingsValue(report(result.findings)).ok).toBe(true);
  });

  test('a task without runtime_copy, an engine without session tools or no copy stays static', async () => {
    for (const [task, sessionTools, ready] of [
      [STATIC_TASK, true, 'dispatched'],
      [RUNTIME_TASK, false, 'dispatched'],
      [RUNTIME_TASK, true, 'deny'],
    ] as const) {
      const copy = fakeCopy({ ready: [ready] });
      const client = new CopyClient({ fetch: copy.fetch, readyWaitMs: 10, readyPollMs: 1 });
      const engine = scriptedEngine(
        [() => submitted([confirmed()]), () => submitted([confirmed({ proof_request: 'r1' })])],
        sessionTools,
      );
      const result = await runPhases({ engine, task, hasMemory: false, copy: client });
      expect(engine.specs[1]!.tools).toBeUndefined();
      expect(engine.specs[1]!.prompt).toContain('from the code alone');
      expect(result.findings[0]).not.toHaveProperty('verdict_source');
      expect(result.findings[0]).not.toHaveProperty('proof_request');
      if (task === STATIC_TASK || !sessionTools) {
        // No ready check at all: the copy is not waited for.
        expect(copy.calls).toEqual([]);
      }
    }
  });
});

describe('Engine B with the copy tool', () => {
  const noTools: FsTools = {
    readFile: async () => ({ ok: true, text: '' }),
    listFiles: async () => ({ ok: true, text: '' }),
    grep: async () => ({ ok: true, text: '' }),
  } as unknown as FsTools;

  function chat(toolCalls: Array<{ name: string; args: unknown }>) {
    return Response.json({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: toolCalls.map((call, index) => ({
              id: `call_${index}`,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  }

  test('offers the session tool to the model and runs it', async () => {
    const bodies: Array<{
      tools: Array<{ function: { name: string } }>;
      messages: Array<unknown>;
    }> = [];
    const replies = [
      chat([{ name: 'copy_request', args: { method: 'GET', path: '/api/invoices/2' } }]),
      chat([
        {
          name: 'submit_findings',
          args: report([confirmed({ proof_request: 'r1' })]),
        },
      ]),
    ];
    const modelFetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return replies.shift()!;
    }) as unknown as typeof fetch;
    const engine = createVoidLoopEngine({ model: 'm', tools: noTools, fetch: modelFetch });
    expect(engine.sessionTools).toBe(true);
    const copy = fakeCopy();
    const session = new CopyClient({ fetch: copy.fetch }).sessionTool();
    const outcome = await engine.runSession({
      phase: 'verify',
      index: 1,
      system: 's',
      prompt: 'p',
      maxTurns: 5,
      tools: [session.tool],
    });
    expect(outcome.kind).toBe('submitted');
    expect(bodies[0]!.tools.map((tool) => tool.function.name)).toContain('copy_request');
    expect(JSON.stringify(bodies[1]!.messages)).toContain('id: r1');
    expect(session.requests).toHaveLength(1);
    const submittedReport = (outcome as { report: ScanReport }).report;
    expect(submittedReport.findings[0]!.proof_request).toBe('r1');
  });

  test('a session without tools offers only the four scan tools', async () => {
    const bodies: Array<{ tools: Array<{ function: { name: string } }> }> = [];
    const modelFetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return chat([{ name: 'submit_findings', args: report([]) }]);
    }) as unknown as typeof fetch;
    const engine = createVoidLoopEngine({ model: 'm', tools: noTools, fetch: modelFetch });
    await engine.runSession({ phase: 'hunt', index: 0, system: 's', prompt: 'p', maxTurns: 2 });
    expect(bodies[0]!.tools.map((tool) => tool.function.name)).toEqual([
      'read_file',
      'list_files',
      'grep',
      'submit_findings',
    ]);
  });
});
