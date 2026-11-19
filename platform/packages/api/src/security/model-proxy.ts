/**
 * The security scan model proxy (spec §15.1, §16): the only way a scanner container
 * reaches a model. `SecurityScanControl.model()` calls it with the scan id and attempt
 * from the controller's outbound handler props; nothing the container sends names
 * the scan.
 *
 *   runner ─► model.void.internal ─► controller outbound ─► SecurityScanControl.model
 *     │ fence: current attempt, running, inside the lease, project not deleting
 *     │ model: body.model == scan.model_used, on the list, not blocked, priced,
 *     │        third party: host passed probe check 5 and the project accepted the notice
 *     │ caps:  calls per session (40, scheduler DO) · calls per scan · tokens per scan
 *     │ rate:  `@cf` token from the scheduler DO (waiting does not count as a call)
 *     │ money: worst case held on both spend rows in the statement that checks the cap
 *     ▼
 *   @cf/*        env.AI.run, gateway options set here
 *   anthropic/*  REST /ai/v1/messages  ┐ fixed cf-aig-* headers, the caller's dropped
 *   openai/*     REST /ai/v1/responses ┘ + access_programs {cyber: standard}
 *     │ body:  only function / custom tools; no mcp_servers, container, background;
 *     │        anthropic-beta values on an allowlist (provider-run tools reach other
 *     │        hosts the container egress lock cannot see, spec T2)
 *     │
 *     ▼ usage read from the JSON answer or the SSE stream ─► settle (real cost)
 *
 * A refused call answers non-2xx. A stop the runner must act on carries
 * `x-void-scan-stop: session_calls|scan_calls|tokens|budget|credits` (402 for credits);
 * anything else is retried once by the runner, then `failed (infrastructure)`.
 * `GET /v1/void/last-failure` returns the last refused or failed call, for engines
 * that see a stop only as a failed call (Engine C).
 */
