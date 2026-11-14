import { DurableObject as CloudflareDurableObject } from 'cloudflare:workers';
import type { StandardSchemaV1 } from '../standard-schema.ts';
import { authContext, type AuthState, type AuthUser } from './auth.ts';
import type { VoidAuthEnv, VoidAuthRuntimeOptions } from './better-auth-shared.ts';
import { withRuntimeEnv } from './env.ts';
import type { CloudEnv } from './handler.ts';
import type {
  AnyWebSocketDefinition,
  RoomActionContext,
  RoomContext,
  RoomController,
  SocketContext,
  WebSocketConnection,
  WebSocketInstanceKey,
} from './ws.ts';

export type WebSocketRouteMeta = {
  name?: string;
  key?: WebSocketInstanceKey;
  pattern: string;
  params: Array<string>;
  className: string;
  bindingName: string;
  /** `room` routes accept `getRoom()` actions; `socket` routes do not. */
  mode?: 'room' | 'socket';
};

export type WebSocketDurableObjectInstance = {
  fetch(request: Request): Promise<Response>;
  /** Server-only RPC used by `getRoom()`. Never reachable from a client message or HTTP request. */
  __voidRoomAction?(request: RoomActionRequest): Promise<unknown>;
  webSocketMessage(
    webSocket: WebSocket,
    message: string | ArrayBuffer | ArrayBufferView,
  ): Promise<void>;
  webSocketClose(
    webSocket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void>;
};

type RoomActionRequest = {
  name: string;
  args: Array<unknown>;
  /** Instance id the caller addressed, so actions see the same `id` clients do. */
  id: string;
  params: Record<string, string>;
};

export type WebSocketDurableObjectClass = {
  new (state: DurableObjectState, env: Record<string, unknown>): WebSocketDurableObjectInstance;
};

type ResolveVoidAuthState = (
  request: Request,
  env: VoidAuthEnv,
  runtime: VoidAuthRuntimeOptions,
) => Promise<AuthState | null>;

type StoredConnection = {
  id: string;
  params: Record<string, string>;
  roomId: string;
  user: AuthUser | null;
  authState?: AuthState | null;
  state?: unknown;
};

function matchRoute(
  pattern: string,
  pathname: string,
): { matched: boolean; params: Record<string, string> } {
  const patternSegments = pattern.split('/').filter(Boolean);
  const pathSegments = pathname.split('/').filter(Boolean);
  const params: Record<string, string> = {};

  let i = 0;
  for (; i < patternSegments.length; i++) {
    const patternSegment = patternSegments[i]!;
    const pathSegment = pathSegments[i];

    if (patternSegment === '*') {
      return { matched: true, params };
    }

    if (patternSegment.endsWith('{.+}') && patternSegment.startsWith(':')) {
      params[patternSegment.slice(1, -4)] = decodeURIComponent(pathSegments.slice(i).join('/'));
      return { matched: true, params };
    }

    if (pathSegment == null) {
      return { matched: false, params: {} };
    }

    if (patternSegment.startsWith(':')) {
      params[patternSegment.slice(1)] = decodeURIComponent(pathSegment);
      continue;
    }

    if (patternSegment !== pathSegment) {
      return { matched: false, params: {} };
    }
  }

  if (i !== pathSegments.length) {
    return { matched: false, params: {} };
  }

  return { matched: true, params };
}

function getRouteMatch(request: Request, route: WebSocketRouteMeta): Record<string, string> | null {
  const { pathname } = new URL(request.url);
  const match = matchRoute(route.pattern, pathname);
  return match.matched ? match.params : null;
}

export function buildWebSocketInstanceId(
  route: Pick<WebSocketRouteMeta, 'params' | 'key'>,
  params: Record<string, string>,
): string {
  if (route.key) {
    const key = route.key({ params });
    if (typeof key !== 'string') {
      throw new Error('ws: key must return a string synchronously.');
    }
    return key;
  }
  if (route.params.length === 0) {
    return 'default';
  }
  const entries = route.params.map((name) => [name, params[name] ?? ''] as const);
  if (entries.length > 1 && entries.some(([, value]) => value.includes('&'))) {
    // Keep unambiguous legacy identities. Ambiguous tuples must not adopt the
    // old shared object's data, or collide with literal percent-encoded values.
    return `v2:${JSON.stringify(entries)}`;
  }
  return route.params.map((name) => `${name}=${params[name] ?? ''}`).join('&');
}

/** Present bracket parameters without changing the router's compiled patterns. */
function canonicalWebSocketPattern(pattern: string): string {
  return pattern
    .split('/')
    .map((segment) => {
      if (segment === '[...]') {
        return '*';
      }
      const param = segment.match(/^\[\.\.\.([^\]]+)\]$/);
      if (param) {
        return `:${param[1]}{.+}`;
      }
      const named = segment.match(/^\[([^\]]+)\]$/);
      return named ? `:${named[1]}` : segment;
    })
    .join('/');
}

