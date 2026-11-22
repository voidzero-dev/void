import type { Href, PageQueryMap, RoutePath, RoutePathMap, RouteQuery } from 'void/routes';

/**
 * The destination page's own query type, from its loader's schema.
 *
 * This lives apart from `route-url.ts` on purpose. A page server reaches
 * `route-url.ts` through `void`, so reading a page loader's inferred type back
 * into that module makes the loader's own type circular and it infers as `any`.
 * Router navigation is client-only, so nothing here is in a loader's type graph.
 */
type RouteQueryOptions<P> = P extends keyof PageQueryMap
  ? [PageQueryMap[P]['input']] extends [never]
    ? { query?: RouteQuery }
    : {} extends PageQueryMap[P]['input']
      ? { query?: PageQueryMap[P]['input'] }
      : { query: PageQueryMap[P]['input'] }
  : { query?: RouteQuery };

/** A navigation destination, checked against the destination page's query schema. */
export type NavigationDestination<P extends RoutePath = RoutePath> = P extends RoutePath
  ? { pathname: P } & RouteQueryOptions<P> &
      ([RoutePathMap[P]] extends [never]
        ? { params?: never }
        : { params: { [K in RoutePathMap[P] & string]: string | number } }) & { hash?: string }
  : never;

/** Anything router navigation accepts. */
export type RouteNavigationInput = Href | URL | NavigationDestination;
