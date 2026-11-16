import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import { generateRouteTypes } from '../../src/codegen/route-types.ts';

it('preserves tuples and JSON omissions in generated typed fetch responses', () => {
  const root = mkdtempSync(join(tmpdir(), 'void-route-response-types-'));
  const voidDist = join(import.meta.dirname, '..', '..', 'dist');
  const { dts } = generateRouteTypes(
    {
      routes: [
        {
          pattern: '/api/serialization',
          methods: ['GET', 'POST'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/serialization.ts',
        },
      ],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    },
    join(root, 'routes'),
    join(root, '.void'),
  );
  const files = {
    'package.json': JSON.stringify({ type: 'module' }),
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022', 'DOM'],
        types: [],
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        paths: {
          void: [join(voidDist, 'index.d.mts')],
          'void/client': [join(voidDist, 'runtime/client/index.d.mts')],
          'void/routes': [join(root, '.void/routes.d.ts')],
          zod: [
            join(
              dirname(createRequire(import.meta.url).resolve('zod/package.json')),
              'index.d.cts',
            ),
          ],
        },
      },
      files: ['.void/routes.d.ts', 'check.ts'],
    }),
    '.void/routes.d.ts': dts,
    'routes/api/serialization.ts': `
import { defineHandler } from 'void';
import { z } from 'zod';

const names = z.array(z.string()).brand<'Names'>().parse(['Alice']);
const readonlyNames = z.array(z.string()).readonly().brand<'Names'>().parse(['Alice']);
const datedPair = z.tuple([z.string(), z.date()]).brand<'DatedPair'>().parse(['Alice', new Date()]);

declare const hidden: unique symbol;
declare const payload: {
  pairs: [number, number][];
  readonlyTuple: readonly [string, Date];
  empty: [];
  readonlyEmpty: readonly [];
  optionalTuple: [label: string, timestamp?: Date];
  restTuple: [number, ...Date[]];
  readonlyRestTuple: readonly [string, ...Date[]];
  invalidTuple: [number, undefined, () => void, symbol, string | undefined];
  invalidArray: Array<string | undefined | (() => void) | symbol>;
  dates: Date[];
  readonlyDates: readonly Date[];
  nested: Array<{ tuple: readonly [Date, { value: string | undefined }] }>;
  object: {
    readonly required: string;
    optional?: number;
    maybe: string | undefined;
    callback: () => void;
    optionalCallback?: () => void;
    mixed: string | (() => void);
    symbolValue: symbol;
    symbolUnion: number | symbol;
    omitted: undefined;
    [hidden]: number;
    nested: { value: Date | undefined; explicitNull: null };
  };
  union: { kind: 'a'; value: string | undefined } | { kind: 'b'; value: number };
  primitives: [string, number, boolean, null];
  neverArray: never[];
};

export const GET = defineHandler(async () => ({
  ...payload,
  names,
  readonlyNames,
  datedPair,
  decorated: Object.assign([new Date()], { total: 1 }),
}));

declare const body: {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => { value: { name: string } };
    readonly types?: { readonly input: { name: string }; readonly output: { name: string } };
  };
};
export const POST = defineHandler.withValidator({ body })((_c, { body }) => ({
  greeting: body.name,
  pair: [body.name, new Date()] as [string, Date],
}));
`,
    'check.ts': `
import { fetch } from 'void/client';

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
declare function assert<T extends true>(): void;

const result = await fetch('/api/serialization');
assert<Equal<typeof result.pairs, [number, number][]>>();
assert<Equal<typeof result.readonlyTuple, readonly [string, string]>>();
assert<Equal<typeof result.empty, []>>();
assert<Equal<typeof result.readonlyEmpty, readonly []>>();
assert<Equal<typeof result.optionalTuple, [label: string, timestamp?: string | null]>>();
assert<Equal<typeof result.restTuple, [number, ...string[]]>>();
assert<Equal<typeof result.readonlyRestTuple, readonly [string, ...string[]]>>();
assert<Equal<typeof result.invalidTuple, [number, null, null, null, string | null]>>();
assert<Equal<typeof result.invalidArray, Array<string | null>>>();
assert<Equal<typeof result.dates, string[]>>();
assert<Equal<typeof result.readonlyDates, readonly string[]>>();
assert<Equal<typeof result.nested, Array<{ tuple: readonly [string, { value?: string }] }>>>();
assert<Equal<typeof result.object, {
  readonly required: string;
  optional?: number;
  maybe?: string;
  mixed?: string;
  symbolUnion?: number;
  nested: { value?: string; explicitNull: null };
}>>();
assert<Equal<typeof result.union, { kind: 'a'; value?: string } | { kind: 'b'; value: number }>>();
assert<Equal<typeof result.primitives, [string, number, boolean, null]>>();
assert<Equal<typeof result.neverArray, never[]>>();
assert<Equal<typeof result.names, string[]>>();
assert<Equal<typeof result.readonlyNames, readonly string[]>>();
assert<Equal<typeof result.datedPair, string[]>>();
assert<Equal<typeof result.decorated, string[]>>();
const names: string[] = result.names.map((name) => name.toUpperCase());
const dates: string[] = result.decorated.map((date) => date.toUpperCase());
// @ts-expect-error readonly arrays retain readonly methods
result.readonlyNames.push('Bob');
// @ts-expect-error JSON omits additional array properties
result.decorated.total;

const pairs: [number, number][] = result.pairs;
// @ts-expect-error tuples retain their length
pairs[0][2];
// @ts-expect-error serialized Dates are strings
result.dates[0].getTime();
// @ts-expect-error function properties are omitted
result.object.callback;
// @ts-expect-error properties that can be omitted require a check
result.object.maybe.toUpperCase();

const posted = await fetch('/api/serialization', { method: 'POST', body: { name: 'Alice' } });
assert<Equal<typeof posted, { greeting: string; pair: [string, string] }>>();
// @ts-expect-error validators still constrain request bodies
await fetch('/api/serialization', { method: 'POST', body: { name: 42 } });
`,
  };

  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const tsc = join(
      dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
      'bin/tsc',
    );
    const result = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
