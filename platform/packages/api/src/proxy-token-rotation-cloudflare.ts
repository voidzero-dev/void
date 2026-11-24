import { CF_API_BASE, CloudflareApiError } from './provisioning/cloudflare-api.ts';
import type { RotationBudget } from './proxy-token-rotation.ts';

/**
 * Cloudflare calls a proxy token rotation makes against tenant Workers: read a
 * script's bindings, and replace its `__VOID_PROXY_TOKEN` through a settings
 * PATCH that inherits every other binding (no code upload).
 *
 * Every call is counted against the run's budget and never retried or slept
 * on here; the rotation decides what to do with a rate limit or an error.
 */

const PROXY_TOKEN_BINDING = '__VOID_PROXY_TOKEN';
const REQUEST_TIMEOUT_MS = 60_000;
/**
 * A call needs at least this much of the run's time left. Starting one closer
 * to the deadline would cut a settings PATCH off with its outcome unknown.
 */
const MIN_REQUEST_MS = 5000;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
/** Cloudflare's "script not found" error code. */
const SCRIPT_NOT_FOUND_CODE = 10_007;

export class CloudflareRateLimitError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(`Cloudflare API rate limited; retry after ${retryAfterSeconds} seconds`);
    this.name = 'CloudflareRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Thrown before a call when the run has no Cloudflare calls or time left. */
export class RotationBudgetExhaustedError extends Error {
  constructor() {
    super('proxy token rotation budget exhausted');
    this.name = 'RotationBudgetExhaustedError';
  }
}

export type ScriptBinding = Readonly<{ name: string; type: string; text?: string }>;

/**
 * Settings PATCH bindings that keep every binding as it is (`inherit`, in the
 * original order) and set the proxy token. A binding left out of the list
 * would be removed, so every name is listed.
 */
export function buildProxyTokenBindingsPatch(
  existing: ReadonlyArray<ScriptBinding>,
  token: string,
): ReadonlyArray<Record<string, string>> {
  if (!existing.some((binding) => binding.name === PROXY_TOKEN_BINDING)) {
    throw new Error(`script has no ${PROXY_TOKEN_BINDING} binding`);
  }
  return existing.map((binding): Record<string, string> =>
    binding.name === PROXY_TOKEN_BINDING
      ? { type: 'plain_text', name: PROXY_TOKEN_BINDING, text: token }
      : { type: 'inherit', name: binding.name },
  );
}

export type RotationCloudflareClient = Readonly<{
  /** The script's bindings, or null when the script does not exist. */
  getScriptBindings(scriptName: string): Promise<ReadonlyArray<ScriptBinding> | null>;
  /** The bindings in the PATCH result, or null when the result has none. */
  patchScriptBindings(
    scriptName: string,
    bindings: ReadonlyArray<Record<string, string>>,
  ): Promise<ReadonlyArray<ScriptBinding> | null>;
}>;

type CfEnvelope<T> = Readonly<{
  success: boolean;
  errors?: ReadonlyArray<{ code: number; message: string }>;
  result: T;
}>;

function parseRetryAfter(value: string | null): number {
  const seconds = Number(value?.trim() || Number.NaN);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.ceil(seconds)
    : DEFAULT_RETRY_AFTER_SECONDS;
}

export function createRotationCloudflareClient(
  input: Readonly<{
    accountId: string;
    apiToken: string;
    dispatchNamespace: string;
    budget: RotationBudget;
    fetch?: typeof fetch;
  }>,
): RotationCloudflareClient {
  const send = input.fetch ?? ((url, init) => fetch(url, init));
  const scriptsUrl = `${CF_API_BASE}/${input.accountId}/workers/dispatch/namespaces/${input.dispatchNamespace}/scripts`;

  async function request<T>(method: string, path: string, body?: BodyInit): Promise<T> {
    const { budget } = input;
    const remainingMs = budget.deadline - Date.now();
    if (budget.cfCallsRemaining <= 0 || remainingMs < MIN_REQUEST_MS) {
      throw new RotationBudgetExhaustedError();
    }
    budget.cfCallsRemaining -= 1;
    const headers: Record<string, string> = { Authorization: `Bearer ${input.apiToken}` };
    if (body !== undefined && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await send(`${scriptsUrl}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remainingMs)),
    });
    if (response.status === 429) {
      throw new CloudflareRateLimitError(parseRetryAfter(response.headers.get('Retry-After')));
    }
    let json: CfEnvelope<T>;
    try {
      json = (await response.json()) as CfEnvelope<T>;
    } catch {
      throw new CloudflareApiError(
        `Cloudflare API error: HTTP ${response.status} ${method} ${path}`,
        response.status,
      );
    }
    if (!json.success) {
      const errors = json.errors ?? [];
      throw new CloudflareApiError(
        `Cloudflare API error: ${errors.map((error) => error.message).join(', ')}`,
        response.status,
        errors.map((error) => error.code),
      );
    }
    return json.result;
  }

  return {
    async getScriptBindings(scriptName) {
      try {
        return await request<ReadonlyArray<ScriptBinding>>(
          'GET',
          `/${encodeURIComponent(scriptName)}/bindings`,
        );
      } catch (error) {
        if (
          error instanceof CloudflareApiError &&
          (error.status === 404 || error.codes.includes(SCRIPT_NOT_FOUND_CODE))
        ) {
          return null;
        }
        throw error;
      }
    },
    async patchScriptBindings(scriptName, bindings) {
      const form = new FormData();
      form.append(
        'settings',
        new Blob([JSON.stringify({ bindings })], { type: 'application/json' }),
      );
      const result = await request<{ bindings?: ReadonlyArray<ScriptBinding> } | null>(
        'PATCH',
        `/${encodeURIComponent(scriptName)}/settings`,
        form,
      );
      return Array.isArray(result?.bindings) ? result.bindings : null;
    },
  };
}
