import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import {
  CLAUDE_DISALLOWED_TOOLS,
  CLAUDE_TOOLS,
  claudeOptions,
  createClaudeEngine,
  createPathHook,
  createReadCounter,
  gatewayName,
  structuredOutputSchema,
  type ClaudeMessage,
  type ClaudeSdk,
} from '../../src/runner/engines/claude.ts';
import { LAST_FAILURE_PATH } from '../../src/runner/engines/proxy-failure.ts';
import type { SessionSpec } from '../../src/runner/engines/types.ts';
import { defaultEngineFactory } from '../../src/runner/run.ts';
import { createFsTools } from '../../src/runner/tools/fs.ts';
import { validateFindingsValue } from '../../src/runner/validate-findings.ts';
import { confirmed, report } from '../helpers/findings.ts';

let dir: string;
let root: string;
let configBase: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scanner-claude-'));
  root = join(dir, 'scan');
  configBase = join(dir, 'home');
  await mkdir(join(root, 'input'), { recursive: true });
  await mkdir(join(root, 'memory'), { recursive: true });
  await mkdir(configBase, { recursive: true });
  await writeFile(join(root, 'input/a.ts'), 'export {};');
  await writeFile(join(dir, 'secret.txt'), 'token');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function spec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  return { phase: 'hunt', index: 0, system: 'system', prompt: 'hunt', maxTurns: 40, ...overrides };
}

type Seen = { prompt: string; options: Record<string, unknown> };

function sdkOf(messages: Array<ClaudeMessage>, seen: Array<Seen> = []): ClaudeSdk {
  return {
    query: ({ prompt, options }) => {
      seen.push({ prompt, options });
      return (async function* () {
        for (const message of messages) {
          yield message;
        }
      })();
    },
  };
}

const RESULT_OK = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 3,
  usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 },
  structured_output: report([confirmed()]),
} satisfies ClaudeMessage;

function fetchOf(failures: Array<unknown>): typeof fetch {
  let index = 0;
  return (async (input: string | URL | Request) => {
    expect(String(input)).toBe(`http://model.test${LAST_FAILURE_PATH}`);
    const failure = failures[Math.min(index++, failures.length - 1)];
    return Response.json({ failure });
  }) as typeof fetch;
}

function engine(sdk: ClaudeSdk | null, failures: Array<unknown> = [null]) {
  return createClaudeEngine({
    model: 'anthropic/claude-sonnet-5.5',
    root,
    baseUrl: 'http://model.test',
    fetch: fetchOf(failures),
    configBase,
    loadSdk: sdk === null ? () => Promise.reject(new Error('missing')) : async () => sdk,
  });
}

