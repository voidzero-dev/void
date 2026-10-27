import type { WebSocketRouteMap } from 'void/routes';
import { isResourceName } from '../shared/resource-name.ts';
import type { StandardSchemaV1 } from '../standard-schema.ts';
import type { AuthUser } from './auth.ts';
import type { CloudEnv } from './handler.ts';
import { interpolateRouteParams } from './route-url.ts';

type MaybePromise<T> = T | Promise<T>;
type ParamsRecord = Record<string, string>;

export type WebSocketInstanceKey = (context: { params: ParamsRecord }) => string;

type WsEntry<P extends keyof WebSocketRouteMap> = WebSocketRouteMap[P];
type ParamsOf<P extends keyof WebSocketRouteMap> =
  WsEntry<P> extends { params: infer T } ? T : Record<string, never>;
type ClientEventOf<P extends keyof WebSocketRouteMap> =
  WsEntry<P> extends { client: infer T } ? T : never;
type ServerEventOf<P extends keyof WebSocketRouteMap> =
  WsEntry<P> extends { server: infer T } ? T : never;
type HasParams<P extends keyof WebSocketRouteMap> =
  ParamsOf<P> extends Record<string, never>
    ? false
    : [keyof ParamsOf<P>] extends [never]
      ? false
      : true;

export type WebSocketConnection<ServerEvent = unknown> = {
  readonly id: string;
  readonly state: unknown;
  send(event: ServerEvent): Promise<void>;
  close(code?: number, reason?: string): void;
  setState(data: unknown): void;
};

export type RoomController<ServerEvent = unknown> = {
  broadcast(event: ServerEvent, excludeIds?: Array<string>): Promise<void>;
  getConnections(): Iterable<WebSocketConnection<ServerEvent>>;
  getConnection(id: string): WebSocketConnection<ServerEvent> | undefined;
};

export type WebSocketBaseContext = {
  readonly id: string;
  readonly params: ParamsRecord;
  readonly user: AuthUser | null;
  /**
   * The HTTP request in `onBeforeConnect`, `onConnect` and `onRequest`. In `onMessage` and
   * `onClose` the connection can resume after hibernation, so this is a placeholder without
   * headers, cookies or query. Use `params`, `user` or the connection `state` there.
   */
  readonly request: Request;
  readonly env: CloudEnv['Bindings'];
  readonly storage: DurableObjectStorage;
};

export type RoomContext<ServerEvent = unknown> = WebSocketBaseContext & {
  readonly room: RoomController<ServerEvent>;
  readonly connection: WebSocketConnection<ServerEvent>;
};

export type SocketContext<ServerEvent = unknown> = WebSocketBaseContext & {
  readonly socket: WebSocketConnection<ServerEvent>;
};

export type RoomDefinition<
  ClientSchema extends StandardSchemaV1 = StandardSchemaV1,
  ServerSchema extends StandardSchemaV1 = StandardSchemaV1,
> = {
  readonly __kind: 'room';
  /** Optional persistent resource name. Pin the name reported by `void info` before moving this route. */
  readonly name?: string;
  /** Optional instance key; preserve existing keys when renaming route parameters. */
  readonly key?: WebSocketInstanceKey;
  readonly messages: {
    client: ClientSchema;
    server: ServerSchema;
  };
  onBeforeConnect?: (
    ctx: RoomContext<StandardSchemaV1.InferInput<ServerSchema>>,
  ) => MaybePromise<Response | void>;
  onConnect?: (ctx: RoomContext<StandardSchemaV1.InferInput<ServerSchema>>) => MaybePromise<void>;
  onMessage?: (
    ctx: RoomContext<StandardSchemaV1.InferInput<ServerSchema>>,
    event: StandardSchemaV1.InferOutput<ClientSchema>,
  ) => MaybePromise<void>;
  onClose?: (
    ctx: RoomContext<StandardSchemaV1.InferInput<ServerSchema>>,
    details?: { code: number; reason: string; wasClean: boolean },
  ) => MaybePromise<void>;
  onRequest?: (
    ctx: RoomContext<StandardSchemaV1.InferInput<ServerSchema>>,
  ) => MaybePromise<Response>;
};

export type SocketDefinition<
  ClientSchema extends StandardSchemaV1 = StandardSchemaV1,
  ServerSchema extends StandardSchemaV1 = StandardSchemaV1,
> = {
  readonly __kind: 'socket';
  /** Optional persistent resource name. Pin the name reported by `void info` before moving this route. */
  readonly name?: string;
  /** Optional instance key; preserve existing keys when renaming route parameters. */
  readonly key?: WebSocketInstanceKey;
  readonly messages: {
    client: ClientSchema;
    server: ServerSchema;
  };
  onBeforeConnect?: (
    ctx: SocketContext<StandardSchemaV1.InferInput<ServerSchema>>,
  ) => MaybePromise<Response | void>;
  onConnect?: (ctx: SocketContext<StandardSchemaV1.InferInput<ServerSchema>>) => MaybePromise<void>;
  onMessage?: (
    ctx: SocketContext<StandardSchemaV1.InferInput<ServerSchema>>,
    event: StandardSchemaV1.InferOutput<ClientSchema>,
  ) => MaybePromise<void>;
  onClose?: (
    ctx: SocketContext<StandardSchemaV1.InferInput<ServerSchema>>,
    details?: { code: number; reason: string; wasClean: boolean },
  ) => MaybePromise<void>;
  onRequest?: (
    ctx: SocketContext<StandardSchemaV1.InferInput<ServerSchema>>,
  ) => MaybePromise<Response>;
};

