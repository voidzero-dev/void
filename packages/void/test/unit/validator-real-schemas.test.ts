import { type } from 'arktype';
import { Hono } from 'hono';
import * as v from 'valibot';
import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';
import { defineHandler, type CloudContext } from '../../src/runtime/handler.ts';
import { convertReturnValue } from '../../src/runtime/response.ts';
import type { StandardSchemaV1 } from '../../src/standard-schema.ts';

type ValidationIssueBody = {
  error: string;
  issues: Array<{
    slot: string;
    issues: Array<{ message: string; path?: string }>;
  }>;
};

function postJson(body: unknown) {
  return new Request('http://localhost/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function createPostApp(handler: (c: CloudContext) => unknown) {
  const app = new Hono();
  app.post('/test', async (c) => {
    return convertReturnValue(await handler(c as unknown as CloudContext));
  });
  return app;
}

const libraries: Array<{ library: string; CreateUser: StandardSchemaV1 }> = [
  {
    library: 'zod',
    CreateUser: z.object({ name: z.string().min(1), email: z.string().email() }),
  },
  {
    library: 'valibot',
    CreateUser: v.object({
      name: v.pipe(v.string(), v.minLength(1)),
      email: v.pipe(v.string(), v.email()),
    }),
  },
  {
    library: 'arktype',
    CreateUser: type({ name: 'string >= 1', email: 'string.email' }),
  },
];

describe.each(libraries)('withValidator + $library', ({ CreateUser }) => {
  const app = createPostApp(
    defineHandler.withValidator({ body: CreateUser })((_c, { body }) => body),
  );

  it('accepts valid body', async () => {
    const res = await app.request(postJson({ name: 'Alice', email: 'alice@example.com' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'Alice', email: 'alice@example.com' });
  });

  it('rejects invalid body with 400', async () => {
    const res = await app.request(postJson({ name: '', email: 'not-an-email' }));

    expect(res.status).toBe(400);
    const json = (await res.json()) as ValidationIssueBody;
    expect(json.error).toBe('Validation failed');
    expect(json.issues[0].slot).toBe('body');
    expect(json.issues[0].issues.length).toBeGreaterThanOrEqual(1);
  });
});

it('does not validate inherited array length as a query parameter', async () => {
  const app = createPostApp(
    defineHandler.withValidator({ query: z.object({ length: z.number() }) })(
      (_c, { query }) => query,
    ),
  );
  const res = await app.request(
    new Request('http://localhost/test?__proto__=work&__proto__=urgent', { method: 'POST' }),
  );

  expect(res.status).toBe(400);
  const json = (await res.json()) as ValidationIssueBody;
  expect(json.error).toBe('Validation failed');
  expect(json.issues[0].slot).toBe('query');
  expect(json.issues[0].issues[0].path).toBe('length');
});
