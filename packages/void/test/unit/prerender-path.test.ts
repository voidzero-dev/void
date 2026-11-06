import { describe, expect, it } from 'vite-plus/test';
import { buildPrerenderPath } from '../../src/runtime/prerender-path.ts';

const FILE = 'pages/blog/[slug].server.ts';

describe('buildPrerenderPath', () => {
  it.each([
    ['/blog/:slug', { slug: 'hello' }, '/blog/hello'],
    // A param name that is a prefix of another fills only its own segment.
    ['/u/:idx/:id', { id: '1', idx: '2' }, '/u/2/1'],
    ['/blog/:slug', { slug: 'a b?c#d' }, '/blog/a%20b%3Fc%23d'],
    ['/blog/:slug', { slug: 'café' }, '/blog/caf%C3%A9'],
    ['/posts/:id', { id: 42 }, '/posts/42'],
    // Keys the pattern does not use are ignored.
    ['/blog/:slug', { slug: 'hello', title: 'Hello' }, '/blog/hello'],
    ['/docs/:slug{.+}', { slug: 'guides/a b' }, '/docs/guides/a%20b'],
    ['/files/*', { '*': 'a/b' }, '/files/a/b'],
  ])('builds %s from %j', (pattern, params, expected) => {
    expect(buildPrerenderPath(pattern, params, FILE, 0)).toBe(expected);
  });

  it.each([
    ['/blog/:slug', { slg: 'hello' }, 'Missing route param "slug".'],
    ['/blog/:slug', { slug: '' }, 'Route param "slug" must not be empty.'],
    ['/blog/:slug', { slug: '..' }, 'Route param "slug" cannot be "..";'],
    ['/docs/:slug{.+}', { slug: 'a/../b' }, 'Route param "slug" cannot be "..";'],
    [
      '/blog/:slug',
      { slug: 'x/y' },
      'Route param "slug" cannot contain "/". Use a catch-all page ([...slug]) for nested paths.',
    ],
    ['/blog/:slug', { slug: true }, 'Route param "slug" must be a string or number.'],
    ['/docs/:slug{.+}', { slug: ['a', 'b'] }, 'Route param "slug" must be a string or number.'],
    ['/blog/:slug', 'hello', 'Expected an object of route params, got a string.'],
    ['/blog/:slug', null, 'Expected an object of route params, got null.'],
    ['/blog/:slug', ['hello'], 'Expected an object of route params, got an array.'],
  ])('rejects %s with %j', (pattern, params, message) => {
    expect(() => buildPrerenderPath(pattern, params, FILE, 2)).toThrow(
      `${FILE} getPrerenderPaths()[2]: ${message}`,
    );
  });
});
