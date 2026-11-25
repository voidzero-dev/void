// Engine A: the Claude Agent SDK for `anthropic/*` models (spec §8.1, §15.3). Each hunt or
// verify session is one `query()`: three read tools only, no shell, no web, no sub-agents,
// no settings or MCP servers, an explicit env with no token, and a hook that refuses paths
// outside the scan folders. The SDK sits in the Engine A image, not in the runner bundle.

import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path/posix';
import { submitFindingsParameters } from '../report.ts';
import { classifyClaudeResult, safeLabel } from '../status.ts';
import { count } from '../util.ts';
import { CONTAINER_CA_FILE, runSdkSession } from './proxy-failure.ts';
import type { Engine } from './types.ts';

export const CLAUDE_ENGINE_VERSION = 'agent-sdk/1';
const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

export const CLAUDE_TOOLS = ['Read', 'Glob', 'Grep'] as const;
export const CLAUDE_DISALLOWED_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Skill',
  'Agent',
  'Task',
  'mcp__*',
] as const;

type Json = Record<string, unknown>;
/** The slice of an Agent SDK message the engine reads. */
export type ClaudeMessage = { type: string; subtype?: string } & Json;
export type ClaudeSdk = {
  query: (args: { prompt: string; options: Json }) => AsyncIterable<ClaudeMessage>;
};
type Hook = (input: Json) => Promise<Json>;

export type ClaudeEngineOptions = {
  /** `anthropic/claude-sonnet-5.5`; the gateway name `claude-sonnet-5.5` goes to the SDK. */
  model: string;
  /** The real directory that stands for `/scan`. */
  root: string;
  baseUrl: string;
  fetch?: typeof fetch;
  /** Where each session's config folder is made. Default: the scanner user's home. */
  configBase?: string;
  loadSdk?: () => Promise<ClaudeSdk>;
  caFile?: string;
};

const ENGINE_NOTE = [
  'Engine note: in this environment the file tools are named Read, Glob and Grep (Grep takes a pattern; treat it as plain text). Use absolute paths under /scan/input or /scan/memory.',
  'There is no submit_findings tool here. End the session with the structured output: the same fields as the report described above, exactly once.',
].join('\n');

/** The SDK `options` for one session. Pure, so a test can pin every lockdown setting. */
export function claudeOptions(input: {
  model: string;
  root: string;
  system: string;
  maxTurns: number;
  session: number;
  baseUrl: string;
  configDir: string;
  caFile: string;
  abortController: AbortController;
  hook: Hook;
  /** PostToolUse: sees what a Read returned (`stats.reads`). */
  afterTool: Hook;
  onStderr: (data: string) => void;
}) {
  return {
    cwd: `${input.root}/input`,
    additionalDirectories: [`${input.root}/memory`],
    model: input.model.slice(input.model.indexOf('/') + 1),
    systemPrompt: `${input.system}\n\n${ENGINE_NOTE}`,
    tools: [...CLAUDE_TOOLS],
    allowedTools: [...CLAUDE_TOOLS],
    disallowedTools: [...CLAUDE_DISALLOWED_TOOLS],
    permissionMode: 'dontAsk',
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    persistSession: false,
    outputFormat: { type: 'json_schema', schema: structuredOutputSchema() },
    maxTurns: input.maxTurns,
    abortController: input.abortController,
    hooks: {
      PreToolUse: [{ hooks: [input.hook] }],
      PostToolUse: [{ matcher: 'Read', hooks: [input.afterTool] }],
    },
    stderr: input.onStderr,
    // Replaces the environment: no token of any kind, only the proxy route.
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: input.configDir,
      CLAUDE_CONFIG_DIR: input.configDir,
      ANTHROPIC_BASE_URL: input.baseUrl,
      ANTHROPIC_API_KEY: 'placeholder-not-a-key',
      ANTHROPIC_CUSTOM_HEADERS: `x-void-scan-session: ${input.session}`,
      // A refused call is retried a little, not for minutes (spike S2: a 401 took 120 s).
      CLAUDE_CODE_MAX_RETRIES: '2',
      // A refused turn ends refused; it is never retried on another model.
      CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL: '0',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      // Lets HTTPS to any other host finish TLS against the controller's intercept, so
      // its deny handler records the attempt.
      NODE_EXTRA_CA_CERTS: input.caFile,
    },
  };
}

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const DENY = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'Only files under /scan/input and /scan/memory can be read.',
  },
};

