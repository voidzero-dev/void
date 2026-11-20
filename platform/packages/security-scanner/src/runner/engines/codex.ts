// Engine C: the Codex SDK for `openai/*` models (spec §8.1, §15.4). Each session is one
// `codex exec --ephemeral` started by the SDK through `codex-wrapper.sh`, which adds the
// lockdown flags the SDK cannot pass. Codex gets no shell and no built-in tool: only the
// `void-scan` MCP server (read_file, list_files, grep, submit_findings). It runs in an
// empty folder with its own CODEX_HOME, reaches the model only through the proxy, and has
// no key. The SDK sits in the Engine C image, so it is loaded when the first session starts.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateFindingsLenient } from '../coerce.ts';
import { classifyCodexRun, safeLabel, type CodexRunSignal, type OutcomeBody } from '../status.ts';
import { describeValidationError } from '../validate-findings.ts';
import { readLastFailure, stopSince } from './proxy-failure.ts';
import { emptyStats, type Engine, type SessionOutcome, type SessionSpec } from './types.ts';

export const CODEX_ENGINE_VERSION = 'codex-sdk/1';
export const CODEX_BASE_URL = 'http://model.void.internal/v1';
export const CODEX_CA_FILE = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
const SDK_PACKAGE = '@openai/codex-sdk';

/** Where the Engine C image keeps its files (`image/Dockerfile.codex`). */
export type CodexImagePaths = {
  wrapper: string;
  catalog: string;
  mcp: string;
  node: string;
  work: string;
  homeBase: string;
};

export const CODEX_IMAGE: CodexImagePaths = {
  wrapper: '/opt/void-scanner/codex-wrapper.sh',
  catalog: '/opt/void-scanner/codex-models.json',
  mcp: '/opt/void-scanner/void-scan-mcp.mjs',
  node: '/usr/local/bin/node',
  work: '/work',
  homeBase: '/home/scanner',
};

/** Codex features turned off, one by one (spec §15.4; S3 checked each name). */
export const CODEX_FEATURES_OFF = [
  'shell_tool',
  'unified_exec',
  'shell_snapshot',
  'sleep_tool',
  'multi_agent',
  'multi_agent_v2',
  'apps',
  'plugins',
  'remote_plugin',
  'plugin_sharing',
  'tool_suggest',
  'memories',
  'image_generation',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_browser',
  'hooks',
  'api_key_model_discovery',
  'api_key_cyber_access_programs',
  'code_mode',
  'code_mode_host',
  'code_mode_only',
  'skill_search',
  'skill_mcp_dependency_install',
  'goals',
  'daemon_auto_start',
  'in_app_updates',
  'enable_request_compression',
  'view_image',
] as const;

/** The final message is held to this status; the report itself goes through `submit_findings`. */
export const CODEX_FINAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['run_status', 'finding_count'],
  properties: {
    run_status: { type: 'string', enum: ['complete', 'incomplete'] },
    finding_count: { type: 'integer' },
  },
} as const;

export type CodexEvent = { type: string } & Record<string, unknown>;
export type CodexThread = {
  runStreamed(
    prompt: string,
    options: { outputSchema: unknown; signal: AbortSignal },
  ): Promise<{ events: AsyncIterable<CodexEvent> }>;
};
export type CodexSdk = {
  Codex: new (options: {
    codexPathOverride: string;
    env: Record<string, string>;
    config: Record<string, unknown>;
  }) => {
    startThread(options: Record<string, unknown>): CodexThread;
  };
};

export type CodexEngineOptions = {
  /** `openai/gpt-6.1-terra`; Codex gets `gpt-6.1-terra`. */
  model: string;
  /** The real directory that stands for `/scan`. */
  root: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  loadSdk?: () => Promise<CodexSdk>;
  image?: Partial<CodexImagePaths>;
  caFile?: string;
};

async function defaultLoadSdk(): Promise<CodexSdk> {
  return (await import(SDK_PACKAGE)) as CodexSdk;
}