import {
  getSecurityModel,
  isSecurityModelId,
  isSecurityModelPriced,
  SECURITY_PROVIDER_NOTICE_VERSION,
  securityModelCostNanoUsd,
  type SecurityModelHost,
  type SecurityModelId,
} from '@void/platform/security-models';
import {
  SECURITY_ERRORS,
  type SecurityPlanCap,
  type SecurityPolicy,
} from '@void/platform/security-policy';
import { eq } from 'drizzle-orm';
import { createDb, type DbOrTx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { CF_API_BASE } from '../provisioning/cloudflare-api.ts';
import { deriveSecurityScanTag } from '../proxy-token.ts';
import { projects } from '../schema.ts';
import {
  holdSecurityModelCall,
  securitySpendCaps,
  settleSecurityModelCall,
  type SecurityCallHold,
  type SecurityCallRefusal,
  type SecurityCallSettlement,
  type SecuritySpendCaps,
} from './budget.ts';
import {
  SECURITY_MAX_SESSION_INDEX,
  type AdmitModelCall,
  type AdmitModelCallResult,
  type ModelCallFailure,
  type ModelCallFailureReason,
} from './call-ledger.ts';
import { judgeScanFence } from './control.ts';
import { pokeSecurityScanScheduler } from './enqueue.ts';
import { enqueueSecurityCapNotifications } from './notifications.ts';
import { readSecurityPlanCapCell, securityPlanCapSql } from './plan-caps.ts';
import { readSecurityPolicyLenient } from './policy.ts';
import { projectSecuritySettings, securityScans } from './schema.ts';

export const SECURITY_STOP_HEADER = 'x-void-scan-stop';
export const SECURITY_SESSION_HEADER = 'x-void-scan-session';
export const SECURITY_MODEL_FAILURE_PATH = '/v1/void/last-failure';

/** Proxy stops the runner maps to a scan status (`status.ts` in the runner). */
export type SecurityProxyStop = 'session_calls' | 'scan_calls' | 'tokens' | 'budget' | 'credits';

type ModelApi = 'chat' | 'messages' | 'responses';

/** One route per engine; each only reaches models of its host. */
const ROUTES: Readonly<Record<string, ModelApi>> = {
  '/v1/chat/completions': 'chat',
  '/v1/messages': 'messages',
  '/v1/responses': 'responses',
};

const ROUTE_HOST: Readonly<Record<ModelApi, SecurityModelHost>> = {
  chat: 'workers-ai',
  messages: 'anthropic',
  responses: 'openai',
};

/** A request body above this is refused; 2M input tokens fit with room to spare. */
export const SECURITY_MODEL_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
/** Output limit of one call when the caller sets none (Engine B sends none). */
export const SECURITY_DEFAULT_CALL_OUTPUT_TOKENS = 16_384;
/** Longest wait for a `@cf` rate token before the call fails as infrastructure. */
export const SECURITY_RATE_WAIT_LIMIT_MS = 120_000;
/**
 * `anthropic-beta` values kept on a Messages call; any other value is dropped. Each one
 * changes only how the model answers: none adds a tool the provider runs (web, code,
 * MCP, files, compaction) or a price the meter does not know (`context-1m-*`). Spike
 * S2 recorded header names only, so M13 checks the Agent SDK sends nothing else it needs.
 */
export const SECURITY_ALLOWED_ANTHROPIC_BETAS: ReadonlySet<string> = new Set([
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'fine-grained-tool-streaming-2025-05-14',
  'token-efficient-tools-2025-02-19',
  'context-management-2025-06-27',
  'structured-outputs-2025-11-13',
  'effort-2025-11-24',
]);
/** Body fields that make the provider run code, reach a server or answer later. */
const REFUSED_BODY_FIELDS = ['mcp_servers', 'container', 'background'] as const;
/** Smallest output limit a route accepts (OpenAI Responses refuses less than 16). */
const MIN_CALL_OUTPUT: Readonly<Record<ModelApi, number>> = { chat: 1, messages: 1, responses: 16 };
/** Smallest Anthropic `thinking.budget_tokens`. */
const MIN_THINKING_BUDGET = 1024;
const DEFAULT_GATEWAY_ID = 'void';
/** Longest SSE line kept while looking for usage; longer lines pass through unread. */
const MAX_SSE_LINE_CHARS = 1024 * 1024;

/** One scan as the proxy sees it, read fresh on every call. */
export type SecurityModelScan = Readonly<{
  scanId: string;
  projectId: string;
  status: string;
  attempt: number;
  leaseUntil: string | null;
  projectStatus: string;
  modelUsed: string | null;
  modelCalls: number;
  tokensIn: number;
  tokensOut: number;
  /** `project_security_settings`; `null` when the project has no row. */
  projectNoticeVersion: number | null;
  monthlyCapCents: number | null;
  capCeilingCents: number | null;
  /** The cap of the owner's plan (M27), read with the scan on every call. */
  planCap: SecurityPlanCap;
}>;

/** The parts of a call that leave the proxy; tests replace them. */
export type SecurityModelProxyDeps = Readonly<{
  now(): number;
  sleep(ms: number): Promise<void>;
  loadScan(scanId: string): Promise<SecurityModelScan | undefined>;
  readPolicy(): Promise<SecurityPolicy>;
  admit(input: AdmitModelCall): Promise<AdmitModelCallResult>;
  recordFailure(scanId: string, attempt: number, failure: ModelCallFailure): Promise<void>;
  lastFailure(scanId: string, attempt: number): Promise<ModelCallFailure | null>;
  /** Workers AI answered 429 for this `@cf` model: back the shared bucket off. */
  rateLimited(model: string, now: number): Promise<void>;
  hold(
    input: Parameters<typeof holdSecurityModelCall>[1],
  ): Promise<SecurityCallHold | SecurityCallRefusal>;
  settle(input: Parameters<typeof settleSecurityModelCall>[1]): Promise<SecurityCallSettlement>;
  /** After a settle: queue the 80% / 100% cap emails (best effort; absent in some tests). */
  notifyCaps?(
    input: Readonly<{
      projectId: string;
      month: string;
      caps: SecuritySpendCaps;
      settlement: SecurityCallSettlement;
    }>,
  ): Promise<void>;
  scanTag(scanId: string): Promise<string>;
  gatewayId: string;
  accountId: string;
  apiToken: string;
  ai: Ai | undefined;
  fetch: typeof fetch;
}>;

export function securityModelProxyDeps(env: ApiEnv['Bindings']): SecurityModelProxyDeps {
  const db = createDb(env.HYPERDRIVE.connectionString);
  const scheduler = () =>
    env.SECURITY_SCAN_SCHEDULER.get(env.SECURITY_SCAN_SCHEDULER.idFromName('global'));
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    loadScan: (scanId) => loadSecurityModelScan(db, scanId),
    readPolicy: () => readSecurityPolicyLenient(db),
    admit: (input) => scheduler().admitModelCall(input),
    recordFailure: (scanId, attempt, failure) =>
      scheduler().recordModelCallFailure(scanId, attempt, failure),
    lastFailure: (scanId, attempt) => scheduler().modelCallFailure(scanId, attempt),
    rateLimited: async (model, now) => {
      await scheduler().backOffModelRate(model, now);
    },
    hold: (input) => holdSecurityModelCall(db, input),
    settle: (input) => settleSecurityModelCall(db, input),
    notifyCaps: async ({ projectId, month, caps, settlement }) => {
      const queued = await enqueueSecurityCapNotifications(db, {
        projectId,
        month,
        caps,
        projectSpentNano: settlement.projectSpentNano,
        platformSpentNano: settlement.platformSpentNano,
      });
      if (queued) {
        await pokeSecurityScanScheduler(env);
      }
    },
    scanTag: (scanId) => deriveSecurityScanTag(env.JWT_SECRET, scanId),
    gatewayId: env.AI_GATEWAY_ID ?? DEFAULT_GATEWAY_ID,
    accountId: env.CF_ACCOUNT_ID,
    apiToken: env.CF_API_TOKEN,
    ai: env.AI,
    fetch: (input, init) => fetch(input, init),
  };
}

