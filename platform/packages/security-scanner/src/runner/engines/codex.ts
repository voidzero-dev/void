// Engine C: the Codex SDK for `openai/*` models (spec §8.1, §15.4). Each session is one
// `codex exec --ephemeral` started by the SDK through `codex-wrapper.sh`, which adds the
// lockdown flags the SDK cannot pass. Codex gets no shell and no built-in tool: only the
// `void-scan` MCP server (read_file, list_files, grep, submit_findings). It runs in an
// empty folder with its own CODEX_HOME, reaches the model only through the proxy, and has
// no key. The SDK sits in the Engine C image, not in the runner bundle.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path/posix';
import { validateFindingsLenient } from '../coerce.ts';
import { classifyCodexRun, safeLabel } from '../status.ts';
import type { CodexRunSignal } from '../status.ts';
import { count } from '../util.ts';
import { describeValidationError } from '../validate-findings.ts';
import { CONTAINER_CA_FILE, runSdkSession } from './proxy-failure.ts';
import type { Engine } from './types.ts';

export const CODEX_ENGINE_VERSION = 'codex-sdk/1';
const SDK_PACKAGE = '@openai/codex-sdk';

/** Where the Engine C image keeps its files (`image/Dockerfile.codex`). */
const CODEX_IMAGE = {
  wrapper: '/opt/void-scanner/codex-wrapper.sh',
  catalog: '/opt/void-scanner/codex-models.json',
  mcp: '/opt/void-scanner/void-scan-mcp.mjs',
  node: '/usr/local/bin/node',
  work: '/work',
  homeBase: '/home/scanner',
};
type CodexImagePaths = typeof CODEX_IMAGE;

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
const CODEX_FINAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['run_status', 'finding_count'],
  properties: {
    run_status: { type: 'string', enum: ['complete', 'incomplete'] },
    finding_count: { type: 'integer' },
  },
} as const;

type Json = Record<string, unknown>;
export type CodexEvent = { type: string } & Json;
export type CodexSdk = {
  Codex: new (options: {
    codexPathOverride: string;
    env: Record<string, string>;
    config: Json;
  }) => {
    startThread(options: Json): {
      runStreamed(
        prompt: string,
        options: { outputSchema: unknown; signal: AbortSignal },
      ): Promise<{ events: AsyncIterable<CodexEvent> }>;
    };
  };
};

export type CodexEngineOptions = {
  /** `openai/gpt-6.1-terra`; Codex gets `gpt-6.1-terra`. */
  model: string;
  /** The real directory that stands for `/scan`. */
  root: string;
  /** The proxy's Responses route, `http://model.void.internal/v1`. */
  baseUrl: string;
  fetch?: typeof fetch;
  loadSdk?: () => Promise<CodexSdk>;
  image?: Partial<CodexImagePaths>;
  caFile?: string;
};

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
}) {
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

/** A JSON file the MCP server wrote, or undefined when it is missing or unreadable. */
async function readJson(path: string): Promise<Json | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Json | undefined;
  } catch {
    return undefined;
  }
}

const safeText = (value: unknown): string => (typeof value === 'string' ? value.slice(0, 500) : '');

export function createCodexEngine(options: CodexEngineOptions): Engine {
  const image = { ...CODEX_IMAGE, ...options.image };
  const model = options.model.slice(options.model.indexOf('/') + 1);
  const session = {
    loadSdk: options.loadSdk ?? (async () => (await import(SDK_PACKAGE)) as CodexSdk),
    sdkName: 'Codex SDK',
    baseUrl: options.baseUrl,
    fetch: options.fetch ?? fetch,
  };

  return {
    id: 'codex_sdk',
    version: CODEX_ENGINE_VERSION,
    runSession: (spec) =>
      runSdkSession(spec, session, async ({ sdk, stats, abort, proxyStop }) => {
        // Not under /tmp: Codex refuses to make its helper links under a temp folder.
        const codexHome = join(image.homeBase, `codex-${randomUUID()}`);
        const reportPath = join(codexHome, 'findings.json');
        await mkdir(join(codexHome, 'log'), { recursive: true });
        await mkdir(join(codexHome, 'sqlite'), { recursive: true });
        const instructionsFile = join(codexHome, 'instructions.md');
        await writeFile(instructionsFile, spec.system);
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
              SSL_CERT_FILE: options.caFile ?? CONTAINER_CA_FILE,
            },
            config: codexConfig({
              baseUrl: options.baseUrl,
              session: spec.index,
              codexHome,
              instructionsFile,
              reportPath,
              root: options.root,
              maxRecords: spec.phase === 'verify' ? 1 : undefined,
              image,
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
            signal: abort.signal,
          });
          for await (const event of events) {
            if (event.type === 'item.completed') {
              const item = (event.item ?? {}) as Json;
              if (item.type === 'agent_message' && typeof item.text === 'string') {
                run.finalMessage = item.text;
              }
              if (item.type === 'mcp_tool_call' || item.type === 'agent_message') {
                stats.modelCalls++;
              }
            } else if (event.type === 'turn.completed') {
              const usage = (event.usage ?? {}) as Json;
              stats.inputTokens += count(usage.input_tokens);
              stats.outputTokens += count(usage.output_tokens);
              stats.turns++;
            } else if (event.type === 'turn.failed') {
              run.failure = { message: safeText((event.error as Json | undefined)?.message) };
            } else if (event.type === 'error') {
              run.failure = { message: safeText(event.message) };
            }
          }
        } catch (error) {
          // The SDK throws when `codex` exits non-zero or the abort fired.
          run.failure ??= {
            message: safeText(error instanceof Error ? error.message : String(error)),
          };
        }

        // The void-scan server counts the read_file calls that returned code.
        stats.reads = count((await readJson(`${reportPath}.reads`))?.count);
        const report = await readJson(reportPath);
        const rejected = await readJson(`${reportPath}.rejected`);
        await rm(codexHome, { recursive: true, force: true }).catch(() => undefined);
        if (spec.signal?.aborted) {
          return { kind: 'aborted' };
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
          run.proxyStop = await proxyStop();
        } else {
          const problem = spec.check?.(run.submitted) ?? null;
          if (problem !== null) {
            return { kind: 'bad_output', errorKind: 'shape', message: problem };
          }
        }
        return classifyCodexRun(run);
      }),
  };
}
