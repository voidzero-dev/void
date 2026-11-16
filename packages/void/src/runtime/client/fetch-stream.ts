import { ofetch } from 'ofetch';
import { FetchError } from './fetch-error.ts';
import { asUsageLimit, limitFromResponse } from './limits.ts';
import { interpolateRouteParams } from './route-url.ts';
export { FetchError as StreamError };

import type { RouteMap } from 'void/routes';
import type { BodyOption, MethodsOf, ParamsOption, QueryOption } from './fetch.ts';
type InputOf<P extends keyof RouteMap, M extends MethodsOf<P>> = RouteMap[P][M] extends {
  input: infer I;
}
  ? I
  : {};

type StreamOptions<P extends keyof RouteMap, M extends MethodsOf<P>> = BodyOption<InputOf<P, M>> &
  QueryOption<InputOf<P, M>> &
  ParamsOption<InputOf<P, M>> & {
    method?: M;
    headers?: HeadersInit;
    signal?: AbortSignal;
    baseURL?: string;
  };

/**
 * Consume an SSE endpoint as an async generator of text chunks.
 *
 * Parses Workers AI SSE format (`data: {"response":"chunk"}` + `data: [DONE]`)
 * and plain text SSE (`data: some text`).
 *
 * ```ts
 * import { fetchStream } from "void/client";
 *
 * for await (const chunk of fetchStream("/api/ai/chat", {
 *   method: "POST",
 *   body: { messages: [{ role: "user", content: "Hello" }] },
 * })) {
 *   output += chunk;
 * }
 * ```
 *
 * @yields {string} Text chunks from SSE data frames.
 */
export async function* fetchStream<
  P extends keyof RouteMap & string,
  M extends MethodsOf<P> = 'POST' extends MethodsOf<P> ? 'POST' : MethodsOf<P>,
>(path: P, options?: StreamOptions<P, M>): AsyncGenerator<string, void, undefined> {
  const url = interpolateRouteParams(path, options?.params as Record<string, string> | undefined);

  const response = await ofetch
    .raw(url, {
      method: (options?.method ?? 'POST') as string,
      body: options?.body as never,
      query: options?.query as never,
      headers: options?.headers,
      signal: options?.signal,
      baseURL: options?.baseURL,
      responseType: 'stream',
    })
    .catch(async (error: unknown) => {
      const response =
        error && typeof error === 'object' && 'response' in error ? error.response : null;
      if (response instanceof Response) {
        throw (await limitFromResponse(response, 'ai')) ?? error;
      }
      throw error;
    });

  const body = response._data as ReadableStream<Uint8Array> | null;
  if (!body) {
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  const terminal = (data: string) => {
    if (event !== 'void:error' && event !== 'void:limit') {
      return;
    }
    let message = 'Generation was interrupted.';
    let limit = null;
    try {
      const body = JSON.parse(data);
      if (event === 'void:limit') {
        limit = asUsageLimit(body);
      }
      if (typeof body.message === 'string') {
        message = body.message;
      }
    } catch {
      /* Use the default interruption message for malformed events. */
    }
    throw limit ?? new FetchError(message);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop()!; // Keep incomplete last line

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('event:')) {
          event = trimmed.slice(6).trim();
          continue;
        }
        if (!trimmed) {
          event = '';
          continue;
        }
        if (trimmed.startsWith(':')) {
          continue;
        }

        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          terminal(data);
          if (data === '[DONE]') {
            return;
          }
          const chunk = chunkText(data);
          if (chunk !== undefined) {
            yield chunk;
          }
        }
      }
    }

    // The stream may end without a trailing newline.
    const trimmed = buffer.trim();
    if (trimmed.startsWith('data: ')) {
      const data = trimmed.slice(6);
      terminal(data);
      const chunk = data === '[DONE]' ? undefined : chunkText(data);
      if (chunk !== undefined) {
        yield chunk;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Workers AI frames carry text in `response`; other JSON with that key (e.g. usage metadata) is skipped. */
function chunkText(data: string): string | undefined {
  try {
    const parsed = JSON.parse(data);
    if (typeof parsed.response === 'string') {
      return parsed.response;
    }
    if ('response' in parsed) {
      return undefined;
    }
  } catch {
    // Not JSON: plain text frame.
  }
  return data;
}