describe('Engine A options (spec §15.3)', () => {
  const options = claudeOptions({
    model: 'anthropic/claude-sonnet-5.5',
    root: '/scan',
    system: 'system text',
    maxTurns: 40,
    session: 3,
    baseUrl: 'http://model.void.internal',
    configDir: '/home/scanner/claude-x',
    caFile: '/ca.crt',
    abortController: new AbortController(),
    hook: async () => ({}),
    afterTool: async () => ({}),
    onStderr: () => undefined,
  });

  test('three read tools and nothing else', () => {
    expect(options.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(options.allowedTools).toEqual([...CLAUDE_TOOLS]);
    for (const name of [
      'Bash',
      'Write',
      'Edit',
      'WebFetch',
      'WebSearch',
      'Agent',
      'Task',
      'mcp__*',
    ]) {
      expect(CLAUDE_DISALLOWED_TOOLS).toContain(name);
    }
    expect(options).toMatchObject({
      permissionMode: 'dontAsk',
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      persistSession: false,
      cwd: '/scan/input',
      additionalDirectories: ['/scan/memory'],
      model: 'claude-sonnet-5.5',
      maxTurns: 40,
    });
    expect(options).not.toHaveProperty('plugins');
    expect(String(options.systemPrompt)).toContain('system text');
  });

  test('the env holds no key and names only the proxy route', () => {
    const env = options.env as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual(
      [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_CUSTOM_HEADERS',
        'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
        'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS',
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
        'CLAUDE_CODE_MAX_RETRIES',
        'CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL',
        'CLAUDE_CONFIG_DIR',
        'DISABLE_AUTOUPDATER',
        'DISABLE_ERROR_REPORTING',
        'DISABLE_TELEMETRY',
        'HOME',
        'NODE_EXTRA_CA_CERTS',
        'PATH',
      ].sort(),
    );
    expect(env.ANTHROPIC_API_KEY).toBe('placeholder-not-a-key');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://model.void.internal');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('x-void-scan-session: 3');
    expect(env.CLAUDE_CODE_MAX_RETRIES).toBe('2');
    expect(env.CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL).toBe('0');
    expect(options.hooks).toMatchObject({ PostToolUse: [{ matcher: 'Read' }] });
  });

  test('the structured output schema drops size keywords and still takes a real report', () => {
    expect(JSON.stringify(structuredOutputSchema())).not.toMatch('maxLength');
    expect(options.outputFormat).toMatchObject({ type: 'json_schema' });
    expect(gatewayName('anthropic/claude-opus-5.5')).toBe('claude-opus-5.5');
  });
});

describe('Engine A path hook', () => {
  test('allows the scan folders and refuses anything else, symlinks included', async () => {
    await symlink(join(dir, 'secret.txt'), join(root, 'input/link.txt'));
    const hook = createPathHook(root);
    const deny = { hookSpecificOutput: { permissionDecision: 'deny' } };
    const call = (tool_input: Record<string, unknown>) => hook({ tool_name: 'Read', tool_input });
    expect(await call({ file_path: join(root, 'input/a.ts') })).toEqual({});
    expect(await call({ path: join(root, 'memory') })).toEqual({});
    expect(await call({ file_path: 'a.ts' })).toEqual({});
    expect(await call({ file_path: join(dir, 'secret.txt') })).toMatchObject(deny);
    expect(await call({ file_path: join(root, 'input/link.txt') })).toMatchObject(deny);
    expect(await call({ file_path: join(root, 'input/../../secret.txt') })).toMatchObject(deny);
    expect(await call({ pattern: '/etc/passwd' })).toMatchObject(deny);
  });

  test('a Glob pattern cannot reach outside the scan folders (spike S11)', async () => {
    const hook = createPathHook(root);
    const deny = { hookSpecificOutput: { permissionDecision: 'deny' } };
    const glob = (tool_input: Record<string, unknown>) => hook({ tool_name: 'Glob', tool_input });
    expect(await glob({ pattern: '**/*.ts' })).toEqual({});
    expect(await glob({ pattern: 'src/**/*' })).toEqual({});
    expect(await glob({ pattern: '**/*', path: join(root, 'memory') })).toEqual({});
    expect(await glob({ pattern: `${join(root, 'input')}/**/*.ts` })).toEqual({});
    for (const pattern of [
      '../../**/*',
      'src/../../*',
      '**/../../*',
      '{..,src}/*',
      '{/etc,src}/*',
      '/{etc,tmp}/*',
      '/etc/**',
      '/**',
      '~/**',
      '\\.\\./*',
      `${dir}/*`,
    ]) {
      expect(await glob({ pattern }), pattern).toMatchObject(deny);
    }
    expect(await glob({ pattern: '**/*', path: dir })).toMatchObject(deny);
    // A Grep pattern is search text: a relative one is not read as a path.
    expect(await hook({ tool_name: 'Grep', tool_input: { pattern: '../x' } })).toEqual({});
  });

  test('a ~ path is the CLI home, not a name in the scan folder', async () => {
    const hook = createPathHook(root);
    const deny = { hookSpecificOutput: { permissionDecision: 'deny' } };
    expect(
      await hook({ tool_name: 'Read', tool_input: { file_path: '~/.claude.json' } }),
    ).toMatchObject(deny);
    expect(
      await hook({ tool_name: 'Glob', tool_input: { pattern: '*', path: '~' } }),
    ).toMatchObject(deny);
    expect(
      await hook({ tool_name: 'Grep', tool_input: { pattern: 'x', path: '~/' } }),
    ).toMatchObject(deny);
    expect(await hook({ tool_name: 'Read', tool_input: { file_path: 'src/~x.ts' } })).toEqual({});
  });

  test('a Glob or Grep path with whitespace at either end is refused (Claude Code trims it)', async () => {
    const hook = createPathHook(root);
    const deny = { hookSpecificOutput: { permissionDecision: 'deny' } };
    const outside = join(dir, 'outside');
    for (const path of [
      ` ${outside}`,
      `\t${outside}`,
      `\n${outside}`,
      `\u00a0${outside}`,
      `\ufeff${outside}`,
      ' ../../outside',
      ' ~',
      '.. ',
      ' /',
      `${join(root, 'input')} `,
    ]) {
      expect(
        await hook({ tool_name: 'Grep', tool_input: { pattern: 'x', path } }),
        path,
      ).toMatchObject(deny);
      expect(
        await hook({ tool_name: 'Glob', tool_input: { pattern: '**/*', path } }),
        path,
      ).toMatchObject(deny);
    }
    // Spaces inside a path are fine.
    expect(
      await hook({ tool_name: 'Grep', tool_input: { pattern: 'x', path: 'src/a b' } }),
    ).toEqual({});
  });

  test('a path that is not a string is refused', async () => {
    const hook = createPathHook(root);
    const deny = { hookSpecificOutput: { permissionDecision: 'deny' } };
    for (const path of [['/etc'], { p: '/etc' }, 1, null]) {
      expect(await hook({ tool_name: 'Grep', tool_input: { pattern: 'x', path } })).toMatchObject(
        deny,
      );
    }
    expect(await hook({ tool_name: 'Grep', tool_input: { pattern: 'x' } })).toEqual({});
  });

  test('counts only a Read that returned code under /scan/input (S9 B5 follow-up)', async () => {
    await writeFile(join(root, 'input/empty.ts'), '  \n');
    await writeFile(join(root, 'memory/index.json'), '{"findings":[]}');
    let reads = 0;
    const counter = createReadCounter(root, () => reads++);
    // The shape Claude Code 2.1.328 hands a PostToolUse hook for a Read.
    const read = (file_path: string, content: string, type = 'text') =>
      counter({
        tool_name: 'Read',
        tool_input: { file_path },
        tool_response: { type, file: { filePath: file_path, content } },
      });
    await read(join(root, 'input/a.ts'), 'export {};');
    expect(reads).toBe(1);
    await read(join(root, 'memory/index.json'), '{"findings":[]}');
    await read(join(root, 'input/empty.ts'), '  \n');
    await read(join(root, 'input/a.ts'), '');
    await read(join(dir, 'secret.txt'), 'token');
    await read(join(root, 'input/../../secret.txt'), 'token');
    await read(join(root, 'input/a.ts'), 'x', 'image');
    await counter({
      tool_name: 'Glob',
      tool_input: { pattern: '**/*' },
      tool_response: { filenames: ['a.ts'] },
    });
    await counter({
      tool_name: 'Grep',
      tool_input: { pattern: 'x' },
      tool_response: { content: 'a.ts:1:x' },
    });
    await counter({ tool_name: 'Read', tool_input: { file_path: join(root, 'input/a.ts') } });
    expect(reads).toBe(1);
  });
});

describe('Engine A sessions', () => {
  test('the session counts the Reads that returned code, not the calls the hook let through', async () => {
    type Hook = (input: Record<string, unknown>) => Promise<unknown>;
    const sdk: ClaudeSdk = {
      query: ({ options }) =>
        (async function* () {
          const hooks = options.hooks as Record<string, Array<{ hooks: Array<Hook> }>>;
          const before = hooks.PreToolUse![0]!.hooks[0]!;
          const after = hooks.PostToolUse![0]!.hooks[0]!;
          await before({ tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } });
          await after({ tool_name: 'Glob', tool_input: { pattern: '**/*.ts' }, tool_response: {} });
          const file_path = join(root, 'input/a.ts');
          await before({ tool_name: 'Read', tool_input: { file_path } });
          await after({
            tool_name: 'Read',
            tool_input: { file_path },
            tool_response: { type: 'text', file: { filePath: file_path, content: 'export {};' } },
          });
          yield RESULT_OK;
        })(),
    };
    expect(await engine(sdk).runSession(spec())).toMatchObject({
      kind: 'submitted',
      stats: { reads: 1 },
    });
  });

  test('a valid structured output is submitted, with counts and a clean config folder', async () => {
    const seen: Array<Seen> = [];
    const outcome = await engine(
      sdkOf([{ type: 'system', subtype: 'init' }, RESULT_OK], seen),
    ).runSession(spec({ index: 2 }));
    expect(outcome).toMatchObject({
      kind: 'submitted',
      stats: { turns: 3, modelCalls: 3, inputTokens: 150, outputTokens: 20 },
    });
    expect(seen[0]!.prompt).toBe('hunt');
    expect((seen[0]!.options.env as Record<string, string>).ANTHROPIC_CUSTOM_HEADERS).toBe(
      'x-void-scan-session: 2',
    );
    expect(await readdir(configBase)).toEqual([]);
  });

  test('402 reported as success with is_error is credits (spike S2)', async () => {
    const outcome = await engine(
      sdkOf([
        {
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: 'API Error: 402 Insufficient unified billing credits',
          num_turns: 1,
        },
      ]),
    ).runSession(spec());
    expect(outcome.kind).toBe('credits');
  });

  test('a proxy stop that appeared during the session wins over the SDK text', async () => {
    const stop = { reason: 'budget', httpStatus: 429, at: 2 };
    const outcome = await engine(
      sdkOf([{ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 429 x' }]),
      [{ reason: 'tokens', httpStatus: 429, at: 1 }, stop],
    ).runSession(spec());
    expect(outcome).toMatchObject({ kind: 'stopped', reason: 'budget' });
  });

  test('a stop that was already there before the session does not count', async () => {
    const old = { reason: 'budget', httpStatus: 429, at: 1 };
    const outcome = await engine(
      sdkOf([{ type: 'result', subtype: 'error_max_turns', num_turns: 40 }]),
      [old, old],
    ).runSession(spec());
    expect(outcome).toMatchObject({ kind: 'stopped', reason: 'turns' });
  });

  test('refusal, turn cap and a missing result', async () => {
    expect(
      await engine(
        sdkOf([
          {
            type: 'result',
            subtype: 'success',
            stop_reason: 'refusal',
            stop_details: { category: 'cyber' },
          },
        ]),
      ).runSession(spec()),
    ).toMatchObject({ kind: 'refused', category: 'cyber' });
    // Claude Code 2.1.328 puts stop_details on the assistant message only (spike S9 A1).
    expect(
      await engine(
        sdkOf([
          {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [],
              stop_reason: 'refusal',
              stop_details: { type: 'refusal', category: 'cyber' },
            },
          },
          { type: 'result', subtype: 'success', is_error: false, stop_reason: 'refusal' },
        ]),
      ).runSession(spec()),
    ).toMatchObject({ kind: 'refused', category: 'cyber' });
    expect(await engine(sdkOf([])).runSession(spec())).toMatchObject({
      kind: 'infrastructure',
      errorClass: 'agent_sdk_error',
    });
  });

  test('a refused turn with no report ends refused whatever the result says', async () => {
    const refusedTurn = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber' },
      },
    } satisfies ClaudeMessage;
    for (const result of [
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        stop_reason: null,
        result: 'API Error: Claude Code is unable to respond to this request',
      },
      { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' },
    ]) {
      expect(await engine(sdkOf([refusedTurn, result])).runSession(spec())).toMatchObject({
        kind: 'refused',
        category: 'cyber',
      });
    }
    // A later turn that submitted a report keeps it.
    expect(await engine(sdkOf([refusedTurn, RESULT_OK])).runSession(spec())).toMatchObject({
      kind: 'submitted',
    });
  });

  test('an SDK that throws is an infrastructure failure', async () => {
    const sdk: ClaudeSdk = {
      query: () => {
        throw new Error('boom');
      },
    };
    expect(await engine(sdk).runSession(spec())).toMatchObject({
      kind: 'infrastructure',
      errorClass: 'agent_sdk_error',
    });
    expect(await readdir(configBase)).toEqual([]);
  });

  test('the verify rule: one record at most', async () => {
    const two = {
      ...RESULT_OK,
      structured_output: report([confirmed(), confirmed({ fingerprint: 'b' })]),
    };
    const outcome = await engine(sdkOf([two])).runSession(
      spec({ phase: 'verify', check: (r) => (r.findings.length > 1 ? 'one record only' : null) }),
    );
    expect(outcome).toMatchObject({ kind: 'bad_output', message: 'one record only' });
  });

  test('a scanner image without the SDK ends engine_unavailable', async () => {
    expect(await engine(null).runSession(spec())).toMatchObject({
      kind: 'infrastructure',
      errorClass: 'engine_unavailable',
    });
  });

  test('a stop before the session starts, or during it, is aborted', async () => {
    const stopped = new AbortController();
    stopped.abort();
    expect(
      await engine(sdkOf([RESULT_OK])).runSession(spec({ signal: stopped.signal })),
    ).toMatchObject({
      kind: 'aborted',
    });
    const live = new AbortController();
    const sdk: ClaudeSdk = {
      query: () =>
        (async function* () {
          live.abort();
          yield { type: 'assistant' } as ClaudeMessage;
        })(),
    };
    expect(await engine(sdk).runSession(spec({ signal: live.signal }))).toMatchObject({
      kind: 'aborted',
    });
  });

  test('the default factory builds Engines A and C and leaves B to its own', () => {
    const context = { tools: createFsTools({ root }), root, baseUrl: 'http://model.test' };
    const task = (engine: string, model: string) =>
      ({
        engine,
        model,
        scanId: 's',
        attempt: 1,
        tier: 'full',
        changedFiles: [],
        maxTurns: 40,
        maxVerify: 10,
      }) as never;
    expect(
      defaultEngineFactory(task('agent_sdk', 'anthropic/claude-sonnet-5.5'), context)?.id,
    ).toBe('agent_sdk');
    expect(defaultEngineFactory(task('codex_sdk', 'openai/gpt-6.1-terra'), context)?.id).toBe(
      'codex_sdk',
    );
    expect(defaultEngineFactory(task('void_loop', '@cf/zai-org/glm-5.3'), context)?.id).toBe(
      'void_loop',
    );
    expect(defaultEngineFactory(task('nope', 'x'), context)).toBeNull();
    expect(validateFindingsValue(RESULT_OK.structured_output).ok).toBe(true);
  });
});
