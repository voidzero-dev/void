import { describe, it } from 'vite-plus/test';
import { fetch as typedFetch } from '../../src/runtime/fetch.ts';

declare module 'void/routes' {
  interface RouteMap {
    '/api/rebuild': {
      POST: { input: {}; output: { started: boolean } };
    };
  }
}

describe('typed fetch client', () => {
  it('type: requires an explicit method whenever the request cannot default to GET', () => {
    const _check = async () => {
      const result = await typedFetch('/api/rebuild', { method: 'POST' });
      const started: boolean = result.started;
      void started;
      await typedFetch('/api/hello', {});

      // @ts-expect-error - a POST-only route cannot be called with the default GET
      await typedFetch('/api/rebuild');
      // @ts-expect-error - an options object does not supply a runtime method
      await typedFetch('/api/rebuild', {});
      // @ts-expect-error - generic type arguments do not set the runtime method
      await typedFetch<'/api/rebuild', 'POST'>('/api/rebuild', {});
      // @ts-expect-error - selecting POST requires a method even when GET also exists
      await typedFetch<'/api/users', 'POST'>('/api/users', { body: { name: 'Alice' } });
    };
    void _check;
  });

  it('type: output is correctly narrowed per route', () => {
    const _check = async () => {
      const hello = await typedFetch('/api/hello');
      // @ts-expect-error - 'missing' does not exist on { ok: boolean }
      void hello.missing;
      // @ts-expect-error - ok is boolean, toUpperCase exists only on string
      void hello.ok.toUpperCase();

      const users = await typedFetch('/api/users');
      // array methods are available
      void users.map;
      // @ts-expect-error - toFixed does not exist on array
      void users.toFixed();

      const user = await typedFetch('/api/users/:id', { params: { id: '1' } });
      // @ts-expect-error - 'email' does not exist on { id: string; name: string }
      void user.email;
    };
    void _check;
  });

  it('type: rejects invalid paths and methods', () => {
    // @ts-expect-error - "/api/nonexistent" is not in RouteMap
    void typedFetch('/api/nonexistent').catch(() => {});

    // @ts-expect-error - DELETE is not a valid method for /api/hello (only GET)
    void typedFetch('/api/hello', { method: 'DELETE' }).catch(() => {});

    // @ts-expect-error - PATCH is not a valid method for /api/users (only GET, POST)
    void typedFetch('/api/users', { method: 'PATCH' }).catch(() => {});
  });

  it('type: enforces input types for body and params', () => {
    const _check = async () => {
      // POST with correct body — compiles
      await typedFetch('/api/users', { method: 'POST', body: { name: 'Alice' } });

      // GET with correct params — compiles
      await typedFetch('/api/users/:id', { params: { id: '42' } });

      // DELETE with no required input — compiles
      await typedFetch('/api/items/:id', { method: 'DELETE' });

      // Extra options alongside typed input — compiles
      await typedFetch('/api/users', {
        method: 'POST',
        body: { name: 'Bob' },
        headers: { 'X-Test': '1' },
      });

      // @ts-expect-error - wrong body type (name should be string)
      await typedFetch('/api/users', { method: 'POST', body: { name: 123 } });

      // @ts-expect-error - missing body entirely on POST
      await typedFetch('/api/users', { method: 'POST' });

      // @ts-expect-error - missing required params (options required)
      await typedFetch('/api/users/:id');

      // @ts-expect-error - wrong params type (id should be string)
      await typedFetch('/api/users/:id', { params: { id: 123 } });
    };
    void _check;
  });
});