/**
 * Route metadata for `getRoom()`. The generated route table registers it once per
 * worker, so server code can address the same instance a client's `connect()` does.
 * Shared through `globalThis` because dev can evaluate this module more than once.
 */
const WEB_SOCKET_ROUTES_SYMBOL: unique symbol = Symbol.for('void.webSocketRoutes.v1');
const sharedWebSocketRoutes = globalThis as {
  [WEB_SOCKET_ROUTES_SYMBOL]?: Map<string, WebSocketRouteMeta>;
};
const webSocketRoutes = (sharedWebSocketRoutes[WEB_SOCKET_ROUTES_SYMBOL] ??= new Map());

/** @internal Called by the generated route table. */
export function __registerWebSocketRoutes(routes: Array<WebSocketRouteMeta>): void {
  webSocketRoutes.clear();
  for (const route of routes) {
    webSocketRoutes.set(canonicalWebSocketPattern(route.pattern), route);
  }
}

/** @internal Route metadata registered by the generated route table. */
export function __getWebSocketRoute(pattern: string): WebSocketRouteMeta | undefined {
  return webSocketRoutes.get(canonicalWebSocketPattern(pattern));
}

async function serializeServerEvent(schema: StandardSchemaV1, event: unknown): Promise<string> {
  const result = await schema['~standard'].validate(event);
  if (result.issues) {
    throw new Error(
      `ws: Message validation failed: ${result.issues.map((issue) => issue.message).join('; ')}.`,
    );
  }
  return JSON.stringify(result.value);
}

function parseIncomingMessage(message: string | ArrayBuffer | ArrayBufferView): string {
  if (typeof message === 'string') {
    return message;
  }
  if (message instanceof ArrayBuffer) {
    return new TextDecoder().decode(message);
  }
  return new TextDecoder().decode(
    message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength),
  );
}

function withAuthState<T>(state: AuthState | null, fn: () => Promise<T> | T): Promise<T> {
  return Promise.resolve(authContext.run({ user: state?.user ?? null, state }, fn));
}

function getStoredConnection(webSocket: WebSocket): StoredConnection {
  const stored = (
    webSocket as WebSocket & {
      deserializeAttachment?: () => StoredConnection | undefined;
    }
  ).deserializeAttachment?.();

  if (stored) {
    return {
      ...stored,
      authState: stored.authState ?? null,
    };
  }

  return {
    id: crypto.randomUUID(),
    params: {},
    roomId: 'default',
    user: null,
    authState: null,
  };
}

function completeWebSocketClose(webSocket: WebSocket, code: number, reason: string): void {
  if (webSocket.readyState === 3) {
    return;
  }
  if ([1004, 1005, 1006, 1015].includes(code)) {
    webSocket.close();
  } else {
    webSocket.close(code, reason);
  }
}

function setStoredConnection(webSocket: WebSocket, data: StoredConnection): void {
  (
    webSocket as WebSocket & { serializeAttachment?: (value: StoredConnection) => void }
  ).serializeAttachment?.(data);
}

function createConnection<ServerEvent>(
  webSocket: WebSocket,
  serverSchema: StandardSchemaV1,
): WebSocketConnection<ServerEvent> {
  return {
    get id() {
      return getStoredConnection(webSocket).id;
    },
    get state() {
      return getStoredConnection(webSocket).state;
    },
    async send(event) {
      webSocket.send(await serializeServerEvent(serverSchema, event));
    },
    close(code, reason) {
      webSocket.close(code, reason);
    },
    setState(data) {
      const stored = getStoredConnection(webSocket);
      setStoredConnection(webSocket, { ...stored, state: data });
    },
  };
}

