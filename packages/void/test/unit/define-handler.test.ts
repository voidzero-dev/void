import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { describe, expect, it } from 'vite-plus/test';
import {
  defineHandler,
  defineMiddleware,
  type CloudContext,
  type TypedHandler,
} from '../../src/runtime/handler.ts';
import { createHttpRouteHandler } from '../../src/runtime/routing.ts';
import { convertReturnValue } from '../../src/runtime/response.ts';
import { etag } from 'hono/etag';
import type { StandardSchemaV1 } from '../../src/standard-schema.ts';

type ValidationIssueBody = {
  error: string;
  issues: Array<{
    slot: string;
    issues: Array<{ message: string }>;
  }>;
};

/** Wraps the handler the way createHttpRouteHandler in runtime/routing.ts does. */
function createApp(handler: (c: CloudContext) => unknown) {
  const app = new Hono();
  app.get('/test', async (c) => {
    return convertReturnValue(await handler(c as unknown as CloudContext));
  });
  return app;
}

function req(init?: RequestInit) {
  return new Request('http://localhost/test', init);
}

/** Create a mock Standard Schema that passes through the input. */
function passSchema(): StandardSchemaV1 {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        return { value };
      },
    },
  };
}

/** Create a mock Standard Schema that always fails. */
function failSchema(message: string): StandardSchemaV1 {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate() {
        return { issues: [{ message }] };
      },
    },
  };
}

