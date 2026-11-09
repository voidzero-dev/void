import { describe, expect, it } from 'vite-plus/test';
import { emitHonoComponent } from '../../src/emit-hono.ts';
import { makeResult } from '../compile-result-fixture.ts';

describe('emitHonoComponent', () => {
  it('emits valid Hono JSX component code', () => {
    const code = emitHonoComponent(makeResult(), []);
    expect(code).toContain('import { jsx, Fragment } from "hono/jsx"');
    expect(code).toContain('import { raw } from "hono/html"');
    expect(code).toContain('FrontmatterContext.Provider');
    expect(code).toContain('raw(');
    expect(code).toContain('export const frontmatter = __frontmatter');
    expect(code).toContain('export const headings = __headings');
  });
});

describe('emitHonoComponent with islands', () => {
  it('emits island imports and wrappers', () => {
    const result = makeResult({
      html: '<h1>Hello</h1>\n<Counter />\n<p>More</p>\n',
    });
    const code = emitHonoComponent(result, [
      {
        name: 'Counter',
        specifier: './Counter.tsx',
        strategy: 'visible',
        islandId: 'pages/Counter',
      },
    ]);

    expect(code).toContain('import _raw_island_0 from "./Counter.tsx"');
    expect(code).toContain('"data-island": "pages/Counter"');
    expect(code).toContain('"data-hydrate": "visible"');
    expect(code).toContain('jsx(Counter, {})');
    expect(code).toContain('raw("<h1>Hello</h1>');
  });
});
