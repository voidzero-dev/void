import { type } from 'arktype';
import { email as valibotEmail, minLength, object, pipe, string } from 'valibot';
import { describe, it } from 'vite-plus/test';
import { z } from 'zod';
import { defineHandler } from '../../src/runtime/handler/index.ts';

describe('withValidator + zod', () => {
  const CreateUser = z.object({
    name: z.string().min(1),
    email: z.string().email(),
  });

  it('type: infers body and rejects undeclared slots', () => {
    defineHandler.withValidator({
      body: CreateUser,
    })((_c, { body }) => {
      // @ts-expect-error - 'age' does not exist on { name: string; email: string }
      void body.age;
      // @ts-expect-error - name is string, toFixed exists only on number
      void body.name.toFixed;
      return body;
    });

    defineHandler.withValidator({
      body: CreateUser,
      // @ts-expect-error - 'query' was not declared in validators
    })((_c, { body, _query }) => {
      return body;
    });
  });
});

describe('withValidator + valibot', () => {
  const CreateUser = object({
    name: pipe(string(), minLength(1)),
    email: pipe(string(), valibotEmail()),
  });

  it('type: infers body and query types from schema', () => {
    defineHandler.withValidator({
      body: CreateUser,
    })((_c, { body }) => {
      // @ts-expect-error - 'age' does not exist on { name: string; email: string }
      void body.age;
      // @ts-expect-error - name is string, toFixed exists only on number
      void body.name.toFixed;
      return body;
    });

    defineHandler.withValidator({
      query: object({ q: string() }),
    })((_c, { query }) => {
      // @ts-expect-error - 'page' does not exist on { q: string }
      void query.page;
      return query;
    });
  });
});

describe('withValidator + arktype', () => {
  const CreateUser = type({
    name: 'string >= 1',
    email: 'string.email',
  });

  it('type: infers body and params types from schema', () => {
    defineHandler.withValidator({
      body: CreateUser,
    })((_c, { body }) => {
      // @ts-expect-error - 'age' does not exist on { name: string; email: string }
      void body.age;
      // @ts-expect-error - name is string, toFixed exists only on number
      void body.name.toFixed;
      return body;
    });

    defineHandler.withValidator({
      params: type({ id: 'string' }),
    })((_c, { params }) => {
      // @ts-expect-error - 'slug' does not exist on { id: string }
      void params.slug;
      return params;
    });
  });
});