/** The `--config` values for one session. Pure, so a test can pin every setting. */
export function codexConfig(input: {
  baseUrl: string;
  session: number;
  codexHome: string;
  instructionsFile: string;
  reportPath: string;
  root: string;
  maxRecords?: number;
  image?: Partial<CodexImagePaths>;
}): Record<string, unknown> {
  const image = { ...CODEX_IMAGE, ...input.image };
  return {
    model_provider: 'void-proxy',
    model_providers: {
      'void-proxy': {
        name: 'void-proxy',
        base_url: input.baseUrl,
        wire_api: 'responses',
        requires_openai_auth: false,
        supports_websockets: false,
        // The proxy meters sessions by this header; no key, no auth header at all.
        http_headers: { 'x-void-scan-session': String(input.session) },
        // Codex retries a 402 five times by default (spike S3); the runner asks the proxy why instead.
        request_max_retries: 0,
        stream_max_retries: 0,
      },
    },
    model_catalog_json: image.catalog,
    model_instructions_file: input.instructionsFile,
    approval_policy: 'never',
    sandbox_mode: 'read-only',
    web_search: 'disabled',
    project_doc_max_bytes: 0,
    project_root_markers: [],
    check_for_update_on_startup: false,
    tool_output_token_limit: 8000,
    sqlite_home: `${input.codexHome}/sqlite`,
    log_dir: `${input.codexHome}/log`,
    analytics: { enabled: false },
    feedback: { enabled: false },
    history: { persistence: 'none' },
    features: Object.fromEntries(CODEX_FEATURES_OFF.map((name) => [name, false])),
    mcp_servers: {
      'void-scan': {
        command: image.node,
        args: [
          image.mcp,
          '--root',
          input.root,
          '--out',
          input.reportPath,
          ...(input.maxRecords === undefined ? [] : ['--max-records', String(input.maxRecords)]),
        ],
        required: true,
        enabled_tools: ['read_file', 'list_files', 'grep', 'submit_findings'],
        default_tools_approval_mode: 'approve',
      },
    },
    projects: { '/scan': { trust_level: 'untrusted' }, [image.work]: { trust_level: 'untrusted' } },
    skills: { include_instructions: false, bundled: { enabled: false } },
  };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

async function readJson(path: string): Promise<unknown> {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export function createCodexEngine(options: CodexEngineOptions): Engine {
  const baseUrl = options.baseUrl ?? CODEX_BASE_URL;
  const doFetch = options.fetch ?? fetch;
  const loadSdk = options.loadSdk ?? defaultLoadSdk;
  const image = { ...CODEX_IMAGE, ...options.image };
  const model = options.model.slice(options.model.indexOf('/') + 1);

  return {
    id: 'codex_sdk',
    version: CODEX_ENGINE_VERSION,
    async runSession(spec: SessionSpec): Promise<SessionOutcome> {
      const stats = emptyStats();
      const done = (outcome: OutcomeBody): SessionOutcome => ({ ...outcome, stats });
      if (spec.signal?.aborted) {
        return done({ kind: 'aborted' });
      }
      let sdk: CodexSdk;
      try {
        sdk = await loadSdk();
      } catch {
        return done({
          kind: 'infrastructure',
          errorClass: 'engine_unavailable',
          detail: 'the Codex SDK is not in this scanner image',
        });
      }
      // Not under /tmp: Codex refuses to make its helper links under a temp folder.
      const codexHome = join(image.homeBase, `codex-${randomUUID()}`);
      const reportPath = join(codexHome, 'findings.json');
      await mkdir(join(codexHome, 'log'), { recursive: true });
      await mkdir(join(codexHome, 'sqlite'), { recursive: true });
      const instructionsFile = join(codexHome, 'instructions.md');
      await writeFile(instructionsFile, spec.system);
      const signal = new AbortController();
      const stop = () => signal.abort();
      spec.signal?.addEventListener('abort', stop, { once: true });
      const before = await readLastFailure(baseUrl, doFetch, spec.signal);

      const run: CodexRunSignal = {
        submitted: null,
        rejected: null,
        failure: null,
        finalMessage: null,
        exitCode: null,
        proxyStop: null,
      };
      try {
        const codex = new sdk.Codex({
          codexPathOverride: image.wrapper,
          // Explicit env: no process.env and no CODEX_API_KEY.
          env: {
            PATH: '/usr/local/bin:/usr/bin:/bin',
            HOME: codexHome,
            CODEX_HOME: codexHome,
            SSL_CERT_FILE: options.caFile ?? CODEX_CA_FILE,
          },
          config: codexConfig({
            baseUrl,
            session: spec.index,
            codexHome,
            instructionsFile,
            reportPath,
            root: options.root,
            maxRecords: spec.phase === 'verify' ? 1 : undefined,
            image: options.image,
          }),
        });
        const thread = codex.startThread({
          model,
          workingDirectory: image.work,
          sandboxMode: 'read-only',
          approvalPolicy: 'never',
          webSearchMode: 'disabled',
        });
        const { events } = await thread.runStreamed(spec.prompt, {
          outputSchema: CODEX_FINAL_SCHEMA,
          signal: signal.signal,
        });
        for await (const event of events) {
          if (event.type === 'item.completed') {
            const item = (event.item ?? {}) as Record<string, unknown>;
            if (item.type === 'agent_message' && typeof item.text === 'string') {
              run.finalMessage = item.text;
            }
            if (item.type === 'mcp_tool_call' || item.type === 'agent_message') {
              stats.modelCalls++;
            }
            // A read, list or search on the void-scan server that answered.
            if (
              item.type === 'mcp_tool_call' &&
              item.tool !== 'submit_findings' &&
              item.status !== 'failed' &&
              item.error == null
            ) {
              stats.reads++;
            }
          } else if (event.type === 'turn.completed') {
            const usage = (event.usage ?? {}) as Record<string, unknown>;
            stats.inputTokens += count(usage.input_tokens);
            stats.outputTokens += count(usage.output_tokens);
            stats.turns++;
          } else if (event.type === 'turn.failed') {
            const error = (event.error ?? {}) as Record<string, unknown>;
            run.failure = { code: null, message: safeText(error.message) };
          } else if (event.type === 'error') {
            run.failure = { code: null, message: safeText(event.message) };
          }
        }
      } catch (error) {
        // The SDK throws when `codex` exits non-zero or the abort fired.
        run.failure ??= {
          code: null,
          message: safeText(error instanceof Error ? error.message : String(error)),
        };
      } finally {
        spec.signal?.removeEventListener('abort', stop);
      }

      const report = await readJson(reportPath);
      const rejected = (await readJson(`${reportPath}.rejected`)) as
        | { kind?: unknown; message?: unknown }
        | undefined;
      await rm(codexHome, { recursive: true, force: true }).catch(() => undefined);
      if (spec.signal?.aborted) {
        return done({ kind: 'aborted' });
      }
      if (report !== undefined) {
        const checked = validateFindingsLenient(report);
        if (checked.ok) {
          run.submitted = checked.report;
        } else {
          run.rejected = { kind: checked.kind, message: describeValidationError(checked) };
        }
      } else if (rejected !== undefined) {
        run.rejected = {
          kind: typeof rejected.kind === 'string' ? safeLabel(rejected.kind) : 'shape',
          message: typeof rejected.message === 'string' ? rejected.message : 'report refused',
        };
      }
      if (run.submitted === null) {
        run.proxyStop = stopSince(before, await readLastFailure(baseUrl, doFetch, spec.signal));
      } else {
        const problem = spec.check?.(run.submitted) ?? null;
        if (problem !== null) {
          return done({ kind: 'bad_output', errorKind: 'shape', message: problem });
        }
      }
      return done(classifyCodexRun(run));
    },
  };
}

function safeText(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 500) : '';
}
