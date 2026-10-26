/** Stub interface augmented by the generated .void/routes.d.ts */
export interface RouteMap {}

/** Stub interface augmented by the generated .void/routes.d.ts */
export interface WebSocketRouteMap {}

/** Union of known route patterns (keys of the generated RouteMap). */
export type RouteName = keyof RouteMap;

/**
 * Destination type for rewrites / fallbacks / c.rewrite().
 *
 * The `string & {}` branch keeps IDE autocomplete of known routes while
 * still accepting arbitrary strings (needed for dynamic paths like
 * `/users/${id}`). When no routes are generated yet, `RouteName` is
 * `never` and this degenerates to `string & {}`, which is assignable
 * from any string.
 */
export type RewriteDestination = RouteName | (string & {});

/** Stub interface for page action types — augmented by generated routes.d.ts */
export interface PageActionMap {}

/** Parse "/path?action" into base path and action name */
export type ParseActionUrl<U extends string> = U extends `${infer Base}?${infer Action}`
  ? { base: Base; action: Action }
  : { base: U; action: never };

/** Resolve body type for a useForm URL (single action or named action) */
// A .dev + .prod page pair is a union of two page shapes. A type parameter
// makes these read each shape on its own.
type PageActionBody<P> = P extends { body: infer B } ? B : Record<string, unknown>;

type PageNamedActionBody<P, K> = P extends { actions: infer A }
  ? K extends keyof A
    ? A[K] extends { body: infer B }
      ? B
      : Record<string, unknown>
    : never
  : never;

export type ResolveActionBody<U extends string> =
  ParseActionUrl<U>['base'] extends keyof PageActionMap
    ? ParseActionUrl<U>['action'] extends never
      ? PageActionBody<PageActionMap[ParseActionUrl<U>['base']]>
      : PageNamedActionBody<PageActionMap[ParseActionUrl<U>['base']], ParseActionUrl<U>['action']>
    : Record<string, unknown>;

/** Resolve params type */
export type ResolveActionParams<U extends string> =
  ParseActionUrl<U>['base'] extends keyof PageActionMap
    ? PageActionMap[ParseActionUrl<U>['base']] extends { params: infer P }
      ? P
      : never
    : never;

/** Has params check */
export type HasActionParams<U extends string> = [ResolveActionParams<U>] extends [never]
  ? false
  : ResolveActionParams<U> extends Record<string, string>
    ? true
    : false;

type ActionFormBaseOptions = { resetOnSuccess?: boolean };

/** Form options type (requires params for dynamic routes) */
export type ActionFormOptions<U extends string> = ActionFormBaseOptions &
  (HasActionParams<U> extends true ? { params: ResolveActionParams<U> } : { params?: never });

/** Valid useForm URLs — single-action pages + "page?name" combos + default actions */
export type ActionUrl =
  | {
      [K in keyof PageActionMap]: PageActionMap[K] extends { body: unknown } ? K : never;
    }[keyof PageActionMap]
  | {
      [K in keyof PageActionMap]: PageActionMap[K] extends { actions: infer A }
        ? `${K & string}?${keyof A & string}`
        : never;
    }[keyof PageActionMap];
