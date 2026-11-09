import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { describe, expect, it, vi } from 'vite-plus/test';
import { objectToFormData } from '../../src/pages/navigation-engine.ts';
import {
  defineHandler,
  defineMiddleware,
  type CloudContext,
  type TypedHandler,
} from '../../src/runtime/handler.ts';
import { convertReturnValue } from '../../src/runtime/response.ts';
import { createHttpRouteHandler } from '../../src/runtime/routing.ts';
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

  it('keeps route middleware header edits made after next()', async () => {
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

  it('preserves repeated query params as arrays', async () => {
    const handler = defineHandler.withValidator({
      query: passSchema(),
    })((_c, { query }) => {
      return { query };
    });

    const app = createValidatedApp('get', '/test', handler);

    const res = await app.request(new Request('http://localhost/test?page=2&tag=work&tag=urgent'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      query: {
        page: '2',
        tag: ['work', 'urgent'],
      },
    });
  });

  it.each([
    ['__proto__=work', 'work'],
    ['__proto__=work&__proto__=urgent', ['work', 'urgent']],
  ])('preserves %s as an own query property', async (search, expected) => {
    const handler = defineHandler.withValidator({ query: passSchema() })((_c, { query }) => ({
      query,
    }));
    const app = createValidatedApp('get', '/test', handler);
    const res = await app.request(new Request(`http://localhost/test?${search}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ query: { ['__proto__']: expected } });
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

  it('passes a multipart file to the schema and the handler', async () => {
    const photo = new File(['hello'], 'photo.png', { type: 'image/png' });
    let seenBySchema: unknown;
    const handler = defineHandler.withValidator({
      body: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate(value: unknown) {
            seenBySchema = value;
            const uploaded = (value as { photo?: unknown }).photo;
            if (!(uploaded instanceof File)) {
              return { issues: [{ message: 'expected a file', path: ['photo'] }] };
            }
            return { value };
          },
        },
      },
    })((_c, { body }) => {
      const received = body as { title: string; photo: File };
      return {
        title: received.title,
        name: received.photo.name,
        type: received.photo.type,
        size: received.photo.size,
      };
    });

    const app = createValidatedApp('post', '/test', handler);
    const res = await app.request(
      new Request('http://localhost/test', {
        method: 'POST',
        body: objectToFormData({ title: 'Sunset', photo }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      title: 'Sunset',
      name: 'photo.png',
      type: 'image/png',
      size: photo.size,
    });
    const parsed = seenBySchema as { title: string; photo: File };
    expect(parsed.title).toBe('Sunset');
    expect(parsed.photo).toBeInstanceOf(File);
    expect(parsed.photo.name).toBe('photo.png');
    expect(await parsed.photo.text()).toBe('hello');
  });

  it('restores nested bracket keys from form bodies', async () => {
    const handler = defineHandler.withValidator({
      body: passSchema(),
    })((_c, { body }) => ({ received: body }));
    const app = createValidatedApp('post', '/test', handler);
    const takenAt = new Date('2020-01-02T03:04:05.000Z');
    const multipart = objectToFormData({
      profile: { name: 'Ada' },
      tags: ['work', 'urgent'],
      album: { photos: [{ name: 'a.png' }] },
      published: true,
      count: 2,
      takenAt,
      note: null,
    });
    multipart.append('photos[]', 'one');
    multipart.append('photos[]', 'two');
    multipart.append('__proto__[polluted]', 'yes');

    const multipartRes = await app.request(
      new Request('http://localhost/test', { method: 'POST', body: multipart }),
    );
    expect(multipartRes.status).toBe(200);
    expect(await multipartRes.json()).toEqual({
      received: {
        profile: { name: 'Ada' },
        tags: ['work', 'urgent'],
        album: { photos: [{ name: 'a.png' }] },
        published: '1',
        count: '2',
        takenAt: '2020-01-02T03:04:05.000Z',
        note: '',
        photos: ['one', 'two'],
        ['__proto__']: { polluted: 'yes' },
      },
    });
    expect('polluted' in Object.prototype).toBe(false);

    const params = new URLSearchParams();
    params.append('profile[name]', 'Ada');
    params.append('tags[0]', 'work');
    params.append('tags[1]', 'urgent');
    params.append('photos[]', 'one');
    params.append('photos[]', 'two');
    const urlencodedRes = await app.request(
      new Request('http://localhost/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      }),
    );
    expect(urlencodedRes.status).toBe(200);
    expect(await urlencodedRes.json()).toEqual({
      received: {
        profile: { name: 'Ada' },
        tags: ['work', 'urgent'],
        photos: ['one', 'two'],
      },
    });
  });

  it.each([
    ['multipart', 'indexed'],
    ['urlencoded', 'indexed'],
    ['multipart', 'appended'],
    ['urlencoded', 'appended'],
  ] as const)(
    'rejects excessive aggregate array growth in %s bodies (%s)',
    async (encoding, kind) => {
      const validate = vi.fn((value: unknown) => ({ value }));
      const handler = defineHandler.withValidator({
        body: { '~standard': { version: 1, vendor: 'test', validate } },
      })(() => ({ ok: true }));
      const app = createValidatedApp('post', '/test', handler);
      const form = new FormData();
      if (kind === 'indexed') {
        // Few containers, but each inner array allocates 1,001 slots.
        for (let i = 0; i < 20; i++) {
          form.append(`items[${i}][1000]`, 'value');
        }
      } else {
        // Append syntax must share the same allocation budget across arrays.
        for (let i = 0; i < 6_000; i++) {
          form.append('first[]', 'value');
          form.append('second[]', 'value');
        }
      }
      const body =
        encoding === 'multipart'
          ? form
          : new URLSearchParams(Array.from(form, ([key, value]) => [key, String(value)]));
      const response = await app.request(
        new Request('http://localhost/test', { method: 'POST', body }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid form body' });
      expect(validate).not.toHaveBeenCalled();
    },
  );

  it('allows filling already allocated array slots in any order', async () => {
    const handler = defineHandler.withValidator({ body: passSchema() })((_c, { body }) => {
      const { items } = body as { items: Array<string> };
      return { length: items.length, first: items[0], filled: items[1000], last: items[8999] };
    });
    const app = createValidatedApp('post', '/test', handler);
    const form = new FormData();
    form.append('items[8999]', 'last');
    for (let i = 0; i <= 1000; i++) {
      form.append(`items[${i}]`, 'filled');
    }
    const response = await app.request(
      new Request('http://localhost/test', { method: 'POST', body: form }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      length: 9000,
      first: 'filled',
      filled: 'filled',
      last: 'last',
    });
  });

  it('keeps JSON body validation unchanged', async () => {
    const handler = defineHandler.withValidator({
      body: passSchema(),
    })((_c, { body }) => ({ received: body }));
    const app = createValidatedApp('post', '/test', handler);

    const res = await app.request(
      new Request('http://localhost/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: { name: 'Ada' },
          tags: ['work'],
          published: true,
          count: 2,
          note: null,
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      received: {
        profile: { name: 'Ada' },
        tags: ['work'],
        published: true,
        count: 2,
        note: null,
      },
    });
  });

  it('does not report a bad form body as invalid JSON', async () => {
    const handler = defineHandler.withValidator({
      body: failSchema('title is required'),
    })(() => ({ ok: true }));
    const app = createValidatedApp('post', '/test', handler);

    const malformed = await app.request(
      new Request('http://localhost/test', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=----bad' },
        body: 'not a multipart body',
      }),
    );
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as { error: string }).error).toBe('Invalid form body');

    const invalid = await app.request(
      new Request('http://localhost/test', {
        method: 'POST',
        body: objectToFormData({ title: '' }),
      }),
    );
    expect(invalid.status).toBe(400);
    const json = (await invalid.json()) as ValidationIssueBody;
    expect(json.error).toBe('Validation failed');
    expect(json.issues[0]?.slot).toBe('body');
    expect(json.issues[0]?.issues[0]?.message).toBe('title is required');
  });
});
