// Engine A: the Claude Agent SDK for `anthropic/*` models (spec §8.1, §15.3). Each hunt or
// verify session is one `query()`: three read tools only, no shell, no web, no sub-agents,
// no settings or MCP servers, an explicit env with no token, and a hook that refuses paths
// outside the scan folders. The SDK sits in the Engine A image, not in the runner bundle, so
// it is loaded when the first session starts.

import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { submitFindingsParameters } from '../report.ts';
import { classifyClaudeResult, safeLabel } from '../status.ts';
import type { OutcomeBody } from '../status.ts';
import { readLastFailure, stopSince } from './proxy-failure.ts';
import { emptyStats } from './types.ts';
import type { Engine, SessionOutcome, SessionSpec } from './types.ts';

export const CLAUDE_ENGINE_VERSION = 'agent-sdk/1';
export const CLAUDE_BASE_URL = 'http://model.void.internal';
export const CLAUDE_CA_FILE = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
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

/** The slice of an Agent SDK message the engine reads. */
export type ClaudeMessage = { type: string; subtype?: string } & Record<string, unknown>;
export type ClaudeQuery = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<ClaudeMessage>;
export type ClaudeSdk = { query: ClaudeQuery };

export type ClaudeEngineOptions = {
  /** `anthropic/claude-sonnet-5.5`; the gateway name `claude-sonnet-5.5` goes to the SDK. */
  model: string;
  /** The real directory that stands for `/scan`. */
  root: string;
  baseUrl?: string;
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

async function defaultLoadSdk(): Promise<ClaudeSdk> {
  // A variable specifier keeps the SDK out of the bundle; the Engine A image installs it.
  return (await import(SDK_PACKAGE)) as ClaudeSdk;
}

export function gatewayName(model: string): string {
  return model.slice(model.indexOf('/') + 1);
}

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
  hook: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** PostToolUse: sees what a Read returned (`stats.reads`). */
  afterTool: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onStderr: (data: string) => void;
}): Record<string, unknown> {
  const { root } = input;
  return {
    cwd: `${root}/input`,
    additionalDirectories: [`${root}/memory`],
    model: gatewayName(input.model),
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

/** PreToolUse hook: only paths under `<root>/input` and `<root>/memory`, after realpath. */
export function createPathHook(root: string) {
  const allowed = [`${root}/input`, `${root}/memory`].map(real);
  const under = (candidate: unknown): boolean => {
    if (candidate === undefined || candidate === '') {
      return true;
    }
    if (typeof candidate !== 'string' || candidate !== candidate.trim()) {
      // Claude Code trims a Glob or Grep `path` before it reads `~` or resolves it, and
      // Glob and Grep reach the hook untrimmed: ` /etc` would resolve to a folder named
      // ` ` under input here and to `/etc` there. Read reaches it already normalized.
      return false;
    }
    if (candidate.startsWith('~')) {
      // Claude Code reads `~` as its home (the config folder), not as a name in the cwd.
      return false;
    }
    const absolute = resolve(real(`${root}/input`), candidate);
    // A missing file is judged by its lexical path.
    const resolved = real(absolute);
    return allowed.some((base) => resolved === base || resolved.startsWith(`${base}/`));
  };
  return async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const paths = [toolInput.file_path, toolInput.path, toolInput.notebook_path];
    const pattern = toolInput.pattern;
    if (typeof pattern === 'string') {
      if (input.tool_name === 'Grep') {
        // A Grep pattern is search text; only an absolute one is checked, as before.
        if (pattern.startsWith('/')) {
          paths.push(pattern);
        }
      } else {
        // A Glob pattern is a path: `../../**/*` lists names outside the scan folders.
        const reach = globReach(pattern, toolInput.path);
        if (reach === null) {
          return deny();
        }
        paths.push(reach);
      }
    }
    if (paths.every(under)) {
      return {};
    }
    return deny();
  };
}

/**
 * PostToolUse hook: counts a Read that returned text from a file under `<root>/input`
 * (`stats.reads`). A list, a search, a memory read, a failed Read or an empty answer
 * does not count: a session must have seen code before its report can clear any.
 */
export function createReadCounter(root: string, onRead: () => void) {
  const input = real(`${root}/input`);
  return async (event: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (event.tool_name !== 'Read') {
      return {};
    }
    // Read reaches the hooks with `file_path` already made absolute (S11 follow-up probe).
    const path = (event.tool_input as Record<string, unknown> | undefined)?.file_path;
    const response = event.tool_response as Record<string, unknown> | undefined;
    const file = response?.file as Record<string, unknown> | undefined;
    if (
      typeof path !== 'string' ||
      response?.type !== 'text' ||
      typeof file?.content !== 'string' ||
      file.content.trim() === ''
    ) {
      return {};
    }
    const resolved = real(resolve(input, path));
    if (resolved.startsWith(`${input}/`)) {
      onRead();
    }
    return {};
  };
}

function deny(): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Only files under /scan/input and /scan/memory can be read.',
    },
  };
}

const GLOB_CHARS = ['*', '?', '[', '{'];

/**
 * The folder a Glob pattern can reach: its fixed leading segments, under the search
 * folder. `null` when the pattern could climb out in a way that prefix cannot show:
 * a `..` anywhere, a `~` home, a backslash escape, or a brace choice that starts a
 * new root (`{/etc,src}/*`).
 */
