import { Hono } from 'hono';
import { describe, expect, it } from 'vite-plus/test';
import {
  isRouteEnabledForEnvironment,
  parseRouteFilename,
  parseWebSocketFilename,
} from '../../src/router/parse-filename.ts';

describe('parseRouteFilename', () => {
  describe('static routes', () => {
    it('simple file', () => {
      const r = parseRouteFilename('api/hello.ts');
      expect(r.pattern).toBe('/api/hello');
      expect(r.methods).toEqual([]);
      expect(r.params).toEqual([]);
      expect(r.catchAll).toBe(false);
      expect(r.env).toBeNull();
    });

    it('nested file', () => {
      const r = parseRouteFilename('api/users/profile.ts');
      expect(r.pattern).toBe('/api/users/profile');
    });

    it('index file becomes directory', () => {
      const r = parseRouteFilename('api/users/index.ts');
      expect(r.pattern).toBe('/api/users');
    });

    it('root index', () => {
      const r = parseRouteFilename('index.ts');
      expect(r.pattern).toBe('/');
    });
  });

  describe('file extensions', () => {
    it('.ts', () => {
      expect(parseRouteFilename('hello.ts').pattern).toBe('/hello');
    });

    it.each([
      ['hello.tsx', '/hello', null, []],
      ['index.tsx', '/', null, []],
      ['(api)/users/[id].dev.tsx', '/users/:id', 'dev', ['id']],
      ['files/[...path].prod.tsx', '/files/:path{.+}', 'prod', ['path']],
      ['hello.jsx', '/hello', null, []],
      ['index.jsx', '/', null, []],
      ['(api)/users/[id].dev.jsx', '/users/:id', 'dev', ['id']],
      ['files/[...path].prod.jsx', '/files/:path{.+}', 'prod', ['path']],
    ])('parses %s', (filePath, pattern, env, params) => {
      expect(parseRouteFilename(filePath)).toMatchObject({ filePath, pattern, env, params });
    });

    it('.js', () => {
      expect(parseRouteFilename('hello.js').pattern).toBe('/hello');
    });

    it('.mts', () => {
      expect(parseRouteFilename('hello.mts').pattern).toBe('/hello');
    });

    it('.mjs', () => {
      expect(parseRouteFilename('hello.mjs').pattern).toBe('/hello');
    });
  });

  describe('environment suffixes', () => {
    it.each(['tsx', 'jsx'])('parses JSX WebSocket routes in .%s', (ext) => {
      expect(parseWebSocketFilename(`(app)/chat/[room].dev.ws.${ext}`)).toMatchObject({
        pattern: '/chat/:room',
        params: ['room'],
        env: 'dev',
      });
      expect(parseWebSocketFilename(`chat/index.prod.ws.${ext}`)).toMatchObject({
        pattern: '/chat',
        env: 'prod',
      });
    });

    it('.dev suffix', () => {
      const r = parseRouteFilename('debug.dev.ts');
      expect(r.pattern).toBe('/debug');
      expect(r.env).toBe('dev');
    });

    it('.prod suffix', () => {
      const r = parseRouteFilename('health.prod.ts');
      expect(r.pattern).toBe('/health');
      expect(r.env).toBe('prod');
    });

    it('sits before the .ws segment on a websocket route', () => {
      const r = parseWebSocketFilename('chat.dev.ws.ts');
      expect(r.pattern).toBe('/chat');
      expect(r.env).toBe('dev');
    });

    it('is not recognised after the .ws segment', () => {
      const r = parseWebSocketFilename('chat.ws.ts');
      expect(r.pattern).toBe('/chat');
      expect(r.env).toBeNull();
    });
  });

  describe('dynamic params', () => {
    it('single param', () => {
      const r = parseRouteFilename('users/[id].ts');
      expect(r.pattern).toBe('/users/:id');
      expect(r.params).toEqual(['id']);
      expect(r.catchAll).toBe(false);
    });

    it('multiple params in nested dirs', () => {
      const r = parseRouteFilename('api/[org]/[repo]/index.ts');
      expect(r.pattern).toBe('/api/:org/:repo');
      expect(r.params).toEqual(['org', 'repo']);
    });

    it('param as directory with static child', () => {
      const r = parseRouteFilename('api/[org]/[repo]/issues.ts');
      expect(r.pattern).toBe('/api/:org/:repo/issues');
      expect(r.params).toEqual(['org', 'repo']);
    });
  });

  describe('catch-all', () => {
    it('named catch-all', () => {
      const r = parseRouteFilename('hello/[...name].ts');
      expect(r.pattern).toBe('/hello/:name{.+}');
      expect(r.params).toEqual(['name']);
      expect(r.catchAll).toBe(true);
    });

    it('unnamed catch-all (404)', () => {
      const r = parseRouteFilename('[...].ts');
      expect(r.pattern).toBe('/*');
      expect(r.params).toEqual([]);
      expect(r.catchAll).toBe(true);
    });
  });

  describe('catch-all patterns work with Hono', () => {
    it('unnamed catch-all matches any path', async () => {
      const { pattern } = parseRouteFilename('[...].ts');
      const app = new Hono();
      app.get(pattern, (c) => c.text('ok'));

      const res = await app.request('/any/deep/path');
      expect(res.status).toBe(200);
    });

    it('named catch-all captures path param', async () => {
      const { pattern } = parseRouteFilename('files/[...path].ts');
      const app = new Hono();
      app.get(pattern, (c) => c.text(c.req.param('path')!));

      const res = await app.request('/files/a/b/c');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('a/b/c');
    });
  });

  describe('route groups', () => {
    it('single group', () => {
      const r = parseRouteFilename('api/(admin)/users.ts');
      expect(r.pattern).toBe('/api/users');
    });

    it('nested group', () => {
      const r = parseRouteFilename('api/(admin)/(v2)/reports.ts');
      expect(r.pattern).toBe('/api/reports');
    });

    it('group with dynamic param', () => {
      const r = parseRouteFilename('api/(public)/[id].ts');
      expect(r.pattern).toBe('/api/:id');
      expect(r.params).toEqual(['id']);
    });
  });

  describe('complex combinations', () => {
    it('nested dynamic with env', () => {
      const r = parseRouteFilename('api/users/[id].dev.ts');
      expect(r.pattern).toBe('/api/users/:id');
      expect(r.env).toBe('dev');
      expect(r.params).toEqual(['id']);
    });

    it('preserves filePath', () => {
      const r = parseRouteFilename('api/hello.ts');
      expect(r.filePath).toBe('api/hello.ts');
    });
  });
});

describe('isRouteEnabledForEnvironment', () => {
  const cases: Array<{
    env: 'dev' | 'prod' | null;
    environment: 'dev' | 'prod' | undefined;
    expected: boolean;
  }> = [
    { env: null, environment: 'dev', expected: true },
    { env: null, environment: 'prod', expected: true },
    { env: null, environment: undefined, expected: true },
    { env: 'dev', environment: 'dev', expected: true },
    { env: 'dev', environment: 'prod', expected: false },
    { env: 'dev', environment: undefined, expected: true },
    { env: 'prod', environment: 'dev', expected: false },
    { env: 'prod', environment: 'prod', expected: true },
    { env: 'prod', environment: undefined, expected: true },
  ];

  for (const { env, environment, expected } of cases) {
    it(`env=${env} environment=${environment} -> ${expected}`, () => {
      expect(isRouteEnabledForEnvironment({ env }, environment)).toBe(expected);
    });
  }
});
