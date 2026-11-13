import { describe, expectTypeOf, it } from 'vite-plus/test';
import { html, raw, type HtmlEscapedString } from 'void/html';
import { defineHandler } from '../../src/runtime/handler.ts';

describe('void/html types', () => {
  it('returns escaped HTML from templates, including asynchronous templates', () => {
    const template = html`<h1>${'Hello'}</h1>`;
    const asyncTemplate = html`<h1>${Promise.resolve('Hello')}</h1>`;
    expectTypeOf(template).toEqualTypeOf<HtmlEscapedString | Promise<HtmlEscapedString>>();
    expectTypeOf(asyncTemplate).toEqualTypeOf<HtmlEscapedString | Promise<HtmlEscapedString>>();
    expectTypeOf<Awaited<typeof template>>().toEqualTypeOf<HtmlEscapedString>();
    expectTypeOf<Awaited<typeof asyncTemplate>>().toEqualTypeOf<HtmlEscapedString>();
  });

  it('returns escaped HTML from the raw helper', () => {
    expectTypeOf(raw('<strong>Hello</strong>')).toEqualTypeOf<HtmlEscapedString>();
  });

  it('does not accept plain strings as escaped HTML', () => {
    expectTypeOf<string>().not.toExtend<HtmlEscapedString>();
  });

  it('accepts an awaited template as a handler HTML response', () => {
    defineHandler(async (c) => {
      const name = c.req.query('name') ?? 'World';
      const response = c.html(await html`<h1>Hello ${name}</h1>`);
      expectTypeOf(response).toExtend<Response>();
      return response;
    });
  });
});
