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

const schemaTypes = `
type Schema<I, O> = {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => { value: O };
    readonly types?: { readonly input: I; readonly output: O };
  };
};
`;

/** A page server that exports its query schema, as the generator reads it. */
const pageWithSchema = (input: string, output: string) => `
import { defineHandler } from 'void';
${schemaTypes}
declare const schema: Schema<${input}, ${output}>;
export const query = schema;
export const loader = defineHandler.withValidator({ query })(() => ({ ok: true }));
`;

const plainLoader = `
import { defineHandler } from 'void';

export const loader = defineHandler(() => ({ ok: true }));
`;

function page(pattern: string, serverPath: string, env?: 'dev' | 'prod'): PageDefinition {
  const base = pattern.slice(1);
  return {
    pattern,
    componentPath: `${base}.vue`,
    serverPath,
    componentId: base,
    params: [],
    catchAll: false,
    methods: ['loader'],
    ssrMode: 'auto',
    prerenderMode: 'auto',
    renderMode: 'server',
    shouldPrerender: false,
    island: false,
    ...(env ? { env } : {}),
  };
}

/** A project small enough that `skipLibCheck: false` only sees the generated file. */
function typecheckDeclarationsOnly() {
  const root = mkdtempSync(join(tmpdir(), 'void-page-query-decls-'));
  roots.push(root);
  const { dts } = generateRouteTypes(
    {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    } satisfies ScanResult,
    join(root, 'routes'),
    join(root, '.void'),
    join(root, 'pages'),
  );
  const files: Record<string, string> = {
    // No page servers, so nothing pulls `void`'s Workers-typed declarations in.
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        // The generated helpers mention Response and URL.
        lib: ['ES2022', 'DOM'],
        types: [],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        allowImportingTsExtensions: true,
        paths: { 'void/routes': [join(root, 'routes-base.d.ts')] },
      },
      files: ['.void/routes.d.ts', 'check.ts'],
    }),
    '.void/routes.d.ts': dts,
    'routes-base.d.ts': 'export {};',
    'check.ts':
      "import type { RouteUrlArgs } from 'void/routes';\nexport type Args = RouteUrlArgs<never>;\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const tsrs = join(
    dirname(createRequire(import.meta.url).resolve('tsrs/package.json')),
    'bin/tsrs',
  );
  return spawnSync(process.execPath, [tsrs, '-p', join(root, 'tsconfig.json')], {
    encoding: 'utf8',
    cwd: root,
  });
}

it('compiles with skipLibCheck off, which projects default to', () => {
  const result = typecheckDeclarationsOnly();
  expect(result.stdout + result.stderr).toBe('');
  expect(result.status).toBe(0);
});

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
        // A page server imports `void`, whose declarations need Workers types
        // that this fixture does not load. The single-declaration guard that
        // keeps skipLibCheck: false projects compiling lives in route-types.test.
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
    cwd: root,
  });
}

function expectClean(
  result: ReturnType<typeof typecheck>,
  output: { stdout: string; stderr: string },
) {
  expect(output.stdout + output.stderr).toBe('');
  expect(result.status).toBe(0);
}

it('checks routeUrl() query keys and values against the page schema', () => {
  const result = typecheck(
    [page('/payments', 'payments.server.ts'), page('/search', 'search.server.ts')],
    {
      'pages/payments.server.ts': pageWithSchema(
        "{ status: 'paid' | 'pending'; page?: number }",
        "{ status: 'paid' | 'pending'; page: number }",
      ),
      'pages/search.server.ts': plainLoader,
      'check.ts': [
        "import { routeUrl } from 'void/routes';",
        "routeUrl('/payments', { query: { status: 'paid' } });",
        "routeUrl('/payments', { query: { status: 'pending', page: 2 } });",
        '// @ts-expect-error a key outside the schema',
        "routeUrl('/payments', { query: { statsu: 'paid' } });",
        '// @ts-expect-error a value outside the schema',
        "routeUrl('/payments', { query: { status: 'impossible' } });",
        '// @ts-expect-error the schema has a required key',
        "routeUrl('/payments');",
        "routeUrl('/search', { query: { anything: 'goes' } });",
        "routeUrl('/search');",
      ].join('\n'),
    },
  );
  expectClean(result, result);
});

