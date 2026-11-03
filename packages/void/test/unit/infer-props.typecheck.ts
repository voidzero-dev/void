import { describe, expectTypeOf, it } from 'vite-plus/test';
import { z } from 'zod';
import type { InferProps } from '../../src/pages/defer.ts';
import { defineHandler, defineMiddleware } from '../../src/runtime/handler.ts';

type Book = { id: string; title: string };
type Author = { id: string; name: string };

declare function findBook(id: string): Promise<Book | undefined>;
declare function findAuthor(id: string): Promise<Author>;
declare const showAuthor: boolean;

const validators = { params: z.object({ id: z.string() }) };

const middleware = defineMiddleware(async (_c, next) => {
  await next();
});

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
  it('unwraps an async loader with middleware and excludes Response', () => {
    const loader = defineHandler(middleware, async (c) => {
      const book = await findBook('1');
      if (!book) {
        return c.notFound();
      }
      return { book };
    });

    expectTypeOf<InferProps<typeof loader>>().toEqualTypeOf<{ book: Book }>();
  });

  it('infers a loader with several middlewares', () => {
    const loader = defineHandler(middleware, middleware, middleware, (_c) => ({ id: '1' }));

    expectTypeOf<InferProps<typeof loader>>().toEqualTypeOf<{ id: string }>();
  });

  it('keeps every promise a non-async loader with middleware can return', () => {
    const loader = defineHandler(middleware, (_c) =>
      showAuthor
        ? findAuthor('1').then((author) => ({ author }))
        : findBook('1').then((book) => ({ book })),
    );

    expectTypeOf<InferProps<typeof loader>>().toEqualTypeOf<
      { author: Author } | { book: Book | undefined }
    >();
  });

  it('takes the props type as an explicit type argument', () => {
    type Props = { title: string };
    const loader = defineHandler<Props>(async () => ({ title: 'a' }));
    const guarded = defineHandler<Props>(middleware, async (c) =>
      c.req.query('missing') ? c.notFound() : { title: 'a' },
    );

    expectTypeOf<InferProps<typeof loader>>().toEqualTypeOf<Props>();
    expectTypeOf<InferProps<typeof guarded>>().toEqualTypeOf<Props>();
  });
});
