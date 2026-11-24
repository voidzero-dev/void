import type { ApiRoutes } from '@voidcloud/api/api';
import type { Context } from 'hono';
import { hc } from 'hono/client';
import type { InferResponseType } from 'hono/client';
import { getCookie } from 'hono/cookie';
import { dashboardRequestOrigin, isLocalDashboardHost } from './origin.ts';

type Client = ReturnType<typeof hc<ApiRoutes>>;
export type ApiResponse = Pick<
  Response,
  'headers' | 'json' | 'ok' | 'status' | 'statusText' | 'text'
>;

/** Extract the 200 JSON response type from an hc client route key. */
export type API<K extends keyof Client> = InferResponseType<
  Client[K] extends { $get: infer G } ? G : Client[K],
  200
>;

const API_URL = 'https://api.void.cloud';
const DEFAULT_API_TIMEOUT_MS = 10_000;

export function getPublicApiUrl(context: Context): string {
  return (context.env as Record<string, string | undefined>).API_URL ?? API_URL;
}

/**
 * Use service binding in deployed dashboard workers. In local dev, always use
 * HTTP so production-backed dashboard testing cannot accidentally route to a
 * local or unresolved service binding.
 */
function getApiFetch(context: Context): typeof fetch {
  const binding = (context.env as { API?: Fetcher }).API;
  if (binding && !isLocalDashboardHost(context.req.header('host') ?? '')) {
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      // The service binding is internal. Preserve the browser's actual protected origin so
      // the API verifies the dashboard application's audience, not the API application's.
      // No forwarded-host header participates in this choice.
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (context.req.header('Cf-Access-Jwt-Assertion')) {
        const source = new URL(dashboardRequestOrigin(context));
        url.host = source.host;
        url.protocol = source.protocol;
      }
      return binding.fetch(input instanceof Request ? new Request(url, input) : url, init);
    }) as typeof fetch;
  }
  return globalThis.fetch;
}

function getApiTimeoutMs(context: Context): number {
  const raw = (context.env as Record<string, string | undefined>).API_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_API_TIMEOUT_MS;
  }

  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_API_TIMEOUT_MS;
}

function withTimeout(init: RequestInit | undefined, timeoutMs: number): RequestInit | undefined {
  if (init?.signal || typeof AbortSignal.timeout !== 'function') {
    return init;
  }
  return { ...init, signal: AbortSignal.timeout(timeoutMs) };
}

function getTimedApiFetch(context: Context): typeof fetch {
  const apiFetch = getApiFetch(context);
  const timeoutMs = getApiTimeoutMs(context);
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    apiFetch(input, withTimeout({ ...init, redirect: 'manual' }, timeoutMs))) as typeof fetch;
}

function getCfAccessHeaders(context: Context): Record<string, string> {
  const env = context.env as Record<string, string | undefined>;
  // The API independently checks the application audience and bound company subject.
  // Prefer this browser's proof; a dashboard service token cannot represent a human.
  const assertion = context.req.header('Cf-Access-Jwt-Assertion');
  const browserToken = getCookie(context, 'CF_Authorization');
  if (assertion || browserToken) {
    return {
      ...(assertion ? { 'Cf-Access-Jwt-Assertion': assertion } : {}),
      ...(browserToken ? { 'cf-access-token': browserToken } : {}),
    };
  }
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    return {
      'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
    };
  }
  if (env.CF_ACCESS_TOKEN) {
    return { 'cf-access-token': env.CF_ACCESS_TOKEN };
  }
  return {};
}

function getHeaders(context: Context, headers?: HeadersInit): Headers {
  const out = new Headers(headers);
  if (!out.has('Accept')) {
    out.set('Accept', 'application/json');
  }
  for (const [key, value] of Object.entries(getCfAccessHeaders(context))) {
    out.set(key, value);
  }

  const token = context.get('token') as string | undefined;
  if (token) {
    out.set('Authorization', `Bearer ${token}`);
  }
  return out;
}

export async function fetchApi(
  context: Context,
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const headers = getHeaders(context, options?.headers);
  if (options?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return getTimedApiFetch(context)(`${getPublicApiUrl(context)}${path}`, {
    ...options,
    headers,
  });
}

function apiErrorFallback(status: number): string {
  switch (status) {
    case 401:
      return 'Sign in again and retry this action.';
    case 403:
      return 'You do not have permission to perform this action. Check that you are signed in to the correct account.';
    case 404:
      return 'This item is unavailable. Refresh the page and try again.';
    case 409:
      return 'This action could not be completed because something changed. Refresh the page and try again.';
    case 429:
      return 'Too many requests. Wait a moment and try again.';
    default:
      return status >= 500
        ? 'The service is temporarily unavailable. Try again shortly.'
        : 'Unable to complete this request. Check your details and try again.';
  }
}

function readableApiError(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return;
  }
  const message = value.trim();
  // Show the API's public explanation, never serialized bodies, markup or stack traces.
  if (!message || message.length > 500 || /^[{["]/.test(message) || /[<>\r\n]/.test(message)) {
    return;
  }
  const generic = message
    .toLowerCase()
    .replace(/^\d{3}\s+/, '')
    .replace(/[.!]$/, '');
  if (
    /^(?:error|unknown error|request failed|bad request|unauthorized|unauthenticated|forbidden|access denied|not found|conflict|too many requests|internal server error|service unavailable|bad gateway|gateway timeout)$/.test(
      generic,
    ) ||
    /^[a-z][a-z0-9]*[_-][a-z0-9_-]+$/i.test(message)
  ) {
    return;
  }
  return message;
}

export async function getApiErrorMessage(res: ApiResponse): Promise<string> {
  const fallback = apiErrorFallback(res.status);
  let body: string;
  try {
    body = await res.text();
  } catch {
    return fallback;
  }

  try {
    const json: unknown = JSON.parse(body);
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      const { message, error } = json as { message?: unknown; error?: unknown };
      return readableApiError(message) ?? readableApiError(error) ?? fallback;
    }
  } catch {
    const contentType = res.headers.get('content-type') ?? '';
    if (!/json|html/i.test(contentType)) {
      return readableApiError(body) ?? fallback;
    }
  }
  return fallback;
}

export async function readApiJson<T>(res: ApiResponse): Promise<T | null> {
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    const body = await res.text();
    const preview = body.trim().replaceAll(/\s+/g, ' ').slice(0, 160);
    console.warn(
      `[dashboard] expected JSON from API, got ${contentType || 'unknown content type'}${preview ? `: ${preview}` : ''}`,
    );
    return null;
  }

  try {
    return (await res.json()) as T;
  } catch (error) {
    console.warn(
      `[dashboard] failed to parse API JSON response: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export async function getCurrentUser(context: Context): Promise<API<'me'> | null> {
  let res: Response;
  try {
    res = await fetchApi(context, '/me');
  } catch (error) {
    console.warn(
      `[dashboard] /me request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }

  if (!res.ok) {
    console.warn(`[dashboard] /me returned ${res.status}: ${await getApiErrorMessage(res)}`);
    return null;
  }
  return readApiJson<API<'me'>>(res);
}
