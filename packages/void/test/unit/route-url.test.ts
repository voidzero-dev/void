import { describe, expect, it } from 'vite-plus/test';
import { interpolateRouteParams } from '../../src/runtime/route-url.ts';

describe('route URL interpolation', () => {
  it.each([
    ['/users/[id]', '/users/:id', { id: 'a/b ?#%' }, '/users/a%2Fb%20%3F%23%25'],
    [
      '/docs/[...slug]',
      '/docs/:slug{.+}',
      { slug: 'guides/get started' },
      '/docs/guides/get%20started',
    ],
    ['/docs/[...]', '/docs/*', { '*': 'a/b ?#%' }, '/docs/a/b%20%3F%23%25'],
    ['/[id2]/[id]/[id]', '/:id2/:id/:id', { id: 'one', id2: 'two' }, '/two/one/one'],
    ['/docs/[...]', '/docs/*', { '*': '' }, '/docs/'],
  ] as const)(
    'resolves public %s and legacy %s patterns identically',
    (path, legacy, params, url) => {
      expect(interpolateRouteParams(path, params)).toBe(url);
      expect(interpolateRouteParams(legacy, params)).toBe(url);
    },
  );

  it('preserves literal brackets, missing params, queries and named action suffixes', () => {
    expect(interpolateRouteParams('/x[id]/[id]/[missing]?save#/[id]', { id: 'one' })).toBe(
      '/x[id]/one/[missing]?save#/[id]',
    );
    expect(interpolateRouteParams('/[id]', undefined)).toBe('/[id]');
    expect(interpolateRouteParams('/[toString]', {})).toBe('/[toString]');
    expect(interpolateRouteParams('/docs/[...]', {})).toBe('/docs/[...]');
    expect(() => interpolateRouteParams('/[id]', {}, true)).toThrow('Missing route param "id".');
    expect(() => interpolateRouteParams('/docs/[...slug]', { slug: '' }, true)).toThrow(
      'must not be empty',
    );
  });

  it('expands catch-all segments and encodes each path component', () => {
    expect(interpolateRouteParams('/files/:path{.+}', { path: 'docs/start ?#%.md' })).toBe(
      '/files/docs/start%20%3F%23%25.md',
    );
  });

  it('matches whole parameter names in route order', () => {
    expect(interpolateRouteParams('/:id2/:id/:id', { id: 'a/b', id2: 'two' })).toBe(
      '/two/a%2Fb/a%2Fb',
    );
  });

  it('preserves missing parameters, literal text, queries and fragments', () => {
    expect(interpolateRouteParams('/x:id/:id/:missing?next=/:id#/:id', { id: 'one' })).toBe(
      '/x:id/one/:missing?next=/:id#/:id',
    );
    expect(interpolateRouteParams('/:id', undefined)).toBe('/:id');
    expect(interpolateRouteParams('/:toString', {})).toBe('/:toString');
  });

  it.each([
    ['/api/posts/:id', { id: '..' }],
    ['/api/posts/:id', { id: '.' }],
    ['/files/:path{.+}', { path: 'a/../../admin' }],
    ['/files/:path{.+}', { path: './x' }],
    ['/api/posts/[id]', { id: '..' }],
    ['/files/[...path]', { path: 'a/../../admin' }],
    ['/files/[...]', { '*': './x' }],
  ])('rejects dot segments that would change the path of %s (%j)', (path, params) => {
    expect(() => interpolateRouteParams(path, params)).toThrow(TypeError);
    expect(() => interpolateRouteParams(path, params)).toThrow(/it would change the request path/);
  });

  it('rejects a leading param that would make the path start with //', () => {
    expect(() => interpolateRouteParams('/[...path]', { path: '/evil.com/x' })).toThrow(
      'changes the request host',
    );
    expect(() => interpolateRouteParams('/:path{.+}', { path: '/evil.com/x' })).toThrow(
      new TypeError(
        'Route param "path" would make the request path start with "//", which changes the request host.',
      ),
    );
  });

  it('keeps values that only contain dots or encoded dots', () => {
    expect(interpolateRouteParams('/api/posts/:id', { id: '...' })).toBe('/api/posts/...');
    expect(interpolateRouteParams('/api/posts/:id', { id: '.hidden' })).toBe('/api/posts/.hidden');
    expect(interpolateRouteParams('/api/posts/:id', { id: 'a..b' })).toBe('/api/posts/a..b');
    expect(interpolateRouteParams('/api/posts/:id', { id: '%2e%2e' })).toBe(
      '/api/posts/%252e%252e',
    );
    expect(interpolateRouteParams('/api/posts/:id', { id: '../admin' })).toBe(
      '/api/posts/..%2Fadmin',
    );
    expect(interpolateRouteParams('/files/:path{.+}', { path: 'a//b' })).toBe('/files/a//b');
  });
});
