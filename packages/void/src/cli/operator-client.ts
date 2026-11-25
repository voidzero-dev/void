import { cfAccessHeaders } from '../shared/cf-access.ts';
import { ensurePlatformAccessToken } from './cf-access.ts';
import { normalizePlatformApiUrl } from './platform-registry.ts';

export const OPERATOR_READ_TIMEOUT_MS: number = 30_000;
export const OPERATOR_MUTATION_TIMEOUT_MS: number = 5 * 60_000;
export const OPERATOR_MAX_TIMEOUT_MS: number = 60 * 60_000;

type OperatorErrorPayload = {
  error: string;
  message: string;
  status?: number;
  details?: unknown;
};

export class OperatorClientError extends Error {
  constructor(
    message: string,
    public readonly code = 'operator_error',
    public readonly status?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'OperatorClientError';
  }
  toJSON(): OperatorErrorPayload {
    return {
      error: this.code,
      message: this.message,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export class OperatorClient {
  readonly origin: string;
  constructor(
    origin: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.origin = normalizePlatformApiUrl(origin);
  }
  async request(
    path: string,
    options: {
      method?: 'GET' | 'POST';
      query?: Record<string, string>;
      body?: Record<string, unknown>;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<Record<string, unknown>> {
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      path.includes('?') ||
      path.includes('#')
    ) {
      throw new OperatorClientError('Invalid operator API path.');
    }
    const timeoutMs =
      options.timeoutMs ??
      (options.method === 'POST' ? OPERATOR_MUTATION_TIMEOUT_MS : OPERATOR_READ_TIMEOUT_MS);
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1000 ||
      timeoutMs > OPERATOR_MAX_TIMEOUT_MS
    ) {
      throw new OperatorClientError(
        `Operator request timeout must be an integer from 1 to ${OPERATOR_MAX_TIMEOUT_MS / 1000} seconds.`,
        'invalid_timeout',
      );
    }
    const url = new URL(`${this.origin}/operator/v1${path}`);
    ensurePlatformAccessToken(this.origin);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(name, value);
    }
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    timer.unref();
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal;
    try {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: options.method ?? 'GET',
          headers: {
            ...cfAccessHeaders(process.env, this.origin),
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/json',
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
          redirect: 'manual',
          signal,
        });
      } catch (error) {
        if (options.signal?.aborted) {
          throw error;
        }
        if (timeoutController.signal.aborted) {
          throw new OperatorClientError(
            `Operator request exceeded the ${timeoutMs / 1000}-second timeout. ${options.method === 'POST' ? 'Its outcome may be unknown; inspect platform state before retrying.' : 'Check connectivity and try again.'}`,
            'request_timeout',
          );
        }
        throw new OperatorClientError(
          `Operator request to ${this.origin} failed. ${options.method === 'POST' ? 'Its outcome may be unknown; inspect platform state before retrying.' : 'Check connectivity and try again.'}`,
          'connection_failed',
        );
      }
      if (response.status >= 300 && response.status < 400) {
        throw new OperatorClientError(
          'The operator API redirected the request. Credentials were not forwarded; use the exact platform API origin.',
          'redirect_rejected',
          response.status,
        );
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new OperatorClientError(
          `Operator API returned invalid JSON (HTTP ${response.status}).${options.method === 'POST' ? ' Inspect platform state before retrying.' : ''}`,
          'invalid_response',
          response.status,
        );
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new OperatorClientError(
          'Operator API returned an invalid response object.',
          'invalid_response',
          response.status,
        );
      }
      const result = data as Record<string, unknown>;
      if (!response.ok) {
        throw new OperatorClientError(
          typeof result.message === 'string'
            ? result.message
            : typeof result.error === 'string'
              ? result.error === 'Platform disabled' && result.reason === 'maintenance'
                ? `Operator request failed (HTTP ${response.status}): the platform is paused for an upgrade or repair. Retry when it finishes.`
                : `Operator request failed (HTTP ${response.status}): ${result.error}.${result.error === 'Platform disabled' ? ' Run `void platform enable`.' : ''}`
              : `Operator request failed (HTTP ${response.status}).`,
          typeof result.error === 'string' ? result.error : 'request_failed',
          response.status,
          result.details,
        );
      }
      if (result.partial === true || result.ok === false) {
        throw new OperatorClientError(
          'The operation did not fully complete. Inspect the partial result before retrying.',
          'partial_failure',
          response.status,
          result,
        );
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}
