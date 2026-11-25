import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import {
  CLAUDE_DISALLOWED_TOOLS,
  claudeOptions,
  createClaudeEngine,
  createPathHook,
  createReadCounter,
} from '../../src/runner/engines/claude.ts';
import type { ClaudeMessage, ClaudeSdk } from '../../src/runner/engines/claude.ts';
import { fetchOf, spec } from '../helpers/engine.ts';

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
  await writeFile(join(root, 'input/empty.ts'), '  \n');
  await writeFile(join(dir, 'secret.txt'), 'token');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const DENY = { hookSpecificOutput: { permissionDecision: 'deny' } };

describe('Engine A (spec §15.3)', () => {
  test('three read tools, no repo settings or MCP servers, and no key in the env', () => {
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
    expect(options.tools).toEqual(['Read', 'Glob', 'Grep']);
    for (const name of ['Bash', 'Write', 'WebFetch', 'WebSearch', 'Agent', 'mcp__*']) {
      expect(CLAUDE_DISALLOWED_TOOLS).toContain(name);
    }
    // Planted AGENTS.md, CLAUDE.md, .mcp.json and .claude/settings.json are never config.
    expect(options).toMatchObject({
      permissionMode: 'dontAsk',
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      persistSession: false,
      cwd: '/scan/input',
    });
    const env = options.env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBe('placeholder-not-a-key');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://model.void.internal');
  });

  test('the path hook refuses escapes: symlinks, .., ~, brace roots and untrimmed paths', async () => {
    await symlink(join(dir, 'secret.txt'), join(root, 'input/link.txt'));
    const hook = createPathHook(root);
    const run = (tool_name: string, tool_input: Record<string, unknown>) =>
      hook({ tool_name, tool_input });
    expect(await run('Read', { file_path: join(root, 'input/a.ts') })).toEqual({});
    expect(await run('Glob', { pattern: 'src/**/*.ts' })).toEqual({});
    // A Grep pattern is search text: a relative one is not read as a path.
    expect(await run('Grep', { pattern: '../x' })).toEqual({});
    for (const file_path of [
      join(root, 'input/link.txt'),
      join(dir, 'secret.txt'),
      '~/.claude.json',
    ]) {
      expect(await run('Read', { file_path }), file_path).toMatchObject(DENY);
    }
    // Glob pattern escapes (spike S11).
    for (const pattern of ['../../**/*', '**/../../*', '{..,src}/*', '/{etc,tmp}/*', '~/**']) {
      expect(await run('Glob', { pattern }), pattern).toMatchObject(DENY);
    }
    // Claude Code trims a Glob or Grep path, so whitespace at either end is refused.
    for (const path of [` ${join(dir, 'outside')}`, ' ~', '.. ', ['/etc']]) {
      expect(await run('Grep', { pattern: 'x', path }), String(path)).toMatchObject(DENY);
      expect(await run('Glob', { pattern: '*', path }), String(path)).toMatchObject(DENY);
    }
  });

  test('only a Read that returned non-blank code under /scan/input counts', async () => {
    let reads = 0;
    const counter = createReadCounter(root, () => reads++);
    const read = (file_path: string, content: string) =>
      counter({
        tool_name: 'Read',
        tool_input: { file_path },
        tool_response: { type: 'text', file: { filePath: file_path, content } },
      });
    await read(join(root, 'memory/index.json'), '{"findings":[]}');
    await read(join(root, 'input/empty.ts'), '  \n');
    await read(join(root, 'input/../../secret.txt'), 'token');
    await counter({ tool_name: 'Glob', tool_input: { pattern: '**/*' }, tool_response: {} });
    expect(reads).toBe(0);
    await read(join(root, 'input/a.ts'), 'export {};');
    expect(reads).toBe(1);
  });

  test('a refusal reads its category from the assistant message; 402 is credits', async () => {
    const engine = (messages: Array<ClaudeMessage>) =>
      createClaudeEngine({
        model: 'anthropic/claude-sonnet-5.5',
        root,
        baseUrl: 'http://model.test',
        fetch: fetchOf([null]),
        configBase,
        loadSdk: async (): Promise<ClaudeSdk> => ({
          query: () =>
            (async function* () {
              yield* messages;
            })(),
        }),
      });
    // Claude Code puts stop_details on the assistant message only (spike S9 A1).
    const refused = await engine([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [],
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'cyber' },
        },
      },
      { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' },
    ]).runSession(spec());
    expect(refused).toMatchObject({ kind: 'refused', category: 'cyber' });
    const credits = await engine([
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'API Error: 402 Insufficient unified billing credits',
        num_turns: 1,
      },
    ]).runSession(spec());
    expect(credits.kind).toBe('credits');
    expect(await readdir(configBase)).toEqual([]);
  });
});