export async function loadSecurityModelScan(
  db: DbOrTx,
  scanId: string,
): Promise<SecurityModelScan | undefined> {
  const [row] = await db
    .select({
      scanId: securityScans.id,
      projectId: securityScans.project_id,
      status: securityScans.status,
      attempt: securityScans.attempt,
      leaseUntil: securityScans.lease_until,
      projectStatus: projects.status,
      modelUsed: securityScans.model_used,
      modelCalls: securityScans.model_calls,
      tokensIn: securityScans.tokens_in,
      tokensOut: securityScans.tokens_out,
      projectNoticeVersion: projectSecuritySettings.provider_notice_version,
      monthlyCapCents: projectSecuritySettings.monthly_cap_cents,
      capCeilingCents: projectSecuritySettings.cap_ceiling_cents,
      planCap: securityPlanCapSql(projects.user_id),
    })
    .from(securityScans)
    .innerJoin(projects, eq(projects.id, securityScans.project_id))
    .leftJoin(
      projectSecuritySettings,
      eq(projectSecuritySettings.project_id, securityScans.project_id),
    )
    .where(eq(securityScans.id, scanId))
    .limit(1);
  return row ? { ...row, planCap: readSecurityPlanCapCell(row.planCap) } : undefined;
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

function refuse(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status });
}

function stop(reason: SecurityProxyStop, message: string): Response {
  return Response.json(
    { error: 'scan stopped', reason, message },
    { status: reason === 'credits' ? 402 : 429, headers: { [SECURITY_STOP_HEADER]: reason } },
  );
}

const STOP_MESSAGES: Readonly<Record<SecurityProxyStop, string>> = {
  session_calls: 'This session used all its model calls.',
  scan_calls: 'This scan used all its model calls.',
  tokens: 'This scan used all its tokens.',
  budget: 'The next model call could cross a monthly scan budget.',
  credits: 'AI credits are used up.',
};

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export type SecurityModelVerdict =
  | Readonly<{ ok: true; model: SecurityModelId }>
  | Readonly<{ ok: false; status: number; error: string; message: string }>;

function notAllowed(message: string): SecurityModelVerdict {
  const { status, code } = SECURITY_ERRORS.modelNotAllowed;
  return { ok: false, status, error: code, message };
}

/** May this scan call this model through this route now? (spec §15.3 "Model allowlist") */
export function judgeSecurityModelCall(
  input: Readonly<{
    route: ModelApi;
    bodyModel: unknown;
    scan: Pick<SecurityModelScan, 'modelUsed' | 'projectNoticeVersion'>;
    policy: SecurityPolicy;
  }>,
): SecurityModelVerdict {
  const { policy, scan } = input;
  if (policy.mode === 'disabled') {
    return {
      ok: false,
      status: 409,
      error: 'security audits off',
      message: 'Security audits are off.',
    };
  }
  const model = scan.modelUsed;
  if (!isSecurityModelId(model)) {
    return notAllowed('This scan has no model on the list.');
  }
  if (input.bodyModel !== model && input.bodyModel !== gatewayModelName(model)) {
    return notAllowed(`This scan runs ${model}; the call asked for another model.`);
  }
  const host = getSecurityModel(model).host;
  if (ROUTE_HOST[input.route] !== host) {
    return notAllowed(`${model} is not reached through this route.`);
  }
  if (policy.blockedModels.includes(model)) {
    return notAllowed(`${model} is blocked by the platform admin.`);
  }
  if (!isSecurityModelPriced(model)) {
    return notAllowed(`${model} has no list price yet.`);
  }
  if (host !== 'workers-ai') {
    if (policy.entitlement?.hosts[host] !== true) {
      return notAllowed(`${host}/* models did not pass the platform's credits check.`);
    }
    if (scan.projectNoticeVersion !== SECURITY_PROVIDER_NOTICE_VERSION) {
      const { status, code } = SECURITY_ERRORS.providerNoticeNotAccepted;
      return {
        ok: false,
        status,
        error: code,
        message: `This project has not accepted the provider notice for ${model}.`,
      };
    }
  }
  return { ok: true, model };
}

