import { createRouteFetch, type UntypedFetchOptions } from './fetch.ts';
export { FetchError } from './fetch-error.ts';

/** Keep local calls in the app while using the browser client's request and error handling. */
export function createServerFetch<Context extends { request?: Request }>(
  dispatch: (request: Request, context: Context | undefined) => Response | Promise<Response>,
  getContext: () => Context | undefined,
  fallbackOrigin: string,
): (path: string, options?: UntypedFetchOptions) => Promise<unknown> {
  return createRouteFetch(async (input, init) => {
    const store = getContext();
    const origin = store?.request ? new URL(store.request.url).origin : fallbackOrigin;
    const request = new Request(new URL(String(input), origin), init);

    // External base URLs use real HTTP and must not inherit the visitor's credentials.
    if (new URL(request.url).origin !== origin) {
      return globalThis.fetch(request);
    }

    for (const name of ['cookie', 'authorization']) {
      if (!request.headers.has(name)) {
        const value = store?.request?.headers.get(name);
        if (value) {
          request.headers.set(name, value);
        }
      }
    }

    // app.fetch() does not observe cancellation itself. Race dispatch against the
    // signal supplied by ofetch (including its timeout), and forward it to handlers.
    const signal = request.signal;
    signal.throwIfAborted();
    let abort: () => void;
    try {
      return await new Promise<Response>((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(dispatch(request, store)).then(resolve, reject);
      });
    } finally {
      signal.removeEventListener('abort', abort!);
    }
  });
}
