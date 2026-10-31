import type { Context } from 'hono';
import { routeUrl, type RouteDestination, type RouteUrlInput } from 'void/routes';
import type { VoidRouter } from '../../src/pages/client.ts';
import {
  defineHandler,
  defineMiddleware,
  type CloudContext,
  type CloudEnv,
} from '../../src/runtime/handler.ts';

declare module 'void/routes' {
  interface RoutePathMap {
    '/typed-navigation': never;
    '/typed-navigation/:id': 'id';
  }
}

export function checkTypedServerDestinations(c: Context<CloudEnv>): void {
  const cloudContext: CloudContext = c;
  void cloudContext;
  const target = routeUrl('/typed-navigation/:id', {
    params: { id: 123 },
    query: { tab: 'activity' },
    hash: 'details',
  });
  const response: Response & { _status: 307 } = c.redirect(target, 307);
  void response;
  void c.rewrite({
    pathname: '/typed-navigation/:id',
    params: { id: 123 },
    query: { tab: 'activity' },
    hash: 'details',
  });
  c.redirect('/unknown');
  c.redirect(new URL('https://example.com'));
  void c.rewrite('/unknown');
  // @ts-expect-error typed rewrite destinations require params
  void c.rewrite({ pathname: '/typed-navigation/:id' });
  // @ts-expect-error typed rewrite parameter names are checked
  void c.rewrite({ pathname: '/typed-navigation/:id', params: { wrong: '123' } });
  defineHandler((context) => context.redirect(target));
  defineMiddleware(async (context) => context.redirect(target, 303));
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
