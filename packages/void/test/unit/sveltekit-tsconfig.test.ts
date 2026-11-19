import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toSlash } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { packageFixturePath } from '../../../../test/fixture-dir.ts';
import ts from '../../../../test/fixtures/sveltekit-v2/compiler.ts';
import { mergeVoidSvelteKitTsconfig, withVoidTSConfig } from '../../src/sveltekit.ts';

const TMP = packageFixturePath(import.meta.dirname, '.tmp-sveltekit-tsconfig-test');
const generatedPath = (...parts: Array<string>) => toSlash(join(TMP, ...parts));

beforeEach(() => {
  mkdirSync(join(TMP, '.void'), { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('mergeVoidSvelteKitTsconfig', () => {
  it('merges Void files and paths into SvelteKit generated config', () => {
    writeFileSync(
      join(TMP, '.void', 'tsconfig.json'),
      JSON.stringify(
        {
          files: ['db.d.ts', 'env.d.ts'],
          compilerOptions: {
            paths: {
              'void/db': ['./db.d.ts'],
              '@schema': ['../db/schema.ts'],
              '@schema/*': ['../db/schema/*'],
            },
          },
        },
        null,
        2,
      ),
    );

    const config = mergeVoidSvelteKitTsconfig(
      {
        compilerOptions: {
          paths: {
            '$app/types': ['./types/index.d.ts'],
          },
        },
        files: ['ambient.d.ts'],
      },
      { root: TMP },
    );

    expect(config.files).toEqual([
      'ambient.d.ts',
      generatedPath('.void/db.d.ts'),
      generatedPath('.void/env.d.ts'),
    ]);
    expect((config.compilerOptions as { paths?: Record<string, Array<string>> }).paths).toEqual({
      '$app/types': ['./types/index.d.ts'],
      'void/db': [generatedPath('.void/db.d.ts')],
      '@schema': [generatedPath('db/schema.ts')],
      '@schema/*': [generatedPath('db/schema/*')],
    });
  });

  it.each(['.svelte-kit', 'node_modules/$app', '.custom-kit'])(
    'resolves declarations and schema imports from a config in %s',
    (configDir) => {
      mkdirSync(join(TMP, configDir), { recursive: true });
      mkdirSync(join(TMP, 'db'), { recursive: true });
      writeFileSync(join(TMP, '.void/db.d.ts'), 'export declare const db: unknown;');
      writeFileSync(join(TMP, '.void/env.d.ts'), 'export {};');
      writeFileSync(join(TMP, 'db/schema.ts'), 'export const users = {};');
      writeFileSync(
        join(TMP, '.void/tsconfig.json'),
        JSON.stringify({
          files: ['db.d.ts', 'env.d.ts'],
          compilerOptions: {
            paths: { 'void/db': ['./db.d.ts'], '@schema': ['../db/schema.ts'] },
          },
        }),
      );
      const config = mergeVoidSvelteKitTsconfig(
        { compilerOptions: { moduleResolution: 'bundler', module: 'esnext' } },
        { root: TMP },
      );
      const parsed = ts.parseJsonConfigFileContent(config, ts.sys, join(TMP, configDir));
      expect(parsed.errors).toEqual([]);
      expect(parsed.fileNames).toEqual([
        generatedPath('.void/db.d.ts'),
        generatedPath('.void/env.d.ts'),
      ]);
      for (const [name, file] of [
        ['void/db', '.void/db.d.ts'],
        ['@schema', 'db/schema.ts'],
      ]) {
        expect(
          ts.resolveModuleName(name!, join(TMP, 'src/page.ts'), parsed.options, ts.sys)
            .resolvedModule?.resolvedFileName,
        ).toBe(generatedPath(file!));
      }
    },
  );

  it('is a no-op when Void tsconfig has not been generated yet', () => {
    rmSync(join(TMP, '.void'), { recursive: true, force: true });
    const config = { compilerOptions: { paths: { '$app/types': ['./types/index.d.ts'] } } };

    expect(mergeVoidSvelteKitTsconfig(config, { root: TMP })).toBe(config);
    expect(config).toEqual({
      compilerOptions: { paths: { '$app/types': ['./types/index.d.ts'] } },
    });
  });

  it('composes with an existing SvelteKit tsconfig hook', () => {
    writeFileSync(
      join(TMP, '.void', 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          paths: {
            'void/db': ['./db.d.ts'],
          },
        },
      }),
    );

    const hook = withVoidTSConfig(
      (config) => {
        config.files = ['custom.d.ts'];
      },
      { root: TMP },
    );

    expect(hook({})).toEqual({
      files: ['custom.d.ts'],
      compilerOptions: {
        paths: {
          'void/db': [generatedPath('.void/db.d.ts')],
        },
      },
    });
  });
});
