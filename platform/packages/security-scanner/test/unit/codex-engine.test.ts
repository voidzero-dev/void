import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import {
  CODEX_FEATURES_OFF,
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
  model_providers: Record<string, unknown>;
};

type Seen = { env?: Record<string, string>; config?: Config };

/** A Codex SDK stand-in: the run emits `events`, after `act` (the MCP server's file writes). */
function sdkOf(
  events: Array<CodexEvent>,
  seen: Seen = {},
  act?: (reportPath: string) => Promise<void>,
): CodexSdk {
  return {
    Codex: class {
      constructor(options: { env: Record<string, string>; config: Record<string, unknown> }) {
        seen.env = options.env;
        seen.config = options.config as Config;
      }
      startThread() {
        return {
          runStreamed: async () => {
            const args = seen.config!.mcp_servers['void-scan'].args;
            await act?.(args[args.indexOf('--out') + 1]);
            return {
              events: (async function* () {
                yield* events;
              })(),
            };
          },
        };
      }
    },
  };
}

function engine(sdk: CodexSdk, failures: Array<unknown> = [null]) {
  return createCodexEngine({
    model: 'openai/gpt-6.1-terra',
    root: '/scan',
    baseUrl: 'http://model.test/v1',
    fetch: fetchOf(failures),
    loadSdk: async () => sdk,
    image: { homeBase: join(dir, 'home') },
  });
}

describe('Engine C (spec §15.4)', () => {
  test('no key, no retries, no shell, no repo instructions, only the void-scan MCP server', () => {
    const config = codexConfig({
      baseUrl: 'http://model.void.internal/v1',
      session: 4,
      codexHome: '/home/scanner/codex-x',
      instructionsFile: '/home/scanner/codex-x/instructions.md',
      reportPath: '/home/scanner/codex-x/findings.json',
      root: '/scan',
      maxRecords: 1,
    }) as Config;
    expect(config.model_providers['void-proxy']).toMatchObject({
      requires_openai_auth: false,
      request_max_retries: 0,
      stream_max_retries: 0,
    });
    expect(JSON.stringify({ ...config, features: undefined })).not.toMatch(
      /api_key|env_key|bearer/i,
    );
    // A planted AGENTS.md, .codex/config.toml or .agents/skills is never read as config.
    expect(config).toMatchObject({
      approval_policy: 'never',
      sandbox_mode: 'read-only',
      web_search: 'disabled',
      project_doc_max_bytes: 0,
      project_root_markers: [],
      skills: { include_instructions: false, bundled: { enabled: false } },
      projects: { '/scan': { trust_level: 'untrusted' } },
    });
    for (const name of ['shell_tool', 'unified_exec', 'plugins', 'hooks']) {
      expect(CODEX_FEATURES_OFF).toContain(name);
    }
    expect(Object.keys(config.mcp_servers)).toEqual(['void-scan']);
    expect(config.mcp_servers['void-scan']).toMatchObject({
      required: true,
      enabled_tools: ['read_file', 'list_files', 'grep', 'submit_findings'],
    });
  });

  test('a session runs with its own CODEX_HOME and leaves nothing behind', async () => {
    const seen: Seen = {};
    const act = async (path: string) => {
      await writeFile(path, JSON.stringify(report([confirmed()])));
      await writeFile(`${path}.reads`, JSON.stringify({ count: 1 }));
    };
    const done: Array<CodexEvent> = [
      { type: 'item.completed', item: { type: 'agent_message', text: '{"run_status":"x"}' } },
      { type: 'turn.completed', usage: { input_tokens: 900, output_tokens: 40 } },
    ];
    const outcome = await engine(sdkOf(done, seen, act)).runSession(spec());
    expect(outcome).toMatchObject({ kind: 'submitted', stats: { reads: 1 } });
    expect(Object.keys(seen.env!).sort()).toEqual(['CODEX_HOME', 'HOME', 'PATH', 'SSL_CERT_FILE']);
    expect(seen.env!.CODEX_HOME).toContain(join(dir, 'home'));
    expect(await readdir(join(dir, 'home'))).toEqual([]);
  });

  test('a cyber policy error is a refusal; 402 comes from the proxy', async () => {
    const blocked = await engine(
      sdkOf([{ type: 'turn.failed', error: { message: 'request blocked: cyber_policy' } }]),
    ).runSession(spec());
    expect(blocked).toMatchObject({ kind: 'refused', category: 'cyber_policy' });
    const credits = await engine(
      sdkOf([{ type: 'turn.failed', error: { message: 'unexpected status 402' } }]),
      [null, { reason: 'credits', httpStatus: 402, at: 5 }],
    ).runSession(spec());
    expect(credits.kind).toBe('credits');
  });
});
