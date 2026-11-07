import type { RequestUrl } from './route-url.ts';

export type SseClientEvent<T = unknown> = {
  data: T;
  event: string;
  id: string;
  raw: MessageEvent;
};

export type SseEventMap = Record<string, unknown>;

export type SseClient<Events extends SseEventMap = SseEventMap> = {
  on<Name extends Extract<keyof Events, string>>(
    event: Name,
    handler: (event: SseClientEvent<Events[Name]>) => void,
  ): () => void;
  on<T = unknown>(event: string, handler: (event: SseClientEvent<T>) => void): () => void;
  onError(handler: (event: Event) => void): () => void;
  close(): void;
};

export type ConnectEventStreamOptions = {
  withCredentials?: boolean;
  /**
   * @deprecated Has no effect. Register each event with `client.on(name, handler)`.
   * Removed in the next major version.
   */
  events?: Array<string>;
  parse?: 'json' | 'text' | ((data: string) => unknown);
};

type EventSourceLike = {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
};

type EventSourceConstructor = new (
  url: string,
  options?: { withCredentials?: boolean },
) => EventSourceLike;

/**
 * Open an `EventSource` to a route that returns `eventStream()`.
 *
 * With `routing.typedRoutes`, a string `url` must match one of the app's routes
 * or be an absolute `http://`/`https://` URL. Cast a path built at runtime with
 * `as RouteUrl`.
 */
export function connectEventStream<Events extends SseEventMap = SseEventMap>(
  url: RequestUrl | URL,
  options: ConnectEventStreamOptions = {},
): SseClient<Events> {
  const EventSourceCtor = (globalThis as { EventSource?: EventSourceConstructor }).EventSource;
  if (!EventSourceCtor) {
    throw new Error('sse: EventSource is not available in this runtime.');
  }

  const source = new EventSourceCtor(String(url), {
    withCredentials: options.withCredentials,
  });
  const parse = getParser(options.parse);

  const client: SseClient<Events> = {
    on<T = unknown>(event: string, handler: (event: SseClientEvent<T>) => void): () => void {
      const listener = (raw: Event): void => {
        const message = raw as MessageEvent;
        handler({
          data: parse(String(message.data)) as T,
          event,
          id: message.lastEventId,
          raw: message,
        });
      };
      source.addEventListener(event, listener);
      return () => source.removeEventListener(event, listener);
    },
    onError(handler) {
      source.addEventListener('error', handler);
      return () => source.removeEventListener('error', handler);
    },
    close() {
      source.close();
    },
  };
  return client;
}

function getParser(parse: ConnectEventStreamOptions['parse']): (data: string) => unknown {
  if (typeof parse === 'function') {
    return parse;
  }
  if (parse === 'text') {
    return (data) => data;
  }
  return (data) => JSON.parse(data);
}