describe('defineHandler', () => {
  it('single handler (backwards compat)', async () => {
    const handler = defineHandler((_c) => {
      return { ok: true };
    });
    const app = createApp(handler);
    const res = await app.request(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('middleware + handler execution order', async () => {
    const order: Array<string> = [];

    const m1 = defineMiddleware(async (c, next) => {
      order.push('m1-before');
      await next();
      order.push('m1-after');
    });

    const m2 = defineMiddleware(async (c, next) => {
      order.push('m2-before');
      await next();
      order.push('m2-after');
    });

    const handler = defineHandler(m1, m2, (_c) => {
      order.push('handler');
      return { data: 'ok' };
    });

    const app = createApp(handler);
    const res = await app.request(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: 'ok' });
    expect(order).toEqual(['m1-before', 'm2-before', 'handler', 'm2-after', 'm1-after']);
  });

  it('middleware short-circuit (no next())', async () => {
    const m1 = defineMiddleware(async (c, _next) => {
      return c.json({ error: 'unauthorized' }, 401);
    });

    const handler = defineHandler(m1, () => {
      throw new Error('should not be called');
    });

    const app = createApp(handler);
    const res = await app.request(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('post-processing middleware adds headers', async () => {
    const addHeader = defineMiddleware(async (c, next) => {
      await next();
      c.res.headers.set('X-Custom', 'added');
    });

    const handler = defineHandler(addHeader, () => {
      return { data: 'hello' };
    });

    const app = createApp(handler);
    const res = await app.request(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Custom')).toBe('added');
    expect(await res.json()).toEqual({ data: 'hello' });
  });

  it('raw Hono middleware (not wrapped with defineMiddleware)', async () => {
    const order: Array<string> = [];

    const rawMiddleware: MiddlewareHandler = async (c, next) => {
      order.push('raw-before');
      c.res.headers.set('X-Raw', 'yes');
      await next();
      order.push('raw-after');
    };

    const handler = defineHandler(rawMiddleware, (_c) => {
      order.push('handler');
      return { ok: true };
    });

    const app = createApp(handler);
    const res = await app.request(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('X-Raw')).toBe('yes');
    expect(order).toEqual(['raw-before', 'handler', 'raw-after']);
  });

  it('createHttpRouteHandler runs composed handlers with post-next header mutation', async () => {
    const addHeader = defineMiddleware(async (c, next) => {
      await next();
      c.res.headers.set('X-Route-Mw', 'yes');
    });

    const handler = defineHandler(addHeader, () => ({ ok: true }));
    const app = new Hono();
    app.get(
      '/test',
      createHttpRouteHandler(async () => ({ GET: handler }), 'GET'),
    );

    const res = await app.request(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Route-Mw')).toBe('yes');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('createHttpRouteHandler etag hashes the final response body', async () => {
    const addHeader = defineMiddleware(async (c, next) => {
      await next();
      c.res.headers.set('X-Seen', '1');
    });

    const handler = defineHandler(etag(), addHeader, () => ({ value: 'stable' }));
    const app = new Hono();
    app.get(
      '/test',
      createHttpRouteHandler(async () => ({ GET: handler }), 'GET'),
    );

    const first = await app.request(req());
    const etagValue = first.headers.get('etag');
    expect(etagValue).toBeTruthy();
    expect(first.headers.get('X-Seen')).toBe('1');
    const firstBody = await first.text();

    const second = await app.request(
      new Request('http://localhost/test', {
        headers: { 'if-none-match': etagValue! },
      }),
    );
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
    expect(firstBody).toContain('stable');
  });

  it('middleware error propagates', async () => {
    const failing = defineMiddleware(async () => {
      throw new Error('middleware boom');
    });

    const handler = defineHandler(failing, () => {
      return { ok: true };
    });

    const app = createApp(handler);
    // Hono catches thrown errors and returns a 500 response
    const res = await app.request(req());
    expect(res.status).toBe(500);
  });
});

describe('defineHandler.withValidator', () => {
  function createValidatedApp(method: 'get' | 'post', path: string, handler: TypedHandler) {
    const app = new Hono();
    app[method](path, async (c) => {
      return convertReturnValue(await handler(c as unknown as CloudContext));
    });
    return app;
  }

  it('validates body and passes input to handler', async () => {
    const handler = defineHandler.withValidator({
      body: passSchema(),
    })((_c, { body }) => {
      return { received: body };
    });

    const app = createValidatedApp('post', '/test', handler);

    const res = await app.request(
      new Request('http://localhost/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Alice' }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: { name: 'Alice' } });
  });

  it('returns 400 when body validation fails', async () => {
    const handler = defineHandler.withValidator({
      body: failSchema('name is required'),
    })((_c, { body }) => {
      return { received: body };
    });

    const app = createValidatedApp('post', '/test', handler);

    const res = await app.request(
      new Request('http://localhost/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as ValidationIssueBody;
    expect(json.error).toBe('Validation failed');
    expect(json.issues[0].slot).toBe('body');
    expect(json.issues[0].issues[0].message).toBe('name is required');
  });

  it('returns 400 on invalid JSON body', async () => {
    const handler = defineHandler.withValidator({
      body: passSchema(),
    })((_c, { body }) => {
      return { received: body };
    });

    const app = createValidatedApp('post', '/test', handler);

    const res = await app.request(
      new Request('http://localhost/test', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'not json',
      }),
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('Invalid JSON body');
  });

  it('validates query params', async () => {
    const handler = defineHandler.withValidator({
      query: passSchema(),
    })((_c, { query }) => {
      return { query };
    });

    const app = createValidatedApp('get', '/test', handler);

    const res = await app.request(new Request('http://localhost/test?page=2&limit=10'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ query: { page: '2', limit: '10' } });
  });

  it('validates route params', async () => {
    const handler = defineHandler.withValidator({
      params: passSchema(),
    })((_c, { params }) => {
      return { params };
    });

    const app = createValidatedApp('get', '/users/:id', handler);

    const res = await app.request(new Request('http://localhost/users/42'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ params: { id: '42' } });
  });

  it('validates multiple slots simultaneously', async () => {
    const handler = defineHandler.withValidator({
      params: passSchema(),
      body: passSchema(),
    })((_c, { params, body }) => {
      return { params, body };
    });

    const app = createValidatedApp('post', '/users/:id', handler);

    const res = await app.request(
      new Request('http://localhost/users/42', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Bob' }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      params: { id: '42' },
      body: { name: 'Bob' },
    });
  });
});
