import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import {
  CODEX_FEATURES_OFF,
  CODEX_FINAL_SCHEMA,
  codexConfig,
  createCodexEngine,
} from '../../src/runner/engines/codex.ts';
import type { CodexEvent, CodexSdk } from '../../src/runner/engines/codex.ts';
import { fetchOf, spec } from '../helpers/engine.ts';
import { confirmed, report } from '../helpers/findings.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scanner-codex-'));
  await mkdir(join(dir, 'home'), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Config = Record<string, unknown> & {
  mcp_servers: Record<string, { args: Array<string> }>;
  model_providers: Record<string, { http_headers: Record<string, string> }>;
  features: Record<string, unknown>;
  projects: Record<string, unknown>;
};

type Seen = {
  sdkOptions?: Record<string, unknown>;
  config?: Config;
  thread?: Record<string, unknown>;
  prompt?: string;
  outputSchema?: unknown;
};

/** A Codex SDK stand-in: the run emits `events`, after `act` (the MCP server's file writes). */
function sdkOf(
  events: Array<CodexEvent>,
  seen: Seen = {},
  act?: (reportPath: string) => Promise<void>,
  fail?: Error,
): CodexSdk {
  return {
    Codex: class {
      constructor(options: {
        codexPathOverride: string;
        env: Record<string, string>;
        config: Record<string, unknown>;
      }) {
        seen.sdkOptions = options;
        seen.config = options.config as Config;
      }
      startThread(options: Record<string, unknown>) {
        seen.thread = options;
        return {
          runStreamed: async (prompt: string, run: { outputSchema: unknown }) => {
            seen.prompt = prompt;
            seen.outputSchema = run.outputSchema;
            const args = seen.config!.mcp_servers['void-scan'].args;
            await act?.(args[args.indexOf('--out') + 1]);
            return {
              events: (async function* () {
                for (const event of events) {
                  yield event;
                }
                if (fail) {
                  throw fail;
                }
              })(),
            };
          },
        };
      }
    },
  };
}

function engine(sdk: CodexSdk | null, failures: Array<unknown> = [null]) {
  return createCodexEngine({
    model: 'openai/gpt-6.1-terra',
    root: '/scan',
    baseUrl: 'http://model.test/v1',
    fetch: fetchOf(failures),
    loadSdk: sdk === null ? () => Promise.reject(new Error('missing')) : async () => sdk,
    image: { homeBase: join(dir, 'home') },
  });
}

const DONE: Array<CodexEvent> = [
  { type: 'item.completed', item: { type: 'mcp_tool_call' } },
  {
    type: 'item.completed',
    item: { type: 'agent_message', text: '{"run_status":"complete","finding_count":1}' },
  },
  { type: 'turn.completed', usage: { input_tokens: 900, output_tokens: 40 } },
];

const writeReport = (value: unknown) => async (path: string) => {
  await writeFile(path, JSON.stringify(value));
};

describe('Engine C config (spec §15.4)', () => {
  const config = codexConfig({
    baseUrl: 'http://model.void.internal/v1',
    session: 4,
    codexHome: '/home/scanner/codex-x',
    instructionsFile: '/home/scanner/codex-x/instructions.md',
    reportPath: '/home/scanner/codex-x/findings.json',
    root: '/scan',
    maxRecords: 1,
  }) as Config;

  test('the proxy provider has no key, no auth, no retries and names its session', () => {
    expect(config.model_provider).toBe('void-proxy');
    expect(config.model_providers['void-proxy']).toEqual({
      name: 'void-proxy',
      base_url: 'http://model.void.internal/v1',
      wire_api: 'responses',
      requires_openai_auth: false,
      supports_websockets: false,
      http_headers: { 'x-void-scan-session': '4' },
      request_max_retries: 0,
      stream_max_retries: 0,
    });
    expect(JSON.stringify({ ...config, features: undefined })).not.toMatch(
      /api_key|env_key|bearer/i,
    );
  });

  test('no shell, no sandbox escape, no repo instructions, no web', () => {
    expect(config).toMatchObject({
      approval_policy: 'never',
      sandbox_mode: 'read-only',
      web_search: 'disabled',
      project_doc_max_bytes: 0,
      project_root_markers: [],
      model_catalog_json: '/opt/void-scanner/codex-models.json',
      model_instructions_file: '/home/scanner/codex-x/instructions.md',
      skills: { include_instructions: false, bundled: { enabled: false } },
      analytics: { enabled: false },
      check_for_update_on_startup: false,
    });
    for (const name of [
      'shell_tool',
      'unified_exec',
      'multi_agent',
      'plugins',
      'apps',
      'memories',
      'hooks',
    ]) {
      expect(CODEX_FEATURES_OFF).toContain(name);
    }
    expect(Object.values(config.features).every((on) => on === false)).toBe(true);
    expect(config.projects['/scan']).toEqual({ trust_level: 'untrusted' });
  });

  test('only the void-scan MCP server, required, with the four tools approved', () => {
    expect(Object.keys(config.mcp_servers)).toEqual(['void-scan']);
    expect(config.mcp_servers['void-scan']).toEqual({
      command: '/usr/local/bin/node',
      args: [
        '/opt/void-scanner/void-scan-mcp.mjs',
        '--root',
        '/scan',
        '--out',
        '/home/scanner/codex-x/findings.json',
        '--max-records',
        '1',
      ],
      required: true,
      enabled_tools: ['read_file', 'list_files', 'grep', 'submit_findings'],
      default_tools_approval_mode: 'approve',
    });
  });
});

describe('Engine C sessions', () => {
  test('reads come from the void-scan count, not from tool call events (S9 B5 follow-up)', async () => {
    const listed: Array<CodexEvent> = [
      {
        type: 'item.completed',
        item: { type: 'mcp_tool_call', tool: 'list_files', status: 'completed' },
      },
      {
        type: 'item.completed',
        item: { type: 'mcp_tool_call', tool: 'read_file', status: 'completed' },
      },
      ...DONE,
    ];
    const outcome = await engine(sdkOf(listed, {}, writeReport(report([])))).runSession(spec());
    expect(outcome).toMatchObject({ kind: 'submitted', stats: { reads: 0 } });
  });

  test('a report the MCP server accepted is submitted; Codex gets the bare model name', async () => {
    const seen: Seen = {};
    const act = async (path: string) => {
      await writeReport(report([confirmed()]))(path);
      await writeFile(`${path}.reads`, JSON.stringify({ count: 1 }));
    };
    const outcome = await engine(sdkOf(DONE, seen, act)).runSession(spec({ index: 1 }));
    expect(outcome).toMatchObject({
      kind: 'submitted',
      stats: { turns: 1, modelCalls: 2, inputTokens: 900, outputTokens: 40, reads: 1 },
    });
    expect(seen.thread).toMatchObject({
      model: 'gpt-6.1-terra',
      workingDirectory: '/work',
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      webSearchMode: 'disabled',
    });
    expect(seen.outputSchema).toEqual(CODEX_FINAL_SCHEMA);
    expect(seen.sdkOptions).toMatchObject({
      codexPathOverride: '/opt/void-scanner/codex-wrapper.sh',
    });
    const env = seen.sdkOptions!.env as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual(['CODEX_HOME', 'HOME', 'PATH', 'SSL_CERT_FILE']);
    expect(env.CODEX_HOME).toContain(join(dir, 'home'));
    expect(seen.config!.model_providers['void-proxy'].http_headers).toEqual({
      'x-void-scan-session': '1',
    });
    expect(await readdir(join(dir, 'home'))).toEqual([]);
  });

  test('a verify session limits the MCP server to one record', async () => {
    const seen: Seen = {};
    await engine(sdkOf(DONE, seen)).runSession(spec({ phase: 'verify', index: 2 }));
    expect(seen.config!.mcp_servers['void-scan'].args.slice(-2)).toEqual(['--max-records', '1']);
  });

  test('402 comes from the proxy, not from Codex error text', async () => {
    const events: Array<CodexEvent> = [
      { type: 'turn.failed', error: { message: 'unexpected status 402 Payment Required' } },
    ];
    const outcome = await engine(sdkOf(events), [
      null,
      { reason: 'credits', httpStatus: 402, at: 5 },
    ]).runSession(spec());
    expect(outcome.kind).toBe('credits');
  });

  test('a cap stop comes from the proxy too', async () => {
    const outcome = await engine(
      sdkOf(
        [{ type: 'error', message: 'stream disconnected' }],
        {},
        undefined,
        new Error('exit 1'),
      ),
      [null, { reason: 'session_calls', httpStatus: 429, at: 5 }],
    ).runSession(spec());
    expect(outcome).toMatchObject({ kind: 'stopped', reason: 'session_calls' });
  });

  test('a cyber policy error is a refusal with its code', async () => {
    const outcome = await engine(
      sdkOf([{ type: 'turn.failed', error: { message: 'request blocked: cyber_policy' } }]),
    ).runSession(spec());
    expect(outcome).toMatchObject({ kind: 'refused', category: 'cyber_policy' });
  });

  test('no report and a plain final message is a refusal without a category', async () => {
    const events: Array<CodexEvent> = [
      { type: 'item.completed', item: { type: 'agent_message', text: 'I cannot help with that.' } },
      { type: 'turn.completed', usage: {} },
    ];
    expect(await engine(sdkOf(events)).runSession(spec())).toMatchObject({
      kind: 'refused',
      category: null,
    });
  });

  test('a report the tool refused twice is bad output', async () => {
    const outcome = await engine(
      sdkOf(DONE, {}, async (path) => {
        await writeFile(
          `${path}.rejected`,
          JSON.stringify({ count: 2, kind: 'shape', message: '$.x: bad' }),
        );
      }),
    ).runSession(spec());
    expect(outcome).toMatchObject({ kind: 'bad_output', errorKind: 'shape', message: '$.x: bad' });
  });

  test('a failed run with nothing else is infrastructure', async () => {
    expect(
      await engine(sdkOf([], {}, undefined, new Error('codex exited with 1'))).runSession(spec()),
    ).toMatchObject({ kind: 'infrastructure', errorClass: 'codex_turn_failed' });
  });

  test('the verify rule: one record at most', async () => {
    const outcome = await engine(
      sdkOf(DONE, {}, writeReport(report([confirmed(), confirmed({ fingerprint: 'b' })]))),
    ).runSession(spec({ check: (r) => (r.findings.length > 1 ? 'one record only' : null) }));
    expect(outcome).toMatchObject({ kind: 'bad_output', message: 'one record only' });
  });

  test('a scanner image without the SDK ends engine_unavailable', async () => {
    expect(await engine(null).runSession(spec())).toMatchObject({
      kind: 'infrastructure',
      errorClass: 'engine_unavailable',
    });
  });

  test('a stop is aborted, and nothing is left in the home folder', async () => {
    const stopped = new AbortController();
    const outcome = await engine(sdkOf(DONE, {}, async () => stopped.abort())).runSession(
      spec({ signal: stopped.signal }),
    );
    expect(outcome.kind).toBe('aborted');
    expect(await readdir(join(dir, 'home'))).toEqual([]);
  });
});
