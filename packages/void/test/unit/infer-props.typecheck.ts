import { describe, expectTypeOf, it } from 'vite-plus/test';
import { z } from 'zod';
import type { InferProps } from '../../src/pages/defer.ts';
import { defineHandler } from '../../src/runtime/handler.ts';

type Book = { id: string; title: string };

declare function findBook(id: string): Promise<Book | undefined>;

const validators = { params: z.object({ id: z.string() }) };

describe('InferProps', () => {
  it('unwraps an async plain loader and excludes Response', () => {
    const loader = defineHandler(async (c) => {
      const book = await findBook('1');
      if (!book) {
        return c.notFound();
      }
      return { book };
    });

    expectTypeOf<InferProps<typeof loader>>().toEqualTypeOf<{ book: Book }>();
  });

  it('infers a synchronous validated loader that returns only data', () => {
    const loader = defineHandler.withValidator(validators)((_c, { params }) => ({
      id: params.id,
    }));

    expectTypeOf<InferProps<typeof loader>>().toEqualTypeOf<{ id: string }>();
  });

  it('unwraps an async validated loader and excludes Response', () => {
    const loader = defineHandler.withValidator(validators)(async (c, { params }) => {
      const book = await findBook(params.id);
      if (!book) {
        return c.notFound();
      }
      return { book };
    });

    expectTypeOf<InferProps<typeof loader>>().toEqualTypeOf<{ book: Book }>();
  });

  it('excludes Response from a synchronous validated loader', () => {
    const loader = defineHandler.withValidator(validators)((c, { params }) => {
      if (params.id === 'missing') {
        return c.notFound();
      }
      return { id: params.id };
    });

    expectTypeOf<InferProps<typeof loader>>().toEqualTypeOf<{ id: string }>();
  });

  it('unwraps an async validated loader that returns only data', () => {
    const loader = defineHandler.withValidator(validators)(async (_c, { params }) => ({
      id: params.id,
    }));

    expectTypeOf<InferProps<typeof loader>>().toEqualTypeOf<{ id: string }>();
  });

  it('infers no props from a validated loader that returns only Response', () => {
    const loader = defineHandler.withValidator(validators)(async (c) => c.notFound());

    expectTypeOf<InferProps<typeof loader>>().toEqualTypeOf<never>();
  });

  it('unwraps a validated loader while preserving promises inside its props', () => {
    const loader = defineHandler.withValidator(validators)(async (_c, { params }) => ({
      book: findBook(params.id),
    }));

    expectTypeOf<InferProps<typeof loader>>().toEqualTypeOf<{
      book: Promise<Book | undefined>;
    }>();
  });
});