export type AnyWebSocketDefinition = RoomDefinition | SocketDefinition;

export function defineRoom<
  ClientSchema extends StandardSchemaV1,
  ServerSchema extends StandardSchemaV1,
>(
  definition: Omit<RoomDefinition<ClientSchema, ServerSchema>, '__kind'>,
): RoomDefinition<ClientSchema, ServerSchema> {
  assertResourceName(definition.name);
  return { ...definition, __kind: 'room' };
}

export function defineWebSocket<
  ClientSchema extends StandardSchemaV1,
  ServerSchema extends StandardSchemaV1,
>(
  definition: Omit<SocketDefinition<ClientSchema, ServerSchema>, '__kind'>,
): SocketDefinition<ClientSchema, ServerSchema> {
  assertResourceName(definition.name);
  return { ...definition, __kind: 'socket' };
}

function assertResourceName(name: string | undefined): void {
  if (name !== undefined && !isResourceName(name)) {
    throw new Error('ws: name must contain a word starting with a letter.');
  }
}

export type VoidSocketCloseEvent = {
  code?: number;
  reason?: string;
  wasClean?: boolean;
};

export type ConnectCommonOptions = {
  baseURL?: string;
  reconnect?: boolean;
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
  protocols?: string | Array<string>;
};

type ConnectOptions<P extends keyof WebSocketRouteMap> = ConnectCommonOptions &
  (HasParams<P> extends true ? { params: ParamsOf<P> } : { params?: never });

type ListenerMap<ServerEvent> = {
  message: (event: ServerEvent) => void;
  open: () => void;
  close: (event: VoidSocketCloseEvent) => void;
  error: (error: unknown) => void;
};

export class VoidSocket<P extends keyof WebSocketRouteMap & string> {
  private socket: WebSocket | null = null;
  private readonly listeners: {
    [K in keyof ListenerMap<ServerEventOf<P>>]: Set<ListenerMap<ServerEventOf<P>>[K]>;
  } = {
    message: new Set(),
    open: new Set(),
    close: new Set(),
    error: new Set(),
  };
  private readonly buffer: Array<ClientEventOf<P>> = [];
  private reconnectAttempts = 0;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly url: string,
    private readonly options: ConnectCommonOptions,
  ) {
    this.connect();
  }

  private emit<K extends keyof ListenerMap<ServerEventOf<P>>>(
    type: K,
    value: Parameters<ListenerMap<ServerEventOf<P>>[K]>[0],
  ): void {
    for (const listener of this.listeners[type]) {
      listener(value as never);
    }
  }

  private connect(): void {
    const WebSocketCtor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WebSocketCtor) {
      throw new Error('ws: WebSocket is not available in this runtime.');
    }

    this.socket = new WebSocketCtor(this.url, this.options.protocols);
    this.socket.addEventListener('open', () => {
      this.reconnectAttempts = 0;
      const queued = this.buffer.splice(0);
      for (const item of queued) {
        this.socket?.send(JSON.stringify(item));
      }
      this.emit('open', undefined);
    });

    this.socket.addEventListener('message', (event: { data: string }) => {
      try {
        this.emit('message', JSON.parse(event.data) as ServerEventOf<P>);
      } catch (error) {
        this.emit('error', error);
      }
    });

    this.socket.addEventListener('error', (error) => {
      this.emit('error', error);
    });

    this.socket.addEventListener(
      'close',
      (event: { code?: number; reason?: string; wasClean?: boolean }) => {
        this.emit('close', {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });

        if (this.closedByUser || this.options.reconnect === false) {
          return;
        }
        if (
          this.options.maxReconnectAttempts != null &&
          this.reconnectAttempts >= this.options.maxReconnectAttempts
        ) {
          return;
        }

        this.reconnectAttempts += 1;
        const delay = this.options.reconnectDelayMs ?? 1_000;
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      },
    );
  }

  send(event: ClientEventOf<P>): void {
    if (this.socket?.readyState === 1) {
      this.socket.send(JSON.stringify(event));
      return;
    }
    this.buffer.push(event);
  }

  close(code?: number, reason?: string): void {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.close(code, reason);
  }

  on<K extends keyof ListenerMap<ServerEventOf<P>>>(
    type: K,
    handler: ListenerMap<ServerEventOf<P>>[K],
  ): () => void {
    this.listeners[type].add(handler as never);
    return () => {
      this.listeners[type].delete(handler as never);
    };
  }
}

function resolveBaseUrl(baseURL?: string): URL {
  if (baseURL) {
    return new URL(baseURL);
  }
  const location = (globalThis as { location?: { href: string } }).location;
  if (!location) {
    throw new Error('ws: connect() requires a browser-like runtime or an explicit "baseURL".');
  }
  return new URL(location.href);
}

export function connect<P extends keyof WebSocketRouteMap & string>(
  path: HasParams<P> extends false ? P : never,
): VoidSocket<P>;
export function connect<P extends keyof WebSocketRouteMap & string>(
  path: P,
  options: ConnectOptions<P>,
): VoidSocket<P>;
export function connect(
  path: string,
  options: ConnectCommonOptions & { params?: Record<string, string> } = {},
) {
  const base = resolveBaseUrl(options.baseURL);
  const resolvedPath = interpolateRouteParams(path, options.params);
  const url = new URL(resolvedPath, base);
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  return new VoidSocket(url.toString(), options);
}
