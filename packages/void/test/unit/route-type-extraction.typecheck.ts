import { type as arktype } from 'arktype';
import * as v from 'valibot';
import { describe, expectTypeOf, it } from 'vite-plus/test';
import { z } from 'zod';
import { defineHandler } from '../../src/runtime/handler.ts';
import type { StandardSchemaV1 } from '../../src/standard-schema.ts';

/**
 * Copies of the helpers generateRouteTypes() emits into .void/routes.d.ts, applied to
 * `typeof handler` in place of `typeof import("../routes/...")["METHOD"]`.
 */
type Serialize<T> = T extends Response
  ? never
  : T extends Date
    ? string
    : T extends bigint
      ? never
      : T extends Function
        ? never
        : T extends undefined
          ? never
          : T extends Array<infer U>
            ? Array<Serialize<U>>
            : T extends object
              ? { [K in keyof T as T[K] extends Function ? never : K]: Serialize<T[K]> }
              : T;

type ExtractInput<V> = {
  [K in keyof V as V[K] extends StandardSchemaV1 ? K : never]: V[K] extends StandardSchemaV1
    ? StandardSchemaV1.InferInput<V[K]>
    : never;
};

// ─── Output extraction ──────────────────────────────────────────────────────

describe('Serialize<Awaited<handler.__output>>', () => {
  it('extracts plain object return type', () => {
    const handler = defineHandler((_c) => {
      return { name: 'Alice' as string, age: 30 as number };
    });
    type Output = Serialize<Awaited<(typeof handler)['__output']>>;

    expectTypeOf<Output>().toEqualTypeOf<{ name: string; age: number }>();

    // @ts-expect-error - 'email' is not in the output type
    void ({} as Output).email;
  });

  it('works with withValidator return types', () => {
    const handler = defineHandler.withValidator({
      body: z.object({ name: z.string() }),
    })((_c, { body }) => {
      return { greeting: `Hello ${body.name}` as string };
    });
    type Output = Serialize<Awaited<(typeof handler)['__output']>>;

    expectTypeOf<Output>().toEqualTypeOf<{ greeting: string }>();
  });
});

// ─── Input extraction ───────────────────────────────────────────────────────

describe('ExtractInput<handler.__validators>', () => {
  it('is empty for plain defineHandler', () => {
    const handler = defineHandler((_c) => ({ ok: true }));
    type Input = ExtractInput<(typeof handler)['__validators']>;

    expectTypeOf<Input>().toEqualTypeOf<{}>();
  });

  it('extracts body from zod schema', () => {
    const handler = defineHandler.withValidator({
      body: z.object({ name: z.string(), count: z.number() }),
    })((_c, { body }) => ({ received: body.name }));

    type Input = ExtractInput<(typeof handler)['__validators']>;
    expectTypeOf<Input>().toEqualTypeOf<{ body: { name: string; count: number } }>();
  });

  it('extracts params + body from valibot schemas', () => {
    const handler = defineHandler.withValidator({
      params: v.object({ id: v.string() }),
      body: v.object({ title: v.string() }),
    })((_c, { params, body }) => ({
      id: params.id,
      title: body.title,
    }));

    type Input = ExtractInput<(typeof handler)['__validators']>;
    expectTypeOf<Input>().toEqualTypeOf<{
      params: { id: string };
      body: { title: string };
    }>();
  });

  it('extracts query from arktype schema', () => {
    const handler = defineHandler.withValidator({
      query: arktype({ page: 'string', limit: 'string' }),
    })((_c, { query }) => ({
      page: query.page,
      limit: query.limit,
    }));

    type Input = ExtractInput<(typeof handler)['__validators']>;
    expectTypeOf<Input>().toEqualTypeOf<{
      query: { page: string; limit: string };
    }>();
  });

  it('preserves validators when middleware wraps withValidator handler', () => {
    const middleware = async (_c: unknown, next: () => Promise<void>) => {
      await next();
    };
    const handler = defineHandler(
      middleware as never,
      defineHandler.withValidator({
        body: z.object({ title: z.string() }),
      })((_c, { body }) => {
        void body;
      }),
    );

    type Input = ExtractInput<(typeof handler)['__validators']>;
    expectTypeOf<Input>().toEqualTypeOf<{ body: { title: string } }>();
  });

  it('extracts all three slots combined', () => {
    const handler = defineHandler.withValidator({
      params: z.object({ id: z.string() }),
      query: z.object({ format: z.string() }),
      body: z.object({ data: z.array(z.number()) }),
    })((_c, { params, query, body }) => ({
      id: params.id,
      format: query.format,
      count: body.data.length,
    }));

    type Input = ExtractInput<(typeof handler)['__validators']>;
    expectTypeOf<Input>().toEqualTypeOf<{
      params: { id: string };
      query: { format: string };
      body: { data: Array<number> };
    }>();
  });
});