function toolRefusal(route: ModelApi, tool: unknown, nested: boolean): string | null {
  const value = asObject(tool);
  if (!value) {
    return 'A tool must be an object.';
  }
  const type = value.type;
  if (route === 'messages') {
    // A plain Messages tool has no type, or `custom`; every typed tool is Anthropic's.
    return type === undefined || type === 'custom'
      ? null
      : `Tool type "${String(type)}" is not allowed.`;
  }
  if (type === 'function' || type === 'custom') {
    return null;
  }
  // Codex groups MCP tools in a namespace; each tool in it is checked.
  if (type === 'namespace' && !nested && Array.isArray(value.tools)) {
    for (const inner of value.tools) {
      const refusal = toolRefusal(route, inner, true);
      if (refusal) {
        return refusal;
      }
    }
    return null;
  }
  return `Tool type "${String(type)}" is not allowed.`;
}

function toolsRefusal(route: ModelApi, tools: unknown): string | null {
  if (tools === undefined || tools === null) {
    return null;
  }
  if (!Array.isArray(tools)) {
    return '`tools` must be a list.';
  }
  for (const tool of tools) {
    const refusal = toolRefusal(route, tool, false);
    if (refusal) {
      return refusal;
    }
  }
  return null;
}

/**
 * Why a Messages or Responses body asks for something the provider runs itself, or
 * `null`. Only function and custom tools pass: web search, web fetch, code execution,
 * MCP, file search and the rest run on the provider's side, out of reach of the
 * container egress lock (spec T2). The tool lockdown is set inside the container, so
 * this is the trusted check.
 */
export function judgeModelRequestBody(
  route: ModelApi,
  body: Readonly<Record<string, unknown>>,
): string | null {
  if (route === 'chat') {
    return null;
  }
  for (const field of REFUSED_BODY_FIELDS) {
    if (body[field] !== undefined && body[field] !== null) {
      return `\`${field}\` is not allowed in a scan.`;
    }
  }
  const refusal = toolsRefusal(route, body.tools);
  if (refusal || route !== 'responses' || !Array.isArray(body.input)) {
    return refusal;
  }
  // Codex "responses lite" can send tools in an `additional_tools` input item.
  for (const item of body.input) {
    const value = asObject(item);
    if (value?.type === 'additional_tools') {
      const inner = toolsRefusal(route, value.tools ?? []);
      if (inner) {
        return inner;
      }
    }
  }
  return null;
}

/** The caller's `anthropic-beta` values that are on the allowlist, or `null`. */
export function allowedAnthropicBetas(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const kept = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => SECURITY_ALLOWED_ANTHROPIC_BETAS.has(part));
  return kept.length > 0 ? [...new Set(kept)].join(',') : null;
}

/**
 * The name the gateway routes by on its Messages and Responses endpoints (spikes S2/S3):
 * `claude-sonnet-5.5` for `anthropic/claude-sonnet-5.5`. Engines A and C send it; the
 * proxy takes it as the scan's model and sends this form on. `@cf/*` ids stay whole.
 */
export function gatewayModelName(model: string): string {
  return model.startsWith('@cf/') ? model : model.slice(model.indexOf('/') + 1);
}

