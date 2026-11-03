import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toSlash } from 'pathslash';
import { describe, expect, it, afterEach } from 'vite-plus/test';
import { getSsrServerEntryPath, hasSsrEntry, validateSsrEntry } from '../../src/ssr/entry.ts';

const tempDirs: Array<string> = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-ssr-entry-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

describe('ssr entry helpers', () => {
  it.each([
    'const handler = () => new Response("ok"); export { handler as "render" };',
    'export { handler as "render" } from "./renderer";',
    'const handler = () => new Response("ok"); export { handler as "default" };',
    'export { handler as "default" } from "./renderer";',
    'export const { render } = { render: () => new Response("ok") };',
    'export const { nested: [, { handler: render }] } = handlers;',
    'export const [render = fallback] = handlers;',
    'const render = () => new Response("ok"); export default render;',
    'function render() { return new Response("ok"); } export default render;',
    'const render = () => new Response("ok"); const alias = render; export default alias;',
    'const { render } = handlers; export default render;',
    'import render from "./renderer"; export default render;',
    'import { render } from "./renderer"; export default render;',
    'import { defineRender as define } from "void"; const render = define(() => new Response("ok")); export default render;',
    'const render = (() => new Response("ok")) satisfies Function; export default render;',
  ])('accepts renderer bindings: %s', (source) => {
    const root = createTempRoot();
    writeFileSync(join(root, 'src/main.client.ts'), 'console.log("client");');
    writeFileSync(join(root, 'src/main.ssr.ts'), source);
    expect(validateSsrEntry(root)).toBe(toSlash(join(root, 'src/main.ssr.ts')));
  });

  it('resolves long renderer alias chains without overflowing the stack', () => {
    const root = createTempRoot();
    const aliases = Array.from(
      { length: 10_000 },
      (_, index) => `const alias${index + 1} = alias${index};`,
    ).join('\n');
    writeFileSync(join(root, 'src/main.client.ts'), 'console.log("client");');
    writeFileSync(
      join(root, 'src/main.ssr.ts'),
      `const alias0 = () => new Response('ok'); ${aliases} export default alias10000;`,
    );
    expect(validateSsrEntry(root)).toBe(toSlash(join(root, 'src/main.ssr.ts')));
  });

  it.each([
    'const render = 42; export default render;',
    'const render = () => new Response("ok"); export { render as "helper" };',
    'export { type render as "render" } from "./renderer";',
    'export { type render as "default" } from "./renderer";',
    'const first = second; const second = first; export default first;',
    'export default missing;',
    'export const { render: helper } = handlers;',
    'export const { helper = render } = handlers;',
    'import type { render } from "./renderer"; export default render;',
  ])('rejects missing or non-callable renderer bindings: %s', (source) => {
    const root = createTempRoot();
    writeFileSync(join(root, 'src/main.client.ts'), 'console.log("client");');
    writeFileSync(join(root, 'src/main.ssr.ts'), source);
    expect(() => validateSsrEntry(root)).toThrow('Export `render(c, assetTags)`');
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when ssr entry is missing', () => {
    const root = createTempRoot();
    expect(hasSsrEntry(root)).toBe(false);
    expect(getSsrServerEntryPath(root)).toBeNull();
    expect(validateSsrEntry(root)).toBeNull();
  });

  it('validates exported render function', () => {
    const root = createTempRoot();
    const file = join(root, 'src', 'main.ssr.ts');
    writeFileSync(
      join(root, 'src', 'main.client.tsx'),
      "import { hydrateRoot } from 'react-dom/client'; hydrateRoot(document, null);",
    );
    writeFileSync(
      file,
      "export async function render(request, env) { return new Response('ok'); }",
    );

    expect(hasSsrEntry(root)).toBe(true);
    expect(validateSsrEntry(root)).toBe(toSlash(file));
  });

  it('supports tsx ssr entry files', () => {
    const root = createTempRoot();
    const file = join(root, 'src', 'main.ssr.tsx');
    writeFileSync(join(root, 'src', 'main.client.ts'), "console.log('client entry');");
    writeFileSync(
      file,
      "export async function render(request, env) { return new Response('<div>ok</div>'); }",
    );

    expect(hasSsrEntry(root)).toBe(true);
    expect(validateSsrEntry(root)).toBe(toSlash(file));
  });

  it('supports default defineRender export', () => {
    const root = createTempRoot();
    const file = join(root, 'src', 'main.ssr.ts');
    writeFileSync(join(root, 'src', 'main.client.ts'), "console.log('client entry');");
    writeFileSync(
      file,
      "import { defineRender } from 'void'; export default defineRender(async () => new Response('ok'));",
    );

    expect(hasSsrEntry(root)).toBe(true);
    expect(validateSsrEntry(root)).toBe(toSlash(file));
  });

  it('throws when both ts and tsx ssr entries exist', () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'src', 'main.client.ts'), "console.log('client entry');");
    writeFileSync(
      join(root, 'src', 'main.ssr.ts'),
      "export async function render(request, env) { return new Response('ok'); }",
    );
    writeFileSync(
      join(root, 'src', 'main.ssr.tsx'),
      "export async function render(request, env) { return new Response('ok'); }",
    );

    expect(() => validateSsrEntry(root)).toThrow('Multiple SSR entry files found');
  });

  it('throws for missing render export', () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'src', 'main.client.ts'), "console.log('client entry');");
    writeFileSync(
      join(root, 'src', 'main.ssr.ts'),
      "export const notRender = () => new Response('ok');",
    );

    expect(() => validateSsrEntry(root)).toThrow(
      'Export `render(c, assetTags)` or `export default defineRender(...)`',
    );
  });

  it('does not accept a render export mentioned only in a comment', () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'src', 'main.client.ts'), "console.log('client entry');");
    writeFileSync(
      join(root, 'src', 'main.ssr.ts'),
      '// export const render = () => null;\nexport const other = 1;',
    );
    expect(() => validateSsrEntry(root)).toThrow('Export `render(c, assetTags)`');
  });

  it('does not treat a type-only render export as a valid entry', () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'src', 'main.client.ts'), "console.log('client entry');");
    writeFileSync(
      join(root, 'src', 'main.ssr.ts'),
      `type render = () => Response;
export type { render };`,
    );

    expect(() => validateSsrEntry(root)).toThrow(
      'Export `render(c, assetTags)` or `export default defineRender(...)`',
    );
  });

  it('throws when server entry exists without client entry', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'src', 'main.ssr.ts'),
      "export async function render(request, env) { return new Response('ok'); }",
    );

    expect(() => validateSsrEntry(root)).toThrow('ssr: Missing client entry');
  });

  it('throws when client entry exists without server entry', () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'src', 'main.client.ts'), "console.log('client entry');");

    expect(() => validateSsrEntry(root)).toThrow('ssr: Missing server entry');
  });
});