function createRoomController<ServerEvent>(
  state: DurableObjectState,
  serverSchema: StandardSchemaV1,
): RoomController<ServerEvent> {
  return {
    async broadcast(event, excludeIds = []) {
      const payload = await serializeServerEvent(serverSchema, event);
      for (const socket of state.getWebSockets()) {
        const stored = getStoredConnection(socket);
        if (excludeIds.includes(stored.id)) {
          continue;
        }
        socket.send(payload);
      }
    },
    getConnections() {
      return state
        .getWebSockets()
        .map((socket) => createConnection<ServerEvent>(socket, serverSchema));
    },
    getConnection(id) {
      const socket = state.getWebSockets().find((item) => getStoredConnection(item).id === id);
      return socket ? createConnection<ServerEvent>(socket, serverSchema) : undefined;
    },
  };
}

function createHookContext(
  definition: AnyWebSocketDefinition,
  state: DurableObjectState,
  env: Record<string, unknown>,
  request: Request,
  webSocket: WebSocket,
  stored: StoredConnection,
): RoomContext | SocketContext {
  const serverSchema = definition.messages.server;
  const base = {
    id: stored.roomId,
    params: stored.params,
    user: stored.user,
    request,
    env: env as CloudEnv['Bindings'],
    storage: state.storage,
  };
  const connection = createConnection<unknown>(webSocket, serverSchema);
  return definition.__kind === 'room'
    ? { ...base, room: createRoomController<unknown>(state, serverSchema), connection }
    : { ...base, socket: connection };
}

function assertDefinition(definition: AnyWebSocketDefinition): void {
  if (!definition?.messages?.client || !definition?.messages?.server) {
    throw new Error('ws: WebSocket routes must define both messages.client and messages.server.');
  }
}