/** `x-void-scan-session`: a small decimal index, or absent. */
export function parseSecuritySession(value: string | null): number | null | 'invalid' {
  if (value === null) {
    return null;
  }
  if (value.length === 0 || value.length > 2) {
    return 'invalid';
  }
  for (const char of value) {
    if (char < '0' || char > '9') {
      return 'invalid';
    }
  }
  const session = Number(value);
  return session <= SECURITY_MAX_SESSION_INDEX ? session : 'invalid';
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Sets the call's output limit to at most what the scan has left and returns it. The
 * limit is the call's worst-case output for the budget hold. `null` when what is left
 * is below the smallest limit the provider accepts: the scan is out of tokens, since
 * the call would only fail upstream. An Anthropic thinking budget is lowered with the
 * limit, which must stay above it.
 */
export function clampCallOutput(
  route: ModelApi,
  body: Record<string, unknown>,
  remaining: number,
): number | null {
  const key = route === 'responses' ? 'max_output_tokens' : 'max_tokens';
  const asked = [positiveInteger(body[key])];
  if (route === 'chat') {
    // Workers AI reads `max_tokens`; one limit is kept.
    asked.push(positiveInteger(body.max_completion_tokens));
    delete body.max_completion_tokens;
  }
  const given = asked.filter((value): value is number => value !== null);
  const limit = Math.min(
    given.length > 0 ? Math.min(...given) : SECURITY_DEFAULT_CALL_OUTPUT_TOKENS,
    remaining,
  );
  if (limit < MIN_CALL_OUTPUT[route]) {
    return null;
  }
  const thinking = route === 'messages' ? asObject(body.thinking) : null;
  const budget = thinking?.type === 'enabled' ? positiveInteger(thinking.budget_tokens) : null;
  if (thinking && budget !== null && budget >= limit) {
    if (limit - 1 < MIN_THINKING_BUDGET) {
      return null;
    }
    body.thinking = { ...thinking, budget_tokens: limit - 1 };
  }
  body[key] = limit;
  return limit;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * `input` is every input token (the token caps count it). `cacheWrite5m` and
 * `cacheWrite1h` are the part of it written to the Anthropic prompt cache, which is
 * priced at 1.25× and 2× input. Cache reads stay at 1× input, above their real price.
 */
export type ModelUsage = {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
};

/** Input tokens at the plain input price that cost what `usage` input costs. */
export function billedInputTokens(usage: ModelUsage): number {
  return usage.input + Math.ceil(usage.cacheWrite5m / 4) + usage.cacheWrite1h;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Usage in one answer or SSE event, in any of the three shapes: chat completions and
 * Workers AI (`prompt_tokens`/`completion_tokens`), Anthropic Messages
 * (`input_tokens` + cache tokens, also under `message`), OpenAI Responses
 * (`input_tokens`/`output_tokens` under `response`). Anthropic cache tokens are added
 * to input, and cache writes are also kept apart for their price.
 */
export function readModelUsage(value: unknown): ModelUsage | null {
  const event = asObject(value);
  if (!event) {
    return null;
  }
  let found: ModelUsage | null = null;
  for (const holder of [event, asObject(event.message), asObject(event.response)]) {
    const usage = asObject(holder?.usage);
    if (!usage) {
      continue;
    }
    const input = count(usage.prompt_tokens) ?? count(usage.input_tokens);
    const output = count(usage.completion_tokens) ?? count(usage.output_tokens);
    if (input === null && output === null) {
      continue;
    }
    const detail = asObject(usage.cache_creation);
    const cacheWrite1h = count(detail?.ephemeral_1h_input_tokens) ?? 0;
    const cacheWrite5m = Math.max(
      count(detail?.ephemeral_5m_input_tokens) ?? 0,
      (count(usage.cache_creation_input_tokens) ?? 0) - cacheWrite1h,
    );
    const cacheRead = count(usage.cache_read_input_tokens) ?? 0;
    found = mergeUsage(found, {
      input: (input ?? 0) + cacheWrite5m + cacheWrite1h + cacheRead,
      output: output ?? 0,
      cacheWrite5m,
      cacheWrite1h,
    });
  }
  return found;
}

/** Streams repeat cumulative counts (Anthropic `message_start`, then `message_delta`). */
function mergeUsage(a: ModelUsage | null, b: ModelUsage | null): ModelUsage | null {
  if (!a || !b) {
    return a ?? b;
  }
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheWrite5m: Math.max(a.cacheWrite5m, b.cacheWrite5m),
    cacheWrite1h: Math.max(a.cacheWrite1h, b.cacheWrite1h),
  };
}

/** Reads `data:` lines of an SSE stream as they pass, keeping the highest usage seen. */
export class SseUsageReader {
  private buffer = '';
  private skipping = false;
  usage: ModelUsage | null = null;

  push(text: string): void {
    let start = 0;
    for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', start)) {
      const line = this.skipping ? '' : this.buffer + text.slice(start, index);
      this.buffer = '';
      this.skipping = false;
      this.line(line);
      start = index + 1;
    }
    if (this.skipping) {
      return;
    }
    this.buffer += text.slice(start);
    if (this.buffer.length > MAX_SSE_LINE_CHARS) {
      this.buffer = '';
      this.skipping = true;
    }
  }

  end(): void {
    if (!this.skipping && this.buffer.length > 0) {
      this.line(this.buffer);
    }
    this.buffer = '';
  }

  private line(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.startsWith('data:')) {
      return;
    }
    const data = line.slice(5).trim();
    if (data.length === 0 || data === '[DONE]') {
      return;
    }
    try {
      this.usage = mergeUsage(this.usage, readModelUsage(JSON.parse(data)));
    } catch {
      // Not JSON: nothing to count.
    }
  }
}

/**
 * Passes `source` through and calls `done` once: with the usage when the stream ends,
 * or with `null` when it fails or the reader cancels (the hold then stays charged).
 */