export function globReach(pattern: string, searchPath: unknown): string | null {
  if (pattern.includes('..') || pattern.startsWith('~') || pattern.includes('\\')) {
    return null;
  }
  let previous = '';
  for (const char of pattern) {
    if ((previous === '{' || previous === ',') && (char === '/' || char === '~')) {
      return null;
    }
    previous = char;
  }
  const fixed: Array<string> = [];
  for (const segment of pattern.split('/')) {
    if (GLOB_CHARS.some((char) => segment.includes(char))) {
      break;
    }
    fixed.push(segment);
  }
  const prefix = fixed.join('/');
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

/** The report schema without the size keywords structured output does not take; `validate-findings` still enforces them. */
export function structuredOutputSchema(): Record<string, unknown> {
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
  return strip(submitFindingsParameters()) as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stopCategory(details: unknown): string | null {
  return typeof details === 'object' && details !== null
    ? text((details as Record<string, unknown>).category)
    : null;
}

function assistantRefused(message: ClaudeMessage): boolean {
  const inner = message.message;
  return (
    typeof inner === 'object' &&
    inner !== null &&
    (inner as Record<string, unknown>).stop_reason === 'refusal'
  );
}

/** The refusal category on an assistant message that stopped with `refusal`. */
function assistantRefusalCategory(message: ClaudeMessage): string | null {
  return assistantRefused(message)
    ? stopCategory((message.message as Record<string, unknown>).stop_details)
    : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function createClaudeEngine(options: ClaudeEngineOptions): Engine {
  const baseUrl = options.baseUrl ?? CLAUDE_BASE_URL;
  const doFetch = options.fetch ?? fetch;
  const loadSdk = options.loadSdk ?? defaultLoadSdk;

  return {
    id: 'agent_sdk',
    version: CLAUDE_ENGINE_VERSION,
    async runSession(spec: SessionSpec): Promise<SessionOutcome> {
      const stats = emptyStats();
      const done = (outcome: OutcomeBody): SessionOutcome => ({ ...outcome, stats });
      if (spec.signal?.aborted) {
        return done({ kind: 'aborted' });
      }
      let sdk: ClaudeSdk;
      try {
        sdk = await loadSdk();
      } catch {
        return done({
          kind: 'infrastructure',
          errorClass: 'engine_unavailable',
          detail: 'the Agent SDK is not in this scanner image',
        });
      }
      const abortController = new AbortController();
      const stop = () => abortController.abort();
      spec.signal?.addEventListener('abort', stop, { once: true });
      const configDir = await mkdtemp(join(options.configBase ?? '/home/scanner', 'claude-'));
      const before = await readLastFailure(baseUrl, doFetch, spec.signal);
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
            caFile: options.caFile ?? CLAUDE_CA_FILE,
            abortController,
            hook: createPathHook(options.root),
            afterTool: createReadCounter(options.root, () => stats.reads++),
            onStderr: () => undefined,
          }),
        });
        for await (const message of messages) {
          if (message.type === 'result') {
            result = message;
          } else if (message.type === 'assistant' && assistantRefused(message)) {
            refusalSeen = true;
            refusalCategory = assistantRefusalCategory(message) ?? refusalCategory;
          }
        }
      } catch {
        failed = true;
      } finally {
        spec.signal?.removeEventListener('abort', stop);
        await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (spec.signal?.aborted) {
        return done({ kind: 'aborted' });
      }
      if (result !== null) {
        const turns = count(result.num_turns);
        stats.turns = turns;
        stats.modelCalls = turns;
        const usage = (result.usage ?? {}) as Record<string, unknown>;
        stats.inputTokens =
          count(usage.input_tokens) +
          count(usage.cache_creation_input_tokens) +
          count(usage.cache_read_input_tokens);
        stats.outputTokens = count(usage.output_tokens);
      }
      const submittedOutput = result?.structured_output;
      const needsReason =
        failed || result === null || result.is_error === true || submittedOutput === undefined;
      const proxyStop = needsReason
        ? stopSince(before, await readLastFailure(baseUrl, doFetch, spec.signal))
        : null;
      if (result === null) {
        return done(
          proxyStop
            ? classifyClaudeResult({ subtype: 'error_during_execution', proxyStop })
            : {
                kind: 'infrastructure',
                errorClass: 'agent_sdk_error',
                detail: 'the Agent SDK stopped without a result',
              },
        );
      }
      const outcome = classifyClaudeResult({
        subtype: safeLabel(String(result.subtype ?? '')),
        // A refused turn with no report is a refusal, whatever the result says after it
        // (an `is_error` result, or a stop reason a later turn wrote over).
        stopReason:
          refusalSeen && submittedOutput === undefined ? 'refusal' : text(result.stop_reason),
        stopCategory: stopCategory(result.stop_details) ?? refusalCategory,
        structuredOutput: submittedOutput,
        isError: result.is_error === true,
        resultText: text(result.result),
        proxyStop,
      });
      if (outcome.kind === 'submitted') {
        const problem = spec.check?.(outcome.report) ?? null;
        if (problem !== null) {
          return done({ kind: 'bad_output', errorKind: 'shape', message: problem });
        }
      }
      return done(outcome);
    },
  };
}
