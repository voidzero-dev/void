import * as hono from 'hono/jsx';
import * as honoDevelopment from 'hono/jsx/jsx-dev-runtime';
import * as honoRuntime from 'hono/jsx/jsx-runtime';
import { expect, it } from 'vite-plus/test';
import * as jsx from 'void/jsx';
import * as development from 'void/jsx/jsx-dev-runtime';
import * as runtime from 'void/jsx/jsx-runtime';

it('re-exports the Hono JSX API and both automatic runtimes', () => {
  expect(jsx).toEqual(hono);
  expect(runtime).toEqual(honoRuntime);
  expect(development).toEqual(honoDevelopment);
  expect(jsx.jsx('strong', {}, '<hello>').toString()).toBe('<strong>&lt;hello&gt;</strong>');
});
