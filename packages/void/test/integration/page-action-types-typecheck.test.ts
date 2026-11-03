import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
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

function page(env: 'dev' | 'prod', methods: Array<string>): PageDefinition {
  return {
    pattern: '/contact',
    componentPath: `contact.${env}.vue`,
    serverPath: `contact.${env}.server.ts`,
    componentId: `contact.${env}`,
    params: [],
    catchAll: false,
    methods,
    ssrMode: 'auto',
    prerenderMode: 'auto',
    renderMode: 'server',
    shouldPrerender: false,
    island: false,
    env,
  };
}

const schema = (body: string) =>
  [
    "import { defineHandler } from 'void';",
    'type Schema<T> = {',
    "  readonly '~standard': {",
    '    readonly version: 1;',
    '    readonly vendor: string;',
    '    readonly validate: (value: unknown) => { value: T };',
    '    readonly types?: { readonly input: T; readonly output: T };',
    '  };',
    '};',
    `declare const body: Schema<${body}>;`,
  ].join('\n');

function typecheck(pages: Array<PageDefinition>, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'void-page-action-types-'));
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
          'void/routes': [join(voidDist, 'routes-stub.d.mts')],
        },
      },
      files: ['.void/routes.d.ts', 'check.ts'],
    }),
    '.void/routes.d.ts': dts,
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const tsc = join(
    dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
    'bin/tsc',
  );
  return spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], {
    encoding: 'utf8',
  });
}

// The same constraint every adapter's useForm puts on its URL.
const useForm = [
  "import type { ActionUrl, ResolveActionBody } from 'void/routes';",
  'declare function useForm<U extends ActionUrl & string>(url: U, body: ResolveActionBody<U>): void;',
];

describe('page action types for a .dev + .prod page pair', () => {
  it('accepts the body of each page when the two bodies differ', () => {
    const companion = (age: string) =>
      `${schema(`{ email: string; age: ${age} }`)}
export const action = defineHandler.withValidator({ body })(() => ({ ok: true }));`;
    const result = typecheck([page('dev', ['action']), page('prod', ['action'])], {
      'pages/contact.dev.server.ts': companion('string'),
      'pages/contact.prod.server.ts': companion('number'),
      'check.ts': [
        ...useForm,
        "useForm('/contact', { email: 'a@b.c', age: '1' });",
        "useForm('/contact', { email: 'a@b.c', age: 1 });",
        '// @ts-expect-error the body is still typed',
        "useForm('/contact', { email: 1, age: 1 });",
      ].join('\n'),
    });
    expect(result.stdout + result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('accepts both URLs when only one page of the pair has named actions', () => {
    const result = typecheck([page('dev', ['action']), page('prod', ['actions'])], {
      'pages/contact.dev.server.ts': `${schema('{ email: string }')}
export const action = defineHandler.withValidator({ body })(() => ({ ok: true }));`,
      'pages/contact.prod.server.ts': `${schema('{ title: string }')}
export const actions = { save: defineHandler.withValidator({ body })(() => ({ ok: true })) };`,
      'check.ts': [
        ...useForm,
        "useForm('/contact', { email: 'a@b.c' });",
        '// @ts-expect-error the single action body is still typed',
        "useForm('/contact', { email: 1 });",
        "useForm('/contact?save', { title: 'x' });",
        '// @ts-expect-error the named action body is still typed',
        "useForm('/contact?save', { title: 1 });",
      ].join('\n'),
    });
    expect(result.stdout + result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('accepts the named actions of each page when the two sets differ', () => {
    const companion = (name: string) =>
      `${schema('{ title: string }')}
export const actions = { ${name}: defineHandler.withValidator({ body })(() => ({ ok: true })) };`;
    const result = typecheck([page('dev', ['actions']), page('prod', ['actions'])], {
      'pages/contact.dev.server.ts': companion('save'),
      'pages/contact.prod.server.ts': companion('publish'),
      'check.ts': [
        ...useForm,
        "useForm('/contact?save', { title: 'x' });",
        "useForm('/contact?publish', { title: 'x' });",
        '// @ts-expect-error neither page has this action',
        "useForm('/contact?remove', { title: 'x' });",
      ].join('\n'),
    });
    expect(result.stdout + result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
