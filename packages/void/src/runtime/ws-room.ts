/**
 * Server-side room handle — exposed via `void/ws/server`.
 *
 * `getRoom()` addresses the same Durable Object instance a client's `connect()`
 * reaches and calls the actions declared by `defineRoom()`. Actions run inside the
 * room's Durable Object, so they can broadcast or close connections locally.
 */
import type { WebSocketRouteMap } from 'void/routes';
import { getRawRuntimeEnv, type RuntimeEnv } from './env-raw.ts';
import {
  buildWebSocketInstanceId,
  __getWebSocketRoute,
  type WebSocketRouteMeta,
} from './ws-server.ts';
import type { RoomActionContext } from './ws.ts';

type RouteParamsOf<P extends keyof WebSocketRouteMap> = WebSocketRouteMap[P] extends {
  params: infer T;
}
  ? T
  : Record<string, never>;

type HasParams<P extends keyof WebSocketRouteMap> =
  RouteParamsOf<P> extends Record<string, never>
    ? false
    : [keyof RouteParamsOf<P>] extends [never]
      ? false
      : true;

type RoomActionsOf<P extends keyof WebSocketRouteMap> = WebSocketRouteMap[P] extends {
  actions: infer T;
}
  ? T
  : never;

/** Route patterns that declare `actions` in `defineRoom()`. */
export type RoomPath = {
  [P in keyof WebSocketRouteMap]: WebSocketRouteMap[P] extends { actions: unknown } ? P : never;
}[keyof WebSocketRouteMap];

type ActionArgs<T> = T extends (context: RoomActionContext, ...args: infer A) => unknown
  ? A
  : never;

type ActionResult<T> = T extends (context: RoomActionContext, ...args: Array<never>) => infer R
  ? Awaited<R>
  : never;

/** Handle for one room instance. Each action is called like a local async function. */
export type RoomHandle<P extends RoomPath> = {
  readonly actions: {
    [K in keyof RoomActionsOf<P>]: (
      ...args: ActionArgs<RoomActionsOf<P>[K]>
    ) => Promise<ActionResult<RoomActionsOf<P>[K]>>;
  };
};

export type RoomOptions<P extends RoomPath> = {
  /** Bindings to read instead of the current runtime env, for code outside a request scope. */
  env?: RuntimeEnv;
} & (HasParams<P> extends true ? { params: RouteParamsOf<P> } : { params?: never });

type RoomActionRequest = {
  name: string;
  args: Array<unknown>;
  id: string;
  params: Record<string, string>;
};

type RoomActionStub = {
  __voidRoomAction(request: RoomActionRequest): Promise<unknown>;
};

function resolveRoomBinding(
  route: WebSocketRouteMeta,
  explicitEnv: RuntimeEnv | undefined,
): DurableObjectNamespace {
  let env: RuntimeEnv;
  if (explicitEnv) {
    env = explicitEnv;
  } else {
    try {
      env = getRawRuntimeEnv();
    } catch {
      throw new Error(
        'ws: getRoom() needs a runtime env. Call it from a route, queue, cron or auth hook running inside Void, or pass { env }.',
      );
    }
  }
  const binding = env[route.bindingName] as DurableObjectNamespace | undefined;
  if (!binding) {
    throw new Error(`ws: Missing Durable Object binding "${route.bindingName}".`);
  }
  return binding;
}

function createActionProxy(
  stub: RoomActionStub,
  id: string,
  params: Record<string, string>,
): Record<string, (...args: Array<unknown>) => Promise<unknown>> {
  return new Proxy({} as Record<string, (...args: Array<unknown>) => Promise<unknown>>, {
    get(_target, property) {
      // `await` and `Promise.resolve` read `then`. Returning a function there would
      // dispatch an action named "then" with resolver callbacks it cannot clone.
      if (typeof property !== 'string' || property === 'then') {
        return undefined;
      }
      return (...args: Array<unknown>) =>
        stub.__voidRoomAction({ name: property, args, id, params });
    },
  });
}

export function getRoom<P extends RoomPath & string>(
  path: HasParams<P> extends false ? P : never,
  options?: RoomOptions<P>,
): RoomHandle<P>;
export function getRoom<P extends RoomPath & string>(
  path: P,
  options: RoomOptions<P>,
): RoomHandle<P>;
export function getRoom(
  path: string,
  options: { params?: Record<string, string>; env?: RuntimeEnv } = {},
): RoomHandle<RoomPath & string> {
  const route = __getWebSocketRoute(path);
  if (!route) {
    throw new Error(
      `ws: Unknown WebSocket route "${path}". Use the pattern of a routes/ *.ws.ts file.`,
    );
  }
  if (route.mode !== 'room') {
    throw new Error(
      `ws: getRoom() requires a defineRoom() route; "${path}" is a defineWebSocket() route.`,
    );
  }
  const params = options.params ?? {};
  for (const name of route.params) {
    if (typeof params[name] !== 'string') {
      throw new TypeError(`ws: Missing route param "${name}" for "${path}".`);
    }
  }
  const binding = resolveRoomBinding(route, options.env);
  const id = buildWebSocketInstanceId(route, params);
  const stub = binding.get(binding.idFromName(id)) as unknown as RoomActionStub;
  return { actions: createActionProxy(stub, id, params) } as RoomHandle<RoomPath & string>;
}