/** PreToolUse hook: only paths under `<root>/input` and `<root>/memory`, after realpath. */
export function createPathHook(root: string): Hook {
  const allowed = [`${root}/input`, `${root}/memory`].map(real);
  const under = (candidate: unknown): boolean => {
    if (candidate === undefined || candidate === '') {
      return true;
    }
    // Claude Code trims a Glob or Grep `path` before it resolves it, and they reach the
    // hook untrimmed: ` /etc` would be a folder named ` ` here and `/etc` there. It also
    // reads `~` as its home (the config folder), not as a name in the cwd.
    if (
      typeof candidate !== 'string' ||
      candidate !== candidate.trim() ||
      candidate.startsWith('~')
    ) {
      return false;
    }
    // A missing file is judged by its lexical path.
    const resolved = real(resolve(real(`${root}/input`), candidate));
    return allowed.some((base) => resolved === base || resolved.startsWith(`${base}/`));
  };
  return async (input) => {
    const toolInput = (input.tool_input ?? {}) as Json;
    const paths = [toolInput.file_path, toolInput.path, toolInput.notebook_path];
    const pattern = toolInput.pattern;
    if (typeof pattern === 'string') {
      if (input.tool_name !== 'Grep') {
        // A Glob pattern is a path: `../../**/*` lists names outside the scan folders.
        const reach = globReach(pattern, toolInput.path);
        if (reach === null) {
          return DENY;
        }
        paths.push(reach);
      } else if (pattern.startsWith('/')) {
        // A Grep pattern is search text; only an absolute one is checked.
        paths.push(pattern);
      }
    }
    return paths.every(under) ? {} : DENY;
  };
}

/**
 * PostToolUse hook: counts a Read that returned non-blank text from a file under
 * `<root>/input` (`stats.reads`). Read reaches the hooks with `file_path` already absolute.
 */
export function createReadCounter(root: string, onRead: () => void): Hook {
  const input = real(`${root}/input`);
  return async (event) => {
    const path = (event.tool_input as Json | undefined)?.file_path;
    const response = event.tool_response as Json | undefined;
    const content = (response?.file as Json | undefined)?.content;
    if (
      event.tool_name === 'Read' &&
      typeof path === 'string' &&
      response?.type === 'text' &&
      typeof content === 'string' &&
      content.trim() !== '' &&
      real(resolve(input, path)).startsWith(`${input}/`)
    ) {
      onRead();
    }
    return {};
  };
}

const GLOB_CHARS = ['*', '?', '[', '{'];

/**
 * The folder a Glob pattern can reach: its fixed leading segments, under the search
 * folder. `null` when the pattern could climb out in a way that prefix cannot show:
 * a `..` anywhere, a `~` home, a backslash escape, or a brace choice that starts a
 * new root (`{/etc,src}/*`).
 */
function globReach(pattern: string, searchPath: unknown): string | null {
  if (pattern.includes('..') || pattern.startsWith('~') || pattern.includes('\\')) {
    return null;
  }
  for (let index = 1; index < pattern.length; index++) {
    if ('{,'.includes(pattern[index - 1]) && '/~'.includes(pattern[index])) {
      return null;
    }
  }
  const segments = pattern.split('/');
  const cut = segments.findIndex((segment) => GLOB_CHARS.some((char) => segment.includes(char)));
  const prefix = (cut === -1 ? segments : segments.slice(0, cut)).join('/');
  if (pattern.startsWith('/')) {
    // An absolute pattern ignores the search folder.
    return prefix === '' ? '/' : prefix;
  }
  const base = typeof searchPath === 'string' && searchPath !== '' ? searchPath : '.';
  // `under` resolves this against /scan/input, as Glob does without a path.
  return `${base}/${prefix}`;
}