it('keeps excess keys checked when every schema key is optional', () => {
  const result = typecheck([page('/payments', 'payments.server.ts')], {
    'pages/payments.server.ts': pageWithSchema(
      "{ status?: 'paid' | 'pending'; page?: number }",
      "{ status: 'paid' | 'pending'; page: number }",
    ),
    'check.ts': [
      "import { routeUrl } from 'void/routes';",
      "routeUrl('/payments');",
      "routeUrl('/payments', { query: { status: 'paid' } });",
      '// @ts-expect-error a misspelled optional key is still a typo',
      "routeUrl('/payments', { query: { statsu: 'paid' } });",
      '// @ts-expect-error a misspelled optional key is still a typo',
      "routeUrl('/payments', { query: { status: 'paid', pgae: 2 } });",
    ].join('\n'),
  });
  expectClean(result, result);
});

it('accepts the URL form of an input that is not a URL primitive', () => {
  const result = typecheck([page('/reports', 'reports.server.ts')], {
    'pages/reports.server.ts': pageWithSchema('{ since: Date }', '{ since: Date }'),
    'check.ts': [
      "import { routeUrl } from 'void/routes';",
      "routeUrl('/reports', { query: { since: '2024-01-01' } });",
      '// @ts-expect-error a query string cannot carry a Date',
      "routeUrl('/reports', { query: { since: new Date() } });",
    ].join('\n'),
  });
  expectClean(result, result);
});

it('keeps a loader that links to its own page typed', () => {
  const result = typecheck([page('/payments', 'payments.server.ts')], {
    'pages/payments.server.ts': `
import { defineHandler } from 'void';
import { routeUrl } from 'void/routes';
${schemaTypes}
declare const schema: Schema<{ status: 'paid' | 'pending'; page?: number }, { status: 'paid' | 'pending'; page: number }>;
export const query = schema;
export const loader = defineHandler.withValidator({ query })((c, { query }) => ({
  next: routeUrl('/payments', { query: { status: query.status, page: query.page + 1 } }),
}));
`,
    'check.ts': [
      "import { routeUrl } from 'void/routes';",
      "routeUrl('/payments', { query: { status: 'paid' } });",
      '// @ts-expect-error the loader did not widen the map to any',
      "routeUrl('/payments', { query: { status: 'void' } });",
    ].join('\n'),
  });
  expectClean(result, result);
});

it('accepts both sides of a .dev + .prod pair when only one exports a schema', () => {
  const result = typecheck(
    [
      page('/payments', 'payments.dev.server.ts', 'dev'),
      page('/payments', 'payments.prod.server.ts', 'prod'),
    ],
    {
      'pages/payments.dev.server.ts': pageWithSchema(
        "{ status: 'paid' | 'pending' }",
        "{ status: 'paid' | 'pending' }",
      ),
      'pages/payments.prod.server.ts': plainLoader,
      'check.ts': [
        "import { routeUrl } from 'void/routes';",
        "routeUrl('/payments', { query: { status: 'paid' } });",
        "routeUrl('/payments');",
        "routeUrl('/payments', { query: { anything: 'goes' } });",
      ].join('\n'),
    },
  );
  expectClean(result, result);
});

it('reads the schema output only when the page exposes its query', () => {
  const input = "{ status: 'paid' | 'pending'; page?: number }";
  const output = "{ status: 'paid' | 'pending'; page: number }";
  const result = typecheck(
    [page('/payments', 'payments.server.ts'), page('/orders', 'orders.server.ts')],
    {
      'pages/payments.server.ts': `${pageWithSchema(input, output)}export const exposeQuery = true;\n`,
      'pages/orders.server.ts': pageWithSchema(input, output),
      'check.ts': [
        "import type { PageQuery } from 'void/routes';",
        "const exposed: PageQuery<'/payments'> = { status: 'paid', page: 1 };",
        '// @ts-expect-error the parsed page key is a number',
        "const wrongPage: PageQuery<'/payments'> = { status: 'paid', page: '1' };",
        // Without the flag the browser only ever receives the request's strings.
        "const hidden: PageQuery<'/orders'> = { status: 'paid', page: '1' };",
        '// @ts-expect-error raw values are strings',
        "const hiddenNumber: PageQuery<'/orders'> = { status: 'paid', page: 1 };",
        'void [exposed, wrongPage, hidden, hiddenNumber];',
      ].join('\n'),
    },
  );
  expectClean(result, result);
});