export function createWebSocketDurableObject(
  definition: AnyWebSocketDefinition,
  route: WebSocketRouteMeta,
  authRuntime?: VoidAuthRuntimeOptions,
  resolveAuthState?: ResolveVoidAuthState,
): WebSocketDurableObjectClass {
  assertDefinition(definition);
  if (definition.name !== route.name) {
    throw new Error(
      'ws: name must be statically discoverable in the route definition. Run void info to inspect this route.',
    );
  }
  const instanceRoute = { ...route, key: definition.key };

  class VoidWebSocketDurableObject
    extends CloudflareDurableObject<Record<string, unknown>>
    implements WebSocketDurableObjectInstance
  {
    readonly state: DurableObjectState;

    constructor(state: DurableObjectState, env: Record<string, unknown>) {
      // Extending `DurableObject` enables RPC, which is how `getRoom()` reaches actions.
      // Every other method stays `#`-private so it never joins that RPC surface.
      super(state, env);
      this.state = state;
    }

    fetch(request: Request): Promise<Response> {
      return withRuntimeEnv(this.env, () => this.#handleFetch(request));
    }

    async __voidRoomAction(request: RoomActionRequest): Promise<unknown> {
      return withRuntimeEnv(this.env, () => {
        const actions = definition.__kind === 'room' ? definition.actions : undefined;
        const action =
          actions && Object.hasOwn(actions, request.name) ? actions[request.name] : undefined;
        if (typeof action !== 'function') {
          throw new Error(`ws: Unknown room action "${request.name}".`);
        }
        const context: RoomActionContext = {
          id: request.id,
          params: request.params,
          env: this.env as CloudEnv['Bindings'],
          storage: this.state.storage,
          room: createRoomController<unknown>(this.state, definition.messages.server),
        };
        const handler = action as (context: RoomActionContext, ...args: Array<unknown>) => unknown;
        return handler(context, ...request.args);
      });
    }

    #context(
      request: Request,
      webSocket: WebSocket,
      stored: StoredConnection,
    ): RoomContext | SocketContext {
      return createHookContext(definition, this.state, this.env, request, webSocket, stored);
    }

    async #handleFetch(request: Request): Promise<Response> {
      const params = getRouteMatch(request, route) ?? {};
      const roomId = buildWebSocketInstanceId(instanceRoute, params);
      const authState =
        authRuntime && resolveAuthState
          ? await resolveAuthState(request, this.env as VoidAuthEnv, authRuntime)
          : null;
      const user = authState?.user ?? null;
      const upgrade = request.headers.get('upgrade');

      if (upgrade?.toLowerCase() === 'websocket') {
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        const stored: StoredConnection = {
          id: crypto.randomUUID(),
          params,
          roomId,
          user,
          authState,
        };
        setStoredConnection(server, stored);

        const beforeConnectCtx = this.#context(request, server, stored);
        const decision = await withAuthState(authState, () =>
          definition.onBeforeConnect?.(beforeConnectCtx as never),
        );
        if (decision instanceof Response) {
          return decision;
        }

        this.state.acceptWebSocket(server);

        const connectCtx = this.#context(request, server, stored);
        await withAuthState(authState, () => definition.onConnect?.(connectCtx as never));

        return new Response(null, { status: 101, webSocket: client });
      }

      if (!definition.onRequest) {
        return new Response('Upgrade Required', { status: 426 });
      }

      const stored: StoredConnection = {
        id: crypto.randomUUID(),
        params,
        roomId,
        user,
        authState,
      };
      const ctx = this.#context(request, new WebSocketPair()[1], stored);
      return withAuthState(authState, () => definition.onRequest!(ctx as never));
    }

    webSocketMessage(
      webSocket: WebSocket,
      message: string | ArrayBuffer | ArrayBufferView,
    ): Promise<void> {
      return withRuntimeEnv(this.env, () => this.#handleWebSocketMessage(webSocket, message));
    }

    async #handleWebSocketMessage(
      webSocket: WebSocket,
      message: string | ArrayBuffer | ArrayBufferView,
    ): Promise<void> {
      const stored = getStoredConnection(webSocket);
      const raw = parseIncomingMessage(message);

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        webSocket.close(1007, 'Invalid JSON');
        return;
      }

      const result = await definition.messages.client['~standard'].validate(parsed);
      if (result.issues) {
        webSocket.close(1007, 'Invalid message');
        return;
      }

      const request = new Request(`https://void.local${route.pattern}`);
      const ctx = this.#context(request, webSocket, stored);
      await withAuthState(stored.authState ?? null, () =>
        definition.onMessage?.(ctx as never, result.value as never),
      );
    }

    webSocketClose(
      webSocket: WebSocket,
      code: number,
      reason: string,
      wasClean: boolean,
    ): Promise<void> {
      return withRuntimeEnv(this.env, () =>
        this.#handleWebSocketClose(webSocket, code, reason, wasClean),
      );
    }

    async #handleWebSocketClose(
      webSocket: WebSocket,
      code: number,
      reason: string,
      wasClean: boolean,
    ): Promise<void> {
      completeWebSocketClose(webSocket, code, reason);
      const stored = getStoredConnection(webSocket);
      const request = new Request(`https://void.local${route.pattern}`);
      const ctx = this.#context(request, webSocket, stored);
      await withAuthState(stored.authState ?? null, () =>
        definition.onClose?.(ctx as never, { code, reason, wasClean }),
      );
    }
  }

  return VoidWebSocketDurableObject;
}

/** Keep a removed WebSocket Durable Object class deployable without deleting its storage. */
export function createWebSocketTombstoneDurableObject(
  className: string,
): WebSocketDurableObjectClass {
  return class VoidWebSocketTombstoneDurableObject implements WebSocketDurableObjectInstance {
    constructor(
      public readonly state: DurableObjectState,
      public readonly env: Record<string, unknown>,
    ) {}

    async fetch(): Promise<Response> {
      return new Response(`WebSocket route ${className} has been removed.`, { status: 410 });
    }

    async webSocketMessage(webSocket: WebSocket): Promise<void> {
      webSocket.close(1012, 'WebSocket route removed');
    }

    async webSocketClose(webSocket: WebSocket, code: number, reason: string): Promise<void> {
      completeWebSocketClose(webSocket, code, reason);
    }
  };
}

function getStub(
  env: Record<string, unknown>,
  route: WebSocketRouteMeta,
  params: Record<string, string>,
) {
  const binding = env[route.bindingName] as DurableObjectNamespace | undefined;
  if (!binding) {
    return null;
  }
  const id = binding.idFromName(buildWebSocketInstanceId(route, params));
  return binding.get(id);
}

export async function forwardWebSocketRequest(
  request: Request,
  env: Record<string, unknown>,
  route: WebSocketRouteMeta,
): Promise<Response> {
  const params = getRouteMatch(request, route) ?? {};
  const stub = getStub(env, route, params);
  if (!stub) {
    return new Response(`Missing Durable Object binding "${route.bindingName}"`, { status: 503 });
  }
  return stub.fetch(request);
}
