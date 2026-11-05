import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toSlash } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { readConfig } from '../../src/config.ts';
import {
  assertNoRootSourceConventionConflicts,
  readProjectPaths,
  resolvePagesDir,
  resolveProjectPaths,
  validateSourceDir,
} from '../../src/project-paths.ts';

describe('project path resolution', () => {
  let root: string;

  beforeEach(() => {
    root = join(
      tmpdir(),
      `void-project-paths-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeConfig(config: Record<string, unknown>) {
    writeFileSync(join(root, 'void.json'), JSON.stringify(config, null, 2));
  }

  it('keeps existing root conventions when sourceDir is omitted', () => {
    const paths = resolveProjectPaths(root, {});
    expect(paths.sourceDir).toBe('');
    expect(paths.sourceRoot).toBe(root);
    expect(paths.routesDir).toBe(toSlash(join(root, 'routes')));
    expect(paths.pagesDir).toBe(toSlash(join(root, 'pages')));
    expect(paths.middlewareDir).toBe(toSlash(join(root, 'middleware')));
    expect(paths.cronsDir).toBe(toSlash(join(root, 'crons')));
    expect(paths.queuesDir).toBe(toSlash(join(root, 'queues')));
    expect(paths.dbDir).toBe(toSlash(join(root, 'db')));
    expect(paths.migrationsDir).toBe(toSlash(join(root, 'db', 'migrations')));
    expect(paths.schemaFile).toBe(toSlash(join(root, 'db', 'schema.ts')));
    expect(paths.ssrDir).toBe(toSlash(join(root, 'src')));
    expect(paths.sourceRelative('db/migrations')).toBe('db/migrations');
  });

  it('moves Void source conventions under sourceDir', () => {
    const paths = resolveProjectPaths(root, { sourceDir: 'src' });
    expect(paths.sourceDir).toBe('src');
    expect(paths.sourceRoot).toBe(toSlash(join(root, 'src')));
    expect(paths.routesDir).toBe(toSlash(join(root, 'src', 'routes')));
    expect(paths.pagesDir).toBe(toSlash(join(root, 'src', 'pages')));
    expect(paths.middlewareDir).toBe(toSlash(join(root, 'src', 'middleware')));
    expect(paths.cronsDir).toBe(toSlash(join(root, 'src', 'crons')));
    expect(paths.queuesDir).toBe(toSlash(join(root, 'src', 'queues')));
    expect(paths.dbDir).toBe(toSlash(join(root, 'src', 'db')));
    expect(paths.migrationsDir).toBe(toSlash(join(root, 'src', 'db', 'migrations')));
    expect(paths.schemaFile).toBe(toSlash(join(root, 'src', 'db', 'schema.ts')));
    expect(paths.ssrDir).toBe(toSlash(join(root, 'src')));
    expect(paths.sourceRelative('db/migrations')).toBe('src/db/migrations');
  });

  it('supports arbitrary nested source directories', () => {
    const paths = resolveProjectPaths(root, { sourceDir: 'app/server' });
    expect(paths.routesDir).toBe(toSlash(join(root, 'app', 'server', 'routes')));
    expect(paths.pagesDir).toBe(toSlash(join(root, 'app', 'server', 'pages')));
    expect(paths.schemaDir).toBe(toSlash(join(root, 'app', 'server', 'db', 'schema')));
    expect(paths.sourceRelative('routes/api')).toBe('app/server/routes/api');
  });

  it('reads sourceDir from root void.json', () => {
    writeConfig({ sourceDir: 'src' });
    expect(readProjectPaths(root).pagesDir).toBe(toSlash(join(root, 'src', 'pages')));
    expect(resolvePagesDir(root)).toBe(toSlash(join(root, 'src', 'pages')));
  });

  it('keeps env.ts back compat candidates when sourceDir is omitted', () => {
    const paths = resolveProjectPaths(root, {});
    expect(paths.envFileCandidates).toEqual([
      toSlash(join(root, 'env.ts')),
      toSlash(join(root, 'env.mts')),
      toSlash(join(root, 'env.js')),
      toSlash(join(root, 'env.mjs')),
      toSlash(join(root, 'src', 'env.ts')),
      toSlash(join(root, 'src', 'env.mts')),
      toSlash(join(root, 'src', 'env.js')),
      toSlash(join(root, 'src', 'env.mjs')),
    ]);
  });

  it('uses only sourceDir env.ts candidates when sourceDir is configured', () => {
    const paths = resolveProjectPaths(root, { sourceDir: 'app' });
    expect(paths.envFileCandidates).toEqual([
      toSlash(join(root, 'app', 'env.ts')),
      toSlash(join(root, 'app', 'env.mts')),
      toSlash(join(root, 'app', 'env.js')),
      toSlash(join(root, 'app', 'env.mjs')),
    ]);
  });

  it('validates sourceDir shape', () => {
    expect(validateSourceDir('src')).toBe('src');
    expect(validateSourceDir('src/feature')).toBe('src/feature');
    for (const value of [
      '',
      ' src',
      'src ',
      '.',
      './',
      '..',
      '../src',
      'src/../app',
      'src/..',
      '/src',
    ]) {
      expect(() => validateSourceDir(value)).toThrow(/relative directory/);
    }
  });

  it('validates sourceDir through readConfig', () => {
    writeConfig({ sourceDir: 'src' });
    expect(readConfig(root).sourceDir).toBe('src');

    writeConfig({ sourceDir: '../src' });
    expect(() => readConfig(root)).toThrow(/sourceDir/);
  });

  it('validates sourceDir through readProjectPaths', () => {
    writeConfig({ sourceDir: 'src/..' });
    expect(() => readProjectPaths(root)).toThrow(/sourceDir/);

    writeConfig({ sourceDir: './' });
    expect(() => readProjectPaths(root)).toThrow(/sourceDir/);
  });

  it('does not report conflicts when sourceDir is omitted', () => {
    mkdirSync(join(root, 'routes'), { recursive: true });
    mkdirSync(join(root, 'src', 'routes'), { recursive: true });
    expect(() =>
      assertNoRootSourceConventionConflicts(resolveProjectPaths(root, {})),
    ).not.toThrow();
  });

  it('fails when root and source conventions both exist with sourceDir', () => {
    mkdirSync(join(root, 'routes'), { recursive: true });
    mkdirSync(join(root, 'src', 'routes'), { recursive: true });
    mkdirSync(join(root, 'db'), { recursive: true });
    mkdirSync(join(root, 'src', 'db'), { recursive: true });

    expect(() =>
      assertNoRootSourceConventionConflicts(resolveProjectPaths(root, { sourceDir: 'src' })),
    ).toThrow(/routes, db/);
  });

  describe.each(['void.config.ts', 'void.json'] as const)('errors from %s', (file) => {
    function writeConfigFile(config: Record<string, unknown>) {
      const contents = JSON.stringify(config);
      writeFileSync(
        join(root, file),
        file === 'void.json' ? contents : `export default ${contents};\n`,
      );
    }

    it.each([
      [' src', `config: "sourceDir" in ${file} must be a non-empty relative directory.`],
      ['../src', `config: "sourceDir" path '../src' in ${file} must be a relative directory.`],
      ['./', `config: "sourceDir" path './' in ${file} must be a relative directory.`],
    ])('names the file when sourceDir is %j', (sourceDir, message) => {
      writeConfigFile({ sourceDir });
      expect(() => readProjectPaths(root)).toThrow(message);
      expect(() => readConfig(root)).toThrow(message);
    });

    it('names the file when source conventions conflict', () => {
      writeConfigFile({ sourceDir: 'src' });
      mkdirSync(join(root, 'routes'), { recursive: true });
      mkdirSync(join(root, 'src', 'routes'), { recursive: true });

      expect(() => assertNoRootSourceConventionConflicts(readProjectPaths(root))).toThrow(
        `sourceDir: ${file} sets "sourceDir": "src"`,
      );
    });
  });

  it('names void.config.ts when no config file exists', () => {
    mkdirSync(join(root, 'routes'), { recursive: true });
    mkdirSync(join(root, 'src', 'routes'), { recursive: true });

    expect(() => resolveProjectPaths(root, { sourceDir: '../src' })).toThrow(
      `config: "sourceDir" path '../src' in void.config.ts must be a relative directory.`,
    );
    expect(() =>
      assertNoRootSourceConventionConflicts(resolveProjectPaths(root, { sourceDir: 'src' })),
    ).toThrow('sourceDir: void.config.ts sets "sourceDir": "src"');
  });

  it('does not treat project-root config and public files as source conflicts', () => {
    writeConfig({ sourceDir: 'src' });
    mkdirSync(join(root, 'public'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'vite.config.ts'), 'export default {};');
    writeFileSync(join(root, 'package.json'), '{}');

    expect(() => assertNoRootSourceConventionConflicts(readProjectPaths(root))).not.toThrow();
    expect(existsSync(join(root, 'void.json'))).toBe(true);
  });
});