it('accepts URL values for an input the schema types as unknown', () => {
  // Zod 4's `z.coerce.number()` and friends take `unknown` as input.
  const result = typecheck([page('/search', 'search.server.ts')], {
    'pages/search.server.ts': `${pageWithSchema(
      '{ q: string; page?: unknown; tags?: Array<unknown> }',
      '{ q: string; page: number; tags: Array<number> }',
    )}export const exposeQuery = true;\n`,
    'check.ts': [
      "import { routeUrl, type PageQuery } from 'void/routes';",
      "routeUrl('/search', { query: { q: 'ada', page: 2 } });",
      "routeUrl('/search', { query: { q: 'ada', page: '2', tags: [1, '2'] } });",
      "declare const current: PageQuery<'/search'>;",
      "routeUrl('/search', { query: { ...current, page: 1 } });",
      '// @ts-expect-error a misspelled key is still a typo',
      "routeUrl('/search', { query: { q: 'ada', pgae: 2 } });",
      '// @ts-expect-error a query string cannot carry an object',
      "routeUrl('/search', { query: { q: 'ada', page: { n: 2 } } });",
    ].join('\n'),
  });
  expectClean(result, result);
});

it('keeps a .dev + .prod side without a loader untyped', () => {
  const result = typecheck(
    [
      page('/payments', 'payments.dev.server.ts', 'dev'),
      { ...page('/payments', 'unused', 'prod'), serverPath: null, methods: [] },
    ],
    {
      'pages/payments.dev.server.ts': pageWithSchema(
        "{ status: 'paid' | 'pending' }",
        "{ status: 'paid' | 'pending' }",
      ),
      'check.ts': [
        "import { routeUrl } from 'void/routes';",
        "routeUrl('/payments', { query: { status: 'paid' } });",
        "routeUrl('/payments');",
        "routeUrl('/payments', { query: { anything: 'goes' } });",
      ].join('\n'),
    },
  );
  expectClean(result, result);
});

it('keeps each branch of a union schema input', () => {
  const union = "{ kind: 'id'; id: string } | { kind: 'slug'; slug: string }";
  const result = typecheck([page('/item', 'item.server.ts')], {
    'pages/item.server.ts': pageWithSchema(union, union),
    'check.ts': [
      "import { routeUrl } from 'void/routes';",
      "routeUrl('/item', { query: { kind: 'id', id: '1' } });",
      "routeUrl('/item', { query: { kind: 'slug', slug: 'hello' } });",
      '// @ts-expect-error the id branch needs its id',
      "routeUrl('/item', { query: { kind: 'id' } });",
    ].join('\n'),
  });
  expectClean(result, result);
});

it('reads raw strings when an exposed schema returns a scalar', () => {
  // The page only receives a validated query that is an object.
  const result = typecheck([page('/count', 'count.server.ts')], {
    'pages/count.server.ts': `${pageWithSchema('{ page: string }', 'number')}export const exposeQuery = true;\n`,
    'check.ts': [
      "import type { PageQuery } from 'void/routes';",
      "declare const query: PageQuery<'/count'>;",
      'const raw: string | Array<string> | undefined = query.page;',
      '// @ts-expect-error the scalar output never reaches the page',
      'const scalar: number = query;',
      'void [raw, scalar];',
    ].join('\n'),
  });
  expectClean(result, result);
});

it('requires the query when any page of a union path requires it', () => {
  const result = typecheck(
    [page('/payments', 'payments.server.ts'), page('/search', 'search.server.ts')],
    {
      'pages/payments.server.ts': pageWithSchema(
        "{ status: 'paid' | 'pending' }",
        "{ status: 'paid' | 'pending' }",
      ),
      'pages/search.server.ts': plainLoader,
      'check.ts': [
        "import { routeUrl } from 'void/routes';",
        "declare const path: '/payments' | '/search';",
        '// @ts-expect-error /payments requires `status`',
        'routeUrl(path);',
        "routeUrl('/search');",
      ].join('\n'),
    },
  );
  expectClean(result, result);
});

it('keeps URL values checked when the whole schema input is unknown', () => {
  // A preprocessed object schema takes `unknown` as its input.
  const result = typecheck([page('/search', 'search.server.ts')], {
    'pages/search.server.ts': pageWithSchema('unknown', '{ page: number }'),
    'check.ts': [
      "import { routeUrl } from 'void/routes';",
      "routeUrl('/search');",
      "routeUrl('/search', { query: { page: 2 } });",
      '// @ts-expect-error a query string cannot carry an object',
      "routeUrl('/search', { query: { page: { n: 2 } } });",
    ].join('\n'),
  });
  expectClean(result, result);
});
