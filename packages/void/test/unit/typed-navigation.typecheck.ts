import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { expectTypeOf } from 'vite-plus/test';
import {
  routeUrl,
  type Href,
  type RouteDestination,
  type RouteUrl,
  type RouteUrlInput,
} from 'void/routes';
import type { VoidRouter } from '../../src/pages/client.ts';
import {
  defineHandler,
  defineMiddleware,
  type CloudContext,
  type CloudEnv,
} from '../../src/runtime/handler.ts';
import { connectLiveStream } from '../../src/runtime/live-client.ts';
import { connectEventStream } from '../../src/runtime/sse-client.ts';

declare module 'void/routes' {
  interface RoutePathMap {
    '/typed-navigation': never;
    '/typed-navigation/:id': 'id';
  }
}

// This package typecheck leaves `routing.typedRoutes` off, so a string is a route URL.
// The route-url builder fixture covers the checked case.
export function checkUntypedHonoCompatibility(c: Context<CloudEnv>): void {
  const cloud: CloudContext = c;
  const hono: Context<CloudEnv> = cloud;
  const readUser = (context: CloudContext) => context.get('user');
  const middleware: MiddlewareHandler<CloudEnv> = async (context, next) => {
    readUser(context);
    await next();
  };
  defineHandler(middleware, (context) => context.text('ok'));
  cloud.set('user', null);
  // @ts-expect-error compatibility overloads must not bypass context variable types
  cloud.set('user', 'not a user');
  // @ts-expect-error compatibility overloads must not accept arbitrary symbol keys
  cloud.set(Symbol('user'), null);
  void [hono, getCookie(cloud, 'session')];
}

export function checkTypedServerDestinations(c: CloudContext): void {
  const target = routeUrl('/typed-navigation/:id', {
    params: { id: 123 },
    query: { tab: 'activity' },
    hash: 'details',
  });
  const response: Response & { _status: 307 } = c.redirect(target, 307);
  void response;
  expectTypeOf<Parameters<CloudContext['redirect']>[0]>().toEqualTypeOf<RouteUrlInput>();
  // Hono helpers and functions typed with Hono's `Context` still take `c`.
  const honoContext: Context = c;
  void [honoContext, getCookie(c, 'session')];
  void c.rewrite({
    pathname: '/typed-navigation/:id',
    params: { id: 123 },
    query: { tab: 'activity' },
    hash: 'details',
  });
  c.redirect('/unknown');
  c.redirect('https://example.com/login');
  c.redirect(new URL('https://example.com/login'));
  c.redirect({
    pathname: '/typed-navigation/:id',
    params: { id: 123 },
    query: { tab: 'activity' },
    hash: 'details',
  });
  const dynamic: string = 'https://example.com/callback';
  c.redirect(dynamic as Href);
  void c.rewrite('/unknown');
  // @ts-expect-error typed rewrite destinations require params
  void c.rewrite({ pathname: '/typed-navigation/:id' });
  // @ts-expect-error typed rewrite parameter names are checked
  void c.rewrite({ pathname: '/typed-navigation/:id', params: { wrong: '123' } });
  defineHandler((context) => context.redirect(target));
  defineHandler((context) =>
    context.redirect({ pathname: '/typed-navigation/:id', params: { id: '123' } }),
  );
  defineHandler((context) => context.redirect('/unknown'));
  defineMiddleware(async (context) => context.redirect(target, 303));
  defineMiddleware(async (context) => context.redirect(dynamic));
}

export function checkTypedNavigation(router: VoidRouter): void {
  const target: RouteDestination = {
    pathname: '/typed-navigation/:id',
    params: { id: 123 },
    query: { tab: 'activity' },
    hash: 'details',
  };
  const url: RouteUrlInput = target;
  void router.visit(url);
  void router.visit(url, { resolveOn: 'data' });
  void router.refresh({ resolveOn: 'commit' });
  // @ts-expect-error completion is data or commit
  void router.refresh({ resolveOn: 'render' });
  void router.prefetch(target);
  router.flush(target);
  void router.visit('../relative');
  void router.prefetch(new URL('https://example.com'));
  // @ts-expect-error dynamic destinations require params
  void router.visit({ pathname: '/typed-navigation/:id' });
  // @ts-expect-error unknown patterns are not accepted in typed destinations
  void router.prefetch({ pathname: '/typed-navigation-typo' });
  // @ts-expect-error parameter names are checked
  router.flush({ pathname: '/typed-navigation/:id', params: { wrong: 123 } });
}

// Without routing.typedRoutes, URL strings stay unchecked.
export function checkUntypedRouteStrings(): void {
  expectTypeOf<RouteUrl>().toEqualTypeOf<string>();
  expectTypeOf<Href>().toEqualTypeOf<string>();
  expectTypeOf(routeUrl('/typed-navigation')).toEqualTypeOf<string>();
}

export function checkUntypedStreamUrls(url: string): void {
  expectTypeOf<Parameters<typeof connectEventStream>[0]>().toEqualTypeOf<string | URL>();
  expectTypeOf<Parameters<typeof connectLiveStream>[0]>().toEqualTypeOf<string | URL>();
  connectEventStream(url);
  connectLiveStream(url);
  connectEventStream('/unknown');
  connectLiveStream('ws://example.com/live');
}
