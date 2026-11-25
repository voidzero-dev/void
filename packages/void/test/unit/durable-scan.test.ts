import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toSlash } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  deriveDurableResourceIdentity,
  inferDurableResourceName,
  scanDurableObjectModules,
} from '../../src/durable/scan.ts';

const roots: Array<string> = [];

function createModule(filename: string, source: string): string {
  const root = mkdtempSync(join(tmpdir(), 'void-durable-scan-'));
  roots.push(root);
  mkdirSync(join(root, 'durable-objects'));
  writeFileSync(join(root, 'durable-objects', filename), source);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('scanDurableObjectModules', () => {
  it('discovers explicit native Durable Object identities through imported aliases', () => {
    const root = createModule(
      'agent.ts',
      `import { defineDurableObject as durable } from 'void/durable';
      class Agent {};
      export default durable({ name: 'workspace-agent', class: Agent });`,
    );
    expect(scanDurableObjectModules(root)[0]).toMatchObject({
      name: 'workspace-agent',
      ...deriveDurableResourceIdentity('workspace-agent'),
    });
  });
  it('derives stable binding, class, and migration names from filenames', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-durable-scan-'));
    roots.push(root);
    mkdirSync(join(root, 'durable-objects'));
    writeFileSync(join(root, 'durable-objects', 'shopping-cart.ts'), 'export default class {}');

    expect(scanDurableObjectModules(root)).toEqual([
      {
        filePath: toSlash(join(root, 'durable-objects', 'shopping-cart.ts')),
        bindingName: 'SHOPPING_CART',
        className: 'ShoppingCartDurableObject',
        migrationTag: 'void-durable-shopping-cart-v1',
      },
    ]);
  });

  it('rejects filenames that normalize to the same generated names', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-durable-scan-'));
    roots.push(root);
    mkdirSync(join(root, 'durable-objects'));
    writeFileSync(join(root, 'durable-objects', 'shopping-cart.ts'), 'export default {}');
    writeFileSync(join(root, 'durable-objects', 'shopping_cart.ts'), 'export default {}');

    expect(() => scanDurableObjectModules(root)).toThrow('duplicate generated name');
  });

  it.each(['shopping-cart.ts', 'API-cache.mts', 'userStore.js', 'counter_store.mjs'])(
    'pins %s without changing its resource identity, then preserves identity when moved',
    (filename) => {
      const root = createModule(
        filename,
        'export default defineDurableState({ initialState: {} })',
      );
      const [original] = scanDurableObjectModules(root);
      const name = inferDurableResourceName(original.filePath);
      writeFileSync(
        original.filePath,
        `export default defineDurableState({ name: ${JSON.stringify(name)}, initialState: {} })`,
      );
      const [pinned] = scanDurableObjectModules(root);
      expect(pinned).toEqual({ ...original, name });
      renameSync(original.filePath, join(root, 'durable-objects', 'new-location.ts'));
      const [moved] = scanDurableObjectModules(root);
      expect(moved).toEqual({
        ...pinned,
        filePath: toSlash(join(root, 'durable-objects', 'new-location.ts')),
      });
    },
  );

  it('reads named default constants and static local name constants without evaluation', () => {
    const root = createModule(
      'cart.ts',
      `
      const resource = 'API-cache' as const;
      const options = { name: resource, initialState: {} } satisfies Options;
      export const Cart = defineDurableState(options);
      export default Cart;
    `,
    );
    expect(scanDurableObjectModules(root)[0]).toMatchObject({
      name: 'API-cache',
      ...deriveDurableResourceIdentity('API-cache'),
    });
  });

  it.each([
    `import { defineDurableState as state } from 'void/durable'; export default state({ name: 'counter' });`,
    `import * as durable from 'void/durable'; export default durable.defineDurableState({ name: 'counter' });`,
    `import * as durable from 'void/durable'; const Counter = durable['defineDurableState']({ name: 'counter' }); export default Counter;`,
  ])('reads explicit identities through aliased or namespace imports', (source) => {
    const root = createModule('moved.ts', source);
    expect(scanDurableObjectModules(root)[0]).toMatchObject({
      name: 'counter',
      ...deriveDurableResourceIdentity('counter'),
    });
  });

  it.each([
    'export default defineDurableState({ name: undefined });',
    'const identity = undefined; export default defineDurableState({ name: identity });',
    `const base = { name: 'counter' }; export default defineDurableState({ ...base, name: undefined });`,
    `const noName = { name: undefined }; export default defineDurableState({ name: 'counter', ...noName });`,
  ])('treats statically undefined names exactly as absent', (source) => {
    const root = createModule('cart.ts', source);
    expect(scanDurableObjectModules(root)[0]).toEqual({
      filePath: toSlash(join(root, 'durable-objects', 'cart.ts')),
      ...deriveDurableResourceIdentity('cart'),
    });
  });

  it('rejects dynamic names in aliased definitions', () => {
    const root = createModule(
      'cart.ts',
      `
      import { defineDurableState as state } from 'void/durable';
      export default state({ name: process.env.NAME });
    `,
    );
    expect(() => scanDurableObjectModules(root)).toThrow('resource name must be');
  });

  it.each(["''", "'---'", '42', 'process.env.NAME', "'123-store'"])(
    'rejects explicit invalid or unresolved name %s',
    (name) => {
      const root = createModule('cart.ts', `export default defineDurableState({ name: ${name} })`);
      expect(() => scanDurableObjectModules(root)).toThrow('resource name must be');
    },
  );

  it('rejects collisions of explicit names and inferred names', () => {
    const root = createModule(
      'cart.ts',
      `export default defineDurableState({ name: 'shopping-cart' })`,
    );
    writeFileSync(join(root, 'durable-objects', 'shopping-cart.ts'), 'export default {}');
    expect(() => scanDurableObjectModules(root)).toThrow('duplicate generated name');
  });

  it('leaves dynamic unnamed definitions and raw default classes unchanged', () => {
    const root = createModule('cart.ts', 'export default defineDurableState(loadOptions())');
    expect(scanDurableObjectModules(root)[0]).toEqual({
      filePath: toSlash(join(root, 'durable-objects', 'cart.ts')),
      ...deriveDurableResourceIdentity('cart'),
    });
  });
});
