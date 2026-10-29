import { describe, expectTypeOf, it } from 'vite-plus/test';
import { routeUrl, type RouteOptions, type RoutePath } from '../../src/routes-stub.ts';

declare module 'void/routes' {
  interface RoutePathMap {
    '/route-types': never;
    '/route-types/:id': 'id';
    '/route-types/:org/:id': 'org' | 'id';
    '/route-types/files/:path{.+}': 'path';
    '/route-types/files/*': '*';
  }
}

describe('routeUrl types', () => {
  it('accepts known patterns and returns a string', () => {
    expectTypeOf(routeUrl('/route-types')).toEqualTypeOf<string>();
    expectTypeOf<'/route-types/:id'>().toMatchTypeOf<RoutePath>();
    routeUrl('/route-types', { query: { page: 1, tags: ['one', 'two'] }, hash: 'heading' });
    routeUrl('/route-types/:id', { params: { id: '123' } });
    routeUrl('/route-types/:org/:id', { params: { org: 'void', id: 123 } });
    routeUrl('/route-types/files/:path{.+}', { params: { path: 'a/b' } });
    routeUrl('/route-types/files/*', { params: { '*': 'a/b' } });
    const options: RouteOptions<'/route-types/:id'> = { params: { id: '123' } };
    routeUrl('/route-types/:id', options);
  });

  it('rejects unknown paths and incorrect params', () => {
    // @ts-expect-error unknown route
    routeUrl('/route-types/typo');
    // @ts-expect-error require the pattern instead of a concrete dynamic URL
    routeUrl('/route-types/123');
    // @ts-expect-error params are required
    routeUrl('/route-types/:id');
    // @ts-expect-error params are required even when other options are provided
    routeUrl('/route-types/:id', { query: { page: 1 } });
    // @ts-expect-error param names must match
    routeUrl('/route-types/:id', { params: { wrong: '123' } });
    // @ts-expect-error all params are required
    routeUrl('/route-types/:org/:id', { params: { id: '123' } });
    // @ts-expect-error static routes do not accept params
    routeUrl('/route-types', { params: { id: '123' } });
    // @ts-expect-error extra params are rejected
    routeUrl('/route-types/:id', { params: { id: '123', extra: 'x' } });
    // @ts-expect-error param values must be strings or numbers
    routeUrl('/route-types/:id', { params: { id: true } });
    // @ts-expect-error only URL query values are supported
    routeUrl('/route-types', { query: { nested: { value: 'x' } } });
    // @ts-expect-error the hash must be a string
    routeUrl('/route-types', { hash: 123 });
    const unknown: string = '/route-types';
    // @ts-expect-error arbitrary strings must not bypass route checking
    routeUrl(unknown);
  });

  it('requires every possible param when a path is a union', () => {
    const path = '' as '/route-types' | '/route-types/:id';
    // @ts-expect-error one of the possible routes requires params
    routeUrl(path);
    routeUrl(path, { params: { id: '123' } });
  });
});