const UNSUPPORTED_SCHEMA_KEYS = new Set([
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'description',
]);

/** The report schema without the keywords structured output does not take; the validator still enforces them. */
function structuredOutputSchema(): Json {
  // oxlint-disable-next-line quality/no-unknown-returns -- Walks an arbitrary JSON Schema tree.
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(strip);
    }
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !UNSUPPORTED_SCHEMA_KEYS.has(key))
          .map(([key, item]) => [key, strip(item)]),
      );
    }
    return value;
  };
  return strip(submitFindingsParameters()) as Json;
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const category = (details: unknown): string | null =>
  typeof details === 'object' && details !== null ? text((details as Json).category) : null;

export function createClaudeEngine(options: ClaudeEngineOptions): Engine {
  const { baseUrl } = options;
  const session = {
    // A variable specifier keeps the SDK out of the bundle; the Engine A image installs it.
    loadSdk: options.loadSdk ?? (async () => (await import(SDK_PACKAGE)) as ClaudeSdk),
    sdkName: 'Agent SDK',
    baseUrl,
    fetch: options.fetch ?? fetch,
  };
  return {
    id: 'agent_sdk',
    version: CLAUDE_ENGINE_VERSION,
    runSession: (spec) =>
      runSdkSession(spec, session, async ({ sdk, stats, abort, proxyStop }) => {
        const configDir = await mkdtemp(join(options.configBase ?? '/home/scanner', 'claude-'));
        let result: ClaudeMessage | null = null;
        // Claude Code puts `stop_details` on the assistant message, not on the result.
        let refusalSeen = false;
        let refusalCategory: string | null = null;
        let failed = false;
        try {
          const messages = sdk.query({
            prompt: spec.prompt,
            options: claudeOptions({
              model: options.model,
              root: options.root,
              system: spec.system,
              maxTurns: spec.maxTurns,
              session: spec.index,
              baseUrl,
              configDir,
              caFile: options.caFile ?? CONTAINER_CA_FILE,
              abortController: abort,
              hook: createPathHook(options.root),
              afterTool: createReadCounter(options.root, () => stats.reads++),
              onStderr: () => undefined,
            }),
          });
          for await (const message of messages) {
            const inner = message.message as Json | undefined;
            if (message.type === 'result') {
              result = message;
            } else if (message.type === 'assistant' && inner?.stop_reason === 'refusal') {
              refusalSeen = true;
              refusalCategory = category(inner.stop_details) ?? refusalCategory;
            }
          }
        } catch {
          failed = true;
        } finally {
          await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
        }
        if (spec.signal?.aborted) {
          return { kind: 'aborted' };
        }
        if (result !== null) {
          stats.turns = stats.modelCalls = count(result.num_turns);
          const usage = (result.usage ?? {}) as Json;
          stats.inputTokens =
            count(usage.input_tokens) +
            count(usage.cache_creation_input_tokens) +
            count(usage.cache_read_input_tokens);
          stats.outputTokens = count(usage.output_tokens);
        }
        const output = result?.structured_output;
        const stop =
          failed || result === null || result.is_error === true || output === undefined
            ? await proxyStop()
            : null;
        if (result === null) {
          return stop
            ? classifyClaudeResult({ subtype: 'error_during_execution', proxyStop: stop })
            : {
                kind: 'infrastructure',
                errorClass: 'agent_sdk_error',
                detail: 'the Agent SDK stopped without a result',
              };
        }
        const outcome = classifyClaudeResult({
          subtype: safeLabel(String(result.subtype ?? '')),
          // A refused turn with no report is a refusal, whatever the result says after it.
          stopReason: refusalSeen && output === undefined ? 'refusal' : text(result.stop_reason),
          stopCategory: category(result.stop_details) ?? refusalCategory,
          structuredOutput: output,
          isError: result.is_error === true,
          resultText: text(result.result),
          proxyStop: stop,
        });
        const problem =
          outcome.kind === 'submitted' ? (spec.check?.(outcome.report) ?? null) : null;
        return problem === null
          ? outcome
          : { kind: 'bad_output', errorKind: 'shape', message: problem };
      }),
  };
}