export function meteredStream(
  source: ReadableStream<Uint8Array>,
  done: (usage: ModelUsage | null) => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const sse = new SseUsageReader();
  let finished = false;
  const finish = async (usage: ModelUsage | null) => {
    if (finished) {
      return;
    }
    finished = true;
    await done(usage);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        await finish(null);
        controller.error(error);
        return;
      }
      if (chunk.done) {
        sse.push(decoder.decode());
        sse.end();
        await finish(sse.usage);
        controller.close();
        return;
      }
      sse.push(decoder.decode(chunk.value, { stream: true }));
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      await finish(null);
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

// ---------------------------------------------------------------------------
// Upstream
// ---------------------------------------------------------------------------

type CallPlan = Readonly<{
  scanId: string;
  model: SecurityModelId;
  route: ModelApi;
  body: Record<string, unknown>;
  stream: boolean;
  headers: Headers;
}>;

/** What the upstream answered, before metering. */
type Upstream =
  | Readonly<{ kind: 'json'; value: unknown }>
  | Readonly<{ kind: 'stream'; body: ReadableStream<Uint8Array> }>
  // 2xx the proxy cannot read: the provider billed it, so the worst case stays charged.
  | Readonly<{ kind: 'paid_unreadable'; detail: string }>
  | Readonly<{ kind: 'failed'; status: number; credits: boolean; detail: string }>;

function statusOf(error: unknown): number | null {
  for (let current = error, depth = 0; current && depth < 4; depth++) {
    const record = asObject(current);
    const status = record?.status ?? record?.statusCode;
    if (typeof status === 'number' && status >= 400 && status <= 599) {
      return status;
    }
    current = record?.cause;
  }
  return null;
}

/**
 * Workers AI internal codes the binding throws with no HTTP status, only as the
 * message prefix (`3040: Capacity temporarily exceeded, please try again.`), mapped to
 * the status the REST API gives them. Both 429s are the account-wide limit.
 */
const WORKERS_AI_CODE_STATUS: Readonly<Record<string, number>> = {
  '3036': 429, // Account limited (daily free allocation)
  '3040': 429, // Out of capacity
};

/**
 * Reads the leading `<code>:` of a Workers AI binding error, also after a class name
 * (`InferenceUpstreamError: 3040: …`, `AiError: 3040: …`). Returns its HTTP status.
 */
export function workersAiErrorStatus(error: unknown): number | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  let rest = message.trimStart();
  for (let part = 0; part < 2; part++) {
    const colon = rest.indexOf(':');
    if (colon <= 0) {
      return null;
    }
    const head = rest.slice(0, colon).trim();
    if (head.length > 0 && [...head].every((char) => char >= '0' && char <= '9')) {
      return WORKERS_AI_CODE_STATUS[head] ?? null;
    }
    // Not a code: skip one leading class name, then look once more.
    rest = rest.slice(colon + 1).trimStart();
  }
  return null;
}

/** The binding answer in chat-completions shape, which Engine B reads. */
export function asChatCompletion(model: string, value: unknown): unknown {
  const result = asObject(value);
  if (!result || Array.isArray(result.choices)) {
    return value;
  }
  const raw = Array.isArray(result.tool_calls) ? result.tool_calls : [];
  const toolCalls = raw.flatMap((entry: unknown, index: number) => {
    const call = asObject(entry);
    if (!call) {
      return [];
    }
    if (asObject(call.function)) {
      return [call];
    }
    if (typeof call.name !== 'string') {
      return [];
    }
    return [
      {
        id: typeof call.id === 'string' ? call.id : `call_${index}`,
        type: 'function',
        function: {
          name: call.name,
          arguments:
            typeof call.arguments === 'string'
              ? call.arguments
              : JSON.stringify(call.arguments ?? {}),
        },
      },
    ];
  });
  return {
    object: 'chat.completion',
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: typeof result.response === 'string' ? result.response : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  };
}

async function callWorkersAi(
  deps: SecurityModelProxyDeps,
  plan: CallPlan,
  tag: string,
): Promise<Upstream> {
  if (!deps.ai) {
    return { kind: 'failed', status: 503, credits: false, detail: 'no AI binding' };
  }
  const { model: _model, ...inputs } = plan.body;
  try {
    const result: unknown = await deps.ai.run(
      plan.model as keyof AiModels,
      inputs as never,
      {
        gateway: {
          id: deps.gatewayId,
          skipCache: true,
          collectLog: true,
          metadata: { securityScan: tag },
        },
        extraHeaders: { 'cf-aig-collect-log-payload': 'false', 'cf-aig-skip-cache': 'true' },
      } as never,
    );
    if (result instanceof ReadableStream) {
      return { kind: 'stream', body: result as ReadableStream<Uint8Array> };
    }
    return { kind: 'json', value: asChatCompletion(plan.model, result) };
  } catch (error) {
    const status = statusOf(error) ?? workersAiErrorStatus(error) ?? 502;
    const detail = error instanceof Error ? error.message : String(error);
    // Only a 402 is a credits stop: an error text is not read for it.
    return { kind: 'failed', status, credits: status === 402, detail };
  }
}

