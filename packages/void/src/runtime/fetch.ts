import { createFetch } from 'ofetch';
import { FetchError } from './fetch-error.ts';
import { interpolateRouteParams } from './route-url.ts';
export { FetchError };

import type { RouteMap } from 'void/routes';
export type MethodsOf<P extends keyof RouteMap> = keyof RouteMap[P] & string;
type DefaultMethod<P extends keyof RouteMap> = 'GET' extends MethodsOf<P> ? 'GET' : never;

type RouteEntry<P extends keyof RouteMap, M extends MethodsOf<P>> = RouteMap[P][M] extends {
  input: infer I;
  output: infer O;
}
  ? { input: I; output: O }
  : { input: {}; output: unknown };

type OutputOf<P extends keyof RouteMap, M extends MethodsOf<P>> = RouteEntry<P, M>['output'];
type InputOf<P extends keyof RouteMap, M extends MethodsOf<P>> = RouteEntry<P, M>['input'];

export type BodyOption<I> = 'body' extends keyof I
  ? { body: I['body' & keyof I] }
  : { body?: Record<string, unknown> | BodyInit | null };
export type QueryOption<I> = 'query' extends keyof I
  ? { query: I['query' & keyof I] }
  : { query?: Record<string, string> };
export type ParamsOption<I> = 'params' extends keyof I
  ? { params: I['params' & keyof I] }
  : { params?: Record<string, string> };

type HasRequiredInput<
  P extends keyof RouteMap,
  M extends MethodsOf<P>,
> = 'body' extends keyof InputOf<P, M>
  ? true
  : 'query' extends keyof InputOf<P, M>
    ? true
    : 'params' extends keyof InputOf<P, M>
      ? true
      : false;

type FetchOptions<P extends keyof RouteMap, M extends MethodsOf<P>> = BodyOption<InputOf<P, M>> &
  QueryOption<InputOf<P, M>> &
  ParamsOption<InputOf<P, M>> & {
    method?: M;
    headers?: HeadersInit;
    signal?: AbortSignal;
    baseURL?: string;
    retry?: number;
    timeout?: number;
  };

export type UntypedFetchOptions = {
  method?: string;
  params?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string>;
  headers?: HeadersInit;
  signal?: AbortSignal;
  baseURL?: string;
  retry?: number;
  timeout?: number;
};

const browserFetch = createRouteFetch((...args) => globalThis.fetch(...args));

/**
 * Typed fetch client for Void API routes.
 *
 * Built on ofetch. Supports `method`, `params`, `query`, `body`, `headers`,
 * `signal`, `baseURL`, `retry` and `timeout`, with full route type safety.
 *
 * ```ts
 * import { fetch } from "void/client";
 *
 * const users = await fetch("/api/users"); // typed!
 * const user = await fetch("/api/users/:id", { params: { id: "1" } });
 * ```
 */
export function fetch<P extends keyof RouteMap & string>(
  path: HasRequiredInput<P, DefaultMethod<P>> extends false ? P : never,
): Promise<OutputOf<P, DefaultMethod<P>>>;
export function fetch<P extends keyof RouteMap & string, M extends MethodsOf<P> = DefaultMethod<P>>(
  path: P,
  options: FetchOptions<P, M>,
): Promise<OutputOf<P, M>>;
export async function fetch(path: string, options?: UntypedFetchOptions): Promise<unknown> {
  return browserFetch(path, options);
}

/** Apply the same route interpolation and request options to browser and server transports. */
export function createRouteFetch(
  transport: typeof globalThis.fetch,
): (path: string, options?: UntypedFetchOptions) => Promise<unknown> {
  const client = createFetch({ fetch: transport });
  return async (path, options) => {
    const url = interpolateRouteParams(path, options?.params);

    return client(url, {
      method: options?.method ?? 'GET',
      body: options?.body as Record<string, unknown> | BodyInit | null | undefined,
      query: options?.query,
      headers: options?.headers,
      signal: options?.signal,
      baseURL: options?.baseURL,
      retry: options?.retry,
      timeout: options?.timeout,
    });
  };
}
