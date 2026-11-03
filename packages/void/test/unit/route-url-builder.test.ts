import { describe, expect, it } from 'vite-plus/test';
import { routeUrl } from '../../src/routes-stub.ts';
import { toUrlString } from '../../src/runtime/route-url.ts';

declare module 'void/routes' {
  interface RoutePathMap {
    '/': never;
    '/route-util': never;
    '/route-util/café menu': never;
    '/route-util/:id': 'id';
    '/route-util/:id2/:id/:id': 'id2' | 'id';
    '/route-util/files/:path{.+}': 'path';
    '/route-util/files/*': '*';
    '/route-util/:toString': 'toString';
    '/:leading{.+}': 'leading';
  }
}

describe('routeUrl', () => {
  it('converts typed destinations and preserves ordinary URLs', () => {
    expect(
      toUrlString({
        pathname: '/route-util/:id',
        params: { id: 'a/b' },
        query: { page: 2 },
        hash: 'details',
      }),
    ).toBe('/route-util/a%2Fb?page=2#details');
    expect(toUrlString('../users?tab=one#details')).toBe('../users?tab=one#details');
    expect(toUrlString(new URL('https://example.com/users?tab=one#details'))).toBe(
      'https://example.com/users?tab=one#details',
    );
  });

  it('returns static paths as ordinary strings', () => {
    expect(routeUrl('/')).toBe('/');
    expect(routeUrl('/', { hash: '#' })).toBe('/');
    expect(routeUrl('/route-util')).toBe('/route-util');
    expect(routeUrl('/route-util', {})).toBe('/route-util');
  });

  it('serializes the pathname, query and fragment as a URL', () => {
    expect(routeUrl('/route-util/café menu')).toBe('/route-util/caf%C3%A9%20menu');
    expect(
      routeUrl('/route-util/café menu', {
        query: { q: 'café menu' },
        hash: 'café menu',
      }),
    ).toBe('/route-util/caf%C3%A9%20menu?q=caf%C3%A9+menu#caf%C3%A9%20menu');
  });

  it('encodes path parameters and accepts numeric IDs', () => {
    expect(routeUrl('/route-util/:id', { params: { id: 'a/b ?#%' } })).toBe(
      '/route-util/a%2Fb%20%3F%23%25',
    );
    expect(routeUrl('/route-util/:id', { params: { id: 0 } })).toBe('/route-util/0');
    expect(routeUrl('/route-util/:id2/:id/:id', { params: { id: 'one', id2: 'two' } })).toBe(
      '/route-util/two/one/one',
    );
  });

  it('encodes each catch-all segment while preserving path separators', () => {
    expect(
      routeUrl('/route-util/files/:path{.+}', { params: { path: 'docs/get started.md' } }),
    ).toBe('/route-util/files/docs/get%20started.md');
    expect(routeUrl('/route-util/files/*', { params: { '*': 'docs/a?b#c' } })).toBe(
      '/route-util/files/docs/a%3Fb%23c',
    );
    expect(routeUrl('/route-util/files/*', { params: { '*': '' } })).toBe('/route-util/files/');
    expect(routeUrl('/route-util/files/*', { params: { '*': 'a//b%2Fc' } })).toBe(
      '/route-util/files/a//b%252Fc',
    );
  });

  it('serializes query values, repeats arrays and omits nullish values', () => {
    const query = {
      q: 'a&b c',
      page: 2,
      enabled: false,
      empty: '',
      tag: ['one', null, 'two', undefined] as const,
      missing: undefined,
      absent: null,
      none: [],
    };
    expect(routeUrl('/route-util', { query })).toBe(
      '/route-util?q=a%26b+c&page=2&enabled=false&empty=&tag=one&tag=two',
    );
    expect(query.tag).toEqual(['one', null, 'two', undefined]);
    expect(routeUrl('/route-util', { query: { missing: null } })).toBe('/route-util');
  });

  it('appends a URL fragment after the query string', () => {
    expect(
      routeUrl('/route-util/:id', {
        params: { id: 42 },
        query: { tab: 'activity' },
        hash: 'a b#c',
      }),
    ).toBe('/route-util/42?tab=activity#a%20b#c');
    expect(routeUrl('/route-util', { hash: '#details' })).toBe('/route-util#details');
    expect(routeUrl('/route-util', { hash: '#' })).toBe('/route-util');
    expect(routeUrl('/route-util', { hash: '' })).toBe('/route-util');
  });

  it('preserves hash-router syntax and existing percent escapes in fragments', () => {
    expect(routeUrl('/route-util', { hash: '/settings?tab=1' })).toBe(
      '/route-util#/settings?tab=1',
    );
    expect(routeUrl('/route-util', { hash: '#/settings?next=%2Fhome&tab=a%20b#details' })).toBe(
      '/route-util#/settings?next=%2Fhome&tab=a%20b#details',
    );
    expect(routeUrl('/route-util', { hash: 'heading%20text' })).toBe('/route-util#heading%20text');
  });

  it('encodes spaces, Unicode and characters excluded from URL fragments', () => {
    expect(routeUrl('/route-util', { hash: 'café "hello" <world>`' })).toBe(
      '/route-util#caf%C3%A9%20%22hello%22%20%3Cworld%3E%60',
    );
  });

  it('rejects missing, inherited, empty and invalid parameter values', () => {
    // @ts-expect-error callers in JavaScript can omit required options
    expect(() => routeUrl('/route-util/:id')).toThrow('Missing route param "id".');
    // @ts-expect-error callers in JavaScript can omit required params
    expect(() => routeUrl('/route-util/:id', { params: {} })).toThrow('Missing route param "id".');
    // @ts-expect-error inherited properties are not route params
    expect(() => routeUrl('/route-util/:toString', { params: {} })).toThrow(
      'Missing route param "toString".',
    );
    expect(() => routeUrl('/route-util/:id', { params: { id: '' } })).toThrow('must not be empty');
    expect(() => routeUrl('/route-util/files/:path{.+}', { params: { path: '' } })).toThrow(
      'must not be empty',
    );
    // @ts-expect-error invalid values still fail at runtime
    expect(() => routeUrl('/route-util/:id', { params: { id: null } })).toThrow(
      'must be a string or number',
    );
  });

  it('rejects parameter values that would change the request path or origin', () => {
    expect(() => routeUrl('/route-util/:id', { params: { id: '..' } })).toThrow(
      'it would change the request path',
    );
    expect(() =>
      routeUrl('/route-util/files/:path{.+}', { params: { path: 'a/../admin' } }),
    ).toThrow('it would change the request path');
    expect(() => routeUrl('/:leading{.+}', { params: { leading: '/evil.example/x' } })).toThrow(
      'changes the request host',
    );
  });
});
