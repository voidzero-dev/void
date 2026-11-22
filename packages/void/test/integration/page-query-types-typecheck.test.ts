import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vite-plus/test';
import { generateRouteTypes } from '../../src/codegen/route-types.ts';
import type { PageDefinition } from '../../src/pages/types.ts';
import type { ScanResult } from '../../src/router/scan.ts';

const voidDist = join(import.meta.dirname, '..', '..', 'dist');
const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A page loader whose query schema has different input and output types. */
const pageLoader = (input: string, output: string) => `
import { defineHandler } from 'void';

type Schema<I, O> = {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => { value: O };
    readonly types?: { readonly input: I; readonly output: O };
  };
};

declare const query: Schema<${input}, ${output}>;
export const loader = defineHandler.withValidator({ query })(() => ({ ok: true }));
`;

const plainLoader = `
import { defineHandler } from 'void';

export const loader = defineHandler(() => ({ ok: true }));
`;

function paymentPage(methods: Array<string> = ['loader']): PageDefinition {
  return {
    pattern: '/payments',
    componentPath: 'payments.vue',
    serverPath: 'payments.server.ts',
    componentId: 'payments',
    params: [],
    catchAll: false,
    methods,
    ssrMode: 'auto',
    prerenderMode: 'auto',
    renderMode: 'server',
    shouldPrerender: false,
    island: false,
  };
}

function searchPage(): PageDefinition {
  return {
    ...paymentPage(),
    pattern: '/search',
    componentPath: 'search.vue',
    serverPath: 'search.server.ts',
    componentId: 'search',
  };
}

function typecheck(pages: Array<PageDefinition>, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'void-page-query-types-'));
  roots.push(root);
  const { dts } = generateRouteTypes(
    {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages, layouts: [], namedLayouts: [] },
    } satisfies ScanResult,
    join(root, 'routes'),
    join(root, '.void'),
    join(root, 'pages'),
  );
  const all: Record<string, string> = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022'],
        types: [],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        paths: {
          void: [join(voidDist, 'index.d.mts')],
          'void/routes': [join(root, 'routes-base.d.ts')],
        },
      },
      files: ['.void/routes.d.ts', 'check.ts'],
    }),
    '.void/routes.d.ts': dts,
    'routes-base.d.ts': 'export {};',
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const tsrs = join(
    dirname(createRequire(import.meta.url).resolve('tsrs/package.json')),
    'bin/tsrs',
  );
  return spawnSync(process.execPath, [tsrs, '-p', join(root, 'tsconfig.json')], {
    encoding: 'utf8',
  });
}

it('checks routeUrl() query keys and values against the destination loader schema', () => {
  const result = typecheck([paymentPage(), searchPage()], {
    'pages/payments.server.ts': pageLoader(
      "{ status: 'paid' | 'pending'; page?: number }",
      '{ status: string; page: number }',
    ),
    'pages/search.server.ts': plainLoader,
    'check.ts': [
      "import { routeUrl } from 'void/routes';",
      "routeUrl('/payments', { query: { status: 'paid' } });",
      "routeUrl('/payments', { query: { status: 'pending', page: 2 } });",
      '// @ts-expect-error a key outside the loader schema',
      "routeUrl('/payments', { query: { statsu: 'paid' } });",
      '// @ts-expect-error a value outside the loader schema',
      "routeUrl('/payments', { query: { status: 'impossible' } });",
      '// @ts-expect-error the schema has a required key',
      "routeUrl('/payments');",
      "routeUrl('/search', { query: { anything: 'goes' } });",
      "routeUrl('/search');",
    ].join('\n'),
  });
  expect(result.stdout + result.stderr).toBe('');
  expect(result.status).toBe(0);
});

it('reads the page query with the schema output type', () => {
  const result = typecheck([paymentPage()], {
    'pages/payments.server.ts': pageLoader(
      "{ status: 'paid' | 'pending'; page?: number }",
      "{ status: 'paid' | 'pending'; page: number }",
    ),
    'check.ts': [
      "import type { PageQuery } from 'void/routes';",
      "const query: PageQuery<'/payments'> = { status: 'paid', page: 1 };",
      '// @ts-expect-error the parsed page key is a number',
      "const wrongPage: PageQuery<'/payments'> = { status: 'paid', page: '1' };",
      'void [query, wrongPage];',
    ].join('\n'),
  });
  expect(result.stdout + result.stderr).toBe('');
  expect(result.status).toBe(0);
});

it('leaves a page whose loader has no query schema untyped', () => {
  const result = typecheck([searchPage()], {
    'pages/search.server.ts': plainLoader,
    'check.ts': [
      "import { routeUrl } from 'void/routes';",
      "routeUrl('/search', { query: { anything: 'goes', page: 2 } });",
      "routeUrl('/search');",
    ].join('\n'),
  });
  expect(result.stdout + result.stderr).toBe('');
  expect(result.status).toBe(0);
});
