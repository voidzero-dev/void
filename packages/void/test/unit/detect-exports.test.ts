import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vite-plus/test';
import { detectHttpExports } from '../../src/router/detect-exports.ts';

const TMP = join(import.meta.dirname, '__tmp_detect_test__');

function writeRoute(filename: string, content: string): string {
  const full = join(TMP, filename);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  return full;
}

describe('detectHttpExports', () => {
  it.each([
    ['const handler = () => {}; export { handler as "GET" };', ['GET']],
    ['export { handler as "POST" } from "./handler";', ['POST']],
    ['const handler = () => {}; export { handler as "G\\u0045T" };', ['GET']],
    ['const GET = () => {}; export { GET as "helper" };', []],
    ['export type { GET as "GET" } from "./types";', []],
    ['export { type GET as "GET", handler as "POST" } from "./handler";', ['POST']],
  ])('uses the actual exported name in %s', (source, methods) => {
    expect(detectHttpExports(writeRoute('quoted.ts', source as string))).toEqual(methods);
  });

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('detects export function POST', () => {
    const path = writeRoute('hello.ts', 'export function POST() { return "ok"; }');
    expect(detectHttpExports(path)).toEqual(['POST']);
  });

  it('detects re-exported methods', () => {
    const path = writeRoute(
      'hello.ts',
      `const handler = () => "ok";
export { handler as GET };`,
    );
    expect(detectHttpExports(path)).toEqual(['GET']);
  });

  it.each([
    {
      name: 'object shorthand bindings',
      source: 'export const { GET, POST } = handlers;',
      methods: ['GET', 'POST'],
    },
    {
      name: 'renamed bindings rather than property keys',
      source: 'export const { get: GET, GET: helper, post: POST } = handlers;',
      methods: ['GET', 'POST'],
    },
    {
      name: 'defaults without inspecting initializer expressions',
      source: 'export const { GET = fallback, helper = POST, post: POST = fallback } = handlers;',
      methods: ['GET', 'POST'],
    },
    {
      name: 'nested object and array bindings with holes',
      source: 'export const { handlers: { get: GET }, methods: [, POST, { PUT }] } = routes;',
      methods: ['GET', 'POST', 'PUT'],
    },
    {
      name: 'array bindings with defaults and rest',
      source: 'export const [GET, , POST = fallback, ...HEAD] = handlers;',
      methods: ['GET', 'POST', 'HEAD'],
    },
    {
      name: 'object rest bindings',
      source: 'export const { helper, ...OPTIONS } = handlers;',
      methods: ['OPTIONS'],
    },
    {
      name: 'computed keys without treating key expressions as bindings',
      source: 'export const { [GET]: helper, [key]: POST, "put": PUT } = handlers;',
      methods: ['POST', 'PUT'],
    },
    {
      name: 'nested defaults without treating property names as bindings',
      source: 'export const { GET: { helper = POST }, handlers: [PATCH] = defaults } = routes;',
      methods: ['PATCH'],
    },
  ])('detects HTTP methods in $name', ({ source, methods }) => {
    const path = writeRoute('destructured.ts', source);
    expect(detectHttpExports(path)).toEqual(methods);
  });

  it('ignores destructured bindings that are not exported', () => {
    const path = writeRoute(
      'hello.ts',
      'const { GET, POST } = handlers; export const helper = GET;',
    );
    expect(detectHttpExports(path)).toEqual([]);
  });

  it('ignores non-HTTP exports', () => {
    const path = writeRoute(
      'hello.ts',
      `export const GET = () => "ok";
export const helper = () => {};
export function transform() {}`,
    );
    expect(detectHttpExports(path)).toEqual(['GET']);
  });

  it('ignores a type-only export statement', () => {
    // `export type { GET }` erases at runtime, so it must not register a GET route.
    const path = writeRoute(
      'hello.ts',
      `type GET = () => Response;
export type { GET };`,
    );
    expect(detectHttpExports(path)).toEqual([]);
  });

  it('ignores an inline type-only specifier but keeps value specifiers', () => {
    const path = writeRoute(
      'hello.ts',
      `const POST = () => "ok";
type GET = () => Response;
export { POST, type GET };`,
    );
    expect(detectHttpExports(path)).toEqual(['POST']);
  });

  it('returns empty array for no HTTP exports', () => {
    const path = writeRoute('hello.ts', 'export default () => "ok";');
    expect(detectHttpExports(path)).toEqual([]);
  });

  it('detects all standard HTTP methods', () => {
    const path = writeRoute(
      'all.ts',
      `export const GET = () => {};
export const POST = () => {};
export const PUT = () => {};
export const PATCH = () => {};
export const DELETE = () => {};
export const OPTIONS = () => {};
export const HEAD = () => {};`,
    );
    expect(detectHttpExports(path)).toEqual([
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'OPTIONS',
      'HEAD',
    ]);
  });

  it('handles invalid syntax gracefully', () => {
    const path = writeRoute('bad.ts', 'this is not valid {{{ code');
    expect(detectHttpExports(path)).toEqual([]);
  });
});