async function callGateway(
  deps: SecurityModelProxyDeps,
  plan: CallPlan,
  tag: string,
): Promise<Upstream> {
  // Built from nothing: the caller's credentials and `cf-aig-*` headers never pass.
  const headers = new Headers({
    authorization: `Bearer ${deps.apiToken}`,
    'content-type': 'application/json',
    accept: plan.stream ? 'text/event-stream' : 'application/json',
    'cf-aig-gateway-id': deps.gatewayId,
    'cf-aig-metadata': JSON.stringify({ securityScan: tag }),
    'cf-aig-collect-log': 'true',
    'cf-aig-collect-log-payload': 'false',
    'cf-aig-skip-cache': 'true',
  });
  if (plan.route === 'messages') {
    const version = plan.headers.get('anthropic-version');
    if (version !== null) {
      headers.set('anthropic-version', version);
    }
    const betas = allowedAnthropicBetas(plan.headers.get('anthropic-beta'));
    if (betas !== null) {
      headers.set('anthropic-beta', betas);
    }
  }
  const path = plan.route === 'messages' ? 'messages' : 'responses';
  let response: Response;
  try {
    response = await deps.fetch(`${CF_API_BASE}/${deps.accountId}/ai/v1/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(plan.body),
    });
  } catch (error) {
    return {
      kind: 'failed',
      status: 502,
      credits: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 2000);
    return { kind: 'failed', status: response.status, credits: response.status === 402, detail };
  }
  if (plan.stream && response.body) {
    return { kind: 'stream', body: response.body };
  }
  try {
    return { kind: 'json', value: await response.json() };
  } catch {
    return { kind: 'paid_unreadable', detail: 'answer is not JSON' };
  }
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

async function readLimited(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) {
    return new Uint8Array();
  }
  const reader = request.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

/** Handles one container request for scan `scanId`, attempt `attempt`. */
export async function handleSecurityModelRequest(
  deps: SecurityModelProxyDeps,
  scanId: string,
  attempt: number,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === SECURITY_MODEL_FAILURE_PATH) {
    return Response.json({ failure: await deps.lastFailure(scanId, attempt) });
  }
  const route = ROUTES[url.pathname];
  if (request.method !== 'POST' || route === undefined) {
    return refuse(404, 'not_found', 'Unknown model route.');
  }
  const session = parseSecuritySession(request.headers.get(SECURITY_SESSION_HEADER));
  if (session === 'invalid') {
    return refuse(400, 'invalid_request', `${SECURITY_SESSION_HEADER} must be 0–63.`);
  }
  const bytes = await readLimited(request, SECURITY_MODEL_MAX_REQUEST_BYTES);
  if (bytes === null) {
    return refuse(413, 'request_too_large', 'The model request is too large.');
  }
  const body = parseObject(bytes);
  if (!body) {
    return refuse(400, 'invalid_request', 'The model request must be a JSON object.');
  }

  const failed = async (reason: ModelCallFailureReason, response: Response) => {
    await deps
      .recordFailure(scanId, attempt, { reason, httpStatus: response.status, at: deps.now() })
      .catch((error: unknown) => console.error('[security-model-proxy] record failure', error));
    return response;
  };

  const scan = await deps.loadScan(scanId);
  const fence = judgeScanFence(scan, attempt, deps.now());
  if (!scan || !fence.ok) {
    return refuse(409, 'scan_not_running', 'This scan attempt is not running.');
  }
  const policy = await deps.readPolicy();
  const verdict = judgeSecurityModelCall({ route, bodyModel: body.model, scan, policy });
  if (!verdict.ok) {
    return failed('not_allowed', refuse(verdict.status, verdict.error, verdict.message));
  }
  const model = verdict.model;
  const bodyRefusal = judgeModelRequestBody(route, body);
  if (bodyRefusal) {
    return failed('not_allowed', refuse(422, 'tool_not_allowed', bodyRefusal));
  }
  const limits = policy.limits;
  if (scan.modelCalls >= limits.modelCallsPerScan) {
    return failed('scan_calls', stop('scan_calls', STOP_MESSAGES.scan_calls));
  }
  if (scan.tokensIn >= limits.maxInputTokens || scan.tokensOut >= limits.maxOutputTokens) {
    return failed('tokens', stop('tokens', STOP_MESSAGES.tokens));
  }

  if (route === 'responses') {
    // Always the proxy's own value (spec §15.4): Codex drops its flag without an OpenAI login.
    body.access_programs = { cyber: 'standard' };
  }
  if (route !== 'chat') {
    body.model = gatewayModelName(model);
  }
  const callOutput = clampCallOutput(route, body, limits.maxOutputTokens - scan.tokensOut);
  if (callOutput === null) {
    return failed('tokens', stop('tokens', STOP_MESSAGES.tokens));
  }
  const stream = body.stream === true;
  const forwarded = route === 'chat' ? { ...body, model: undefined } : body;
  // A token is at least one byte, so the body length bounds the input tokens.
  const worstInput = new TextEncoder().encode(JSON.stringify(forwarded)).byteLength;
  // An Anthropic input token written to the 1 h cache costs 2× input.
  const worstBilledInput = route === 'messages' ? worstInput * 2 : worstInput;
  const worstNano = securityModelCostNanoUsd(model, worstBilledInput, callOutput) ?? 0;

  // Session count and `@cf` rate token. Waiting here does not use a model call.
  const waitUntil = deps.now() + SECURITY_RATE_WAIT_LIMIT_MS;
  for (;;) {
    const admitted = await deps.admit({
      scanId,
      attempt,
      session,
      rateModel: route === 'chat' ? model : null,
      now: deps.now(),
    });
    if (admitted.ok) {
      break;
    }
    if (admitted.reason === 'session_calls') {
      return failed('session_calls', stop('session_calls', STOP_MESSAGES.session_calls));
    }
    const left = waitUntil - deps.now();
    if (left <= 0) {
      return failed('rate_wait', refuse(503, 'rate_limited', 'Waited too long for a model slot.'));
    }
    await deps.sleep(Math.min(admitted.waitMs, left));
  }

  const caps = securitySpendCaps(
    {
      monthlyCapCents: scan.monthlyCapCents,
      capCeilingCents: scan.capCeilingCents,
      planCap: scan.planCap,
    },
    policy.budgets,
  );
  const hold = await deps.hold({
    scanId,
    attempt,
    projectId: scan.projectId,
    worstNano,
    maxCalls: limits.modelCallsPerScan,
    maxInputTokens: limits.maxInputTokens,
    maxOutputTokens: limits.maxOutputTokens,
    caps,
    now: deps.now(),
  });
  if (!hold.ok) {
    if (hold.reason === 'fence') {
      return refuse(409, 'scan_not_running', 'This scan attempt is not running.');
    }
    return failed(hold.reason, stop(hold.reason, STOP_MESSAGES[hold.reason]));
  }

  // `paid`: the model answered. Without usage in that answer the worst case stays
  // charged, tokens included; a call that failed upstream costs nothing.
  const settle = async (usage: ModelUsage | null, paid: boolean) => {
    const tokens =
      usage ?? (paid ? { input: worstInput, output: callOutput } : { input: 0, output: 0 });
    const actualNano = usage
      ? (securityModelCostNanoUsd(model, billedInputTokens(usage), usage.output) ?? 0)
      : paid
        ? hold.holdNano
        : 0;
    try {
      const settlement = await deps.settle({
        scanId,
        projectId: scan.projectId,
        month: hold.month,
        holdNano: hold.holdNano,
        actualNano,
        inputTokens: tokens.input,
        outputTokens: tokens.output,
      });
      await deps
        .notifyCaps?.({ projectId: scan.projectId, month: hold.month, caps, settlement })
        .catch((error: unknown) =>
          console.error('[security-model-proxy] cap alert failed', { scanId, attempt, error }),
        );
    } catch (error) {
      // The hold stays charged: the meter errs high, never low.
      console.error('[security-model-proxy] settle failed', { scanId, attempt, error });
    }
  };

  const tag = await deps.scanTag(scanId);
  const plan: CallPlan = { scanId, model, route, body, stream, headers: request.headers };
  const upstream =
    route === 'chat' ? await callWorkersAi(deps, plan, tag) : await callGateway(deps, plan, tag);

  if (upstream.kind === 'failed') {
    await settle(null, false);
    if (route === 'chat' && upstream.status === 429) {
      // Tenant apps share the account's Workers AI limit: slow every scan on this model.
      await deps
        .rateLimited(model, deps.now())
        .catch((error: unknown) => console.error('[security-model-proxy] rate back-off', error));
    }
    if (upstream.credits) {
      return failed('credits', stop('credits', STOP_MESSAGES.credits));
    }
    console.error('[security-model-proxy] upstream failed', {
      scanId,
      attempt,
      model,
      status: upstream.status,
      detail: upstream.detail.slice(0, 500),
    });
    const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
    // A 402 the runner would read as credits is not passed through without the header, and
    // a 401 never reaches an engine: Claude Code retries it for minutes (spike S2).
    return failed(
      'upstream',
      refuse(
        status === 402 || status === 401 ? 502 : status,
        'upstream_failed',
        'The model call failed.',
      ),
    );
  }
  if (upstream.kind === 'paid_unreadable') {
    await settle(null, true);
    console.error('[security-model-proxy] unreadable answer', { scanId, attempt, model });
    return failed(
      'upstream',
      refuse(502, 'upstream_failed', 'The model answer could not be read.'),
    );
  }
  if (upstream.kind === 'stream') {
    return new Response(
      meteredStream(upstream.body, (usage) => settle(usage, true)),
      { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } },
    );
  }
  await settle(readModelUsage(upstream.value), true);
  return Response.json(upstream.value);
}
