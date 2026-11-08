import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vite-plus/test';

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..');
const CLI_ENTRY = join(PACKAGE_ROOT, 'dist', 'cli', 'cli.mjs');
const ENV_PUBLIC_DIST = join(PACKAGE_ROOT, 'dist', 'runtime', 'env-public.mjs');

const roots: Array<string> = [];

function createProject(options: { withSources?: boolean; sourceDir?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'void-prepare-cli-'));
  roots.push(root);

  if (options.sourceDir) {
    writeFileSync(join(root, 'void.json'), JSON.stringify({ sourceDir: options.sourceDir }));
  }

  if (options.withSources) {
    const envPublicUrl = pathToFileURL(ENV_PUBLIC_DIST).href;
    const sourceRoot = options.sourceDir ? join(root, options.sourceDir) : root;
    mkdirSync(join(sourceRoot, 'routes', 'api'), { recursive: true });
    mkdirSync(join(sourceRoot, 'db'), { recursive: true });
    writeFileSync(
      join(sourceRoot, 'env.ts'),
      `import { defineEnv, string } from "${envPublicUrl}";\n` +
        'export default defineEnv({ API_KEY: string() });\n',
    );
    writeFileSync(
      join(sourceRoot, 'routes', 'api', 'hello.ts'),
      'export const GET = { __validators: {}, __output: {} };\n',
      { encoding: 'utf8' },
    );
    writeFileSync(join(sourceRoot, 'db', 'schema.ts'), 'export const users = {};\n', {
      encoding: 'utf8',
    });
  }

  return root;
}

function runVoid(
  root: string,
  args: Array<string>,
): { stdout: string; stderr: string; status: number } {
  const res = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: root,
      USERPROFILE: root,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
    },
  });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status ?? 1,
  };
}

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('void prepare (subprocess)', () => {
  it('generates custom binding types and removes them when switching targets', () => {
    const root = createProject();
    const config = {
      cloudflare: {
        ratelimits: [{ name: 'LIMITER', namespace_id: '1001', simple: { limit: 10, period: 60 } }],
      },
    };
    writeFileSync(join(root, 'void.json'), JSON.stringify(config));
    const first = runVoid(root, ['prepare']);
    expect(first.status, first.stderr).toBe(0);
    expect(existsSync(join(root, '.void/bindings.d.ts'))).toBe(true);
    expect(readFileSync(join(root, '.void/bindings.d.ts'), 'utf8')).toContain(
      '"LIMITER": RateLimit;',
    );
    expect(JSON.parse(readFileSync(join(root, '.void/tsconfig.json'), 'utf8')).files).toContain(
      'bindings.d.ts',
    );
    writeFileSync(join(root, 'void.json'), JSON.stringify({ ...config, target: 'node' }));
    const second = runVoid(root, ['prepare']);
    expect(second.status, second.stderr).toBe(0);
    expect(existsSync(join(root, '.void/bindings.d.ts'))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, '.void/tsconfig.json'), 'utf8')).files).not.toContain(
      'bindings.d.ts',
    );
  });

  it('generates project-local .void files without starting Vite', () => {
    const root = createProject({ withSources: true });
    const { stdout, status } = runVoid(root, ['prepare']);

    expect(status).toBe(0);
    expect(stdout).toContain('Project codegen is ready');

    const outDir = join(root, '.void');
    const routesDts = join(outDir, 'routes.d.ts');
    const dbDts = join(outDir, 'db.d.ts');
    const envDts = join(outDir, 'env.d.ts');
    const tsconfig = join(outDir, 'tsconfig.json');

    expect(existsSync(routesDts)).toBe(true);
    expect(existsSync(dbDts)).toBe(true);
    expect(existsSync(envDts)).toBe(true);
    expect(existsSync(tsconfig)).toBe(true);

    expect(readFileSync(routesDts, 'utf8')).toContain('typeof import("../routes/api/hello.ts")');
    expect(readFileSync(dbDts, 'utf8')).toContain('import type * as schema from "@schema"');
    expect(readFileSync(envDts, 'utf8')).toContain('declare module "void/env"');

    const parsedTsconfig = JSON.parse(readFileSync(tsconfig, 'utf8')) as {
      files: Array<string>;
      compilerOptions?: { paths?: Record<string, Array<string>> };
    };
    expect(parsedTsconfig.files).toEqual(
      expect.arrayContaining(['routes.d.ts', 'db.d.ts', 'env.d.ts']),
    );
    expect(parsedTsconfig.compilerOptions?.paths?.['void/routes']).toEqual(['./routes.d.ts']);
    expect(parsedTsconfig.compilerOptions?.paths?.['void/db']).toEqual(['./db.d.ts']);
  });

  it('still prepares tsconfig when no generated source inputs exist', () => {
    const root = createProject();
    const { stdout, status } = runVoid(root, ['prepare']);

    expect(status).toBe(0);
    expect(stdout).toContain('.void/tsconfig.json');
    expect(existsSync(join(root, '.void', 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(root, '.void', 'routes.d.ts'))).toBe(false);
    expect(existsSync(join(root, '.void', 'db.d.ts'))).toBe(false);
    expect(existsSync(join(root, '.void', 'env.d.ts'))).toBe(false);
  });

  it('writes every file that .void/tsconfig.json lists when queues/ has only helper files', () => {
    const root = createProject({ withSources: true });
    mkdirSync(join(root, 'queues'));
    writeFileSync(join(root, 'queues', '_shared.ts'), 'export const helper = 1;\n');

    const { status } = runVoid(root, ['prepare']);

    expect(status).toBe(0);

    const outDir = join(root, '.void');
    const tsconfig = JSON.parse(readFileSync(join(outDir, 'tsconfig.json'), 'utf8')) as {
      files: Array<string>;
      compilerOptions?: { paths?: Record<string, Array<string>> };
    };
    expect(tsconfig.files).toContain('queues.d.ts');
    for (const file of tsconfig.files) {
      expect(existsSync(join(outDir, file)), file).toBe(true);
    }
    for (const targets of Object.values(tsconfig.compilerOptions?.paths ?? {})) {
      for (const target of targets.filter((path) => path.startsWith('./'))) {
        expect(existsSync(join(outDir, target)), target).toBe(true);
      }
    }
    expect(readFileSync(join(outDir, 'queues.d.ts'), 'utf8')).toContain(
      'export interface QueueMap',
    );
  });

  it('generates project-local files from sourceDir conventions', () => {
    const root = createProject({ withSources: true, sourceDir: 'src' });
    mkdirSync(join(root, 'routes', 'api'), { recursive: true });
    writeFileSync(join(root, 'routes', 'api', 'ignored.ts'), 'export const GET = {};\n');

    const { stdout, status } = runVoid(root, ['prepare']);

    expect(status).toBe(0);
    expect(stdout).toContain('Project codegen is ready');

    const outDir = join(root, '.void');
    const routesDts = readFileSync(join(outDir, 'routes.d.ts'), 'utf8');
    const envDts = readFileSync(join(outDir, 'env.d.ts'), 'utf8');
    const tsconfig = JSON.parse(readFileSync(join(outDir, 'tsconfig.json'), 'utf8')) as {
      compilerOptions?: { paths?: Record<string, Array<string>> };
    };

    expect(routesDts).toContain('typeof import("../src/routes/api/hello.ts")');
    expect(routesDts).not.toContain('ignored.ts');
    expect(envDts).toContain('typeof import("../src/env.ts")');
    expect(tsconfig.compilerOptions?.paths?.['@schema']).toEqual(['../src/db/schema.ts']);
    expect(tsconfig.compilerOptions?.paths?.['@schema/*']).toEqual(['../src/db/schema/*']);
  });
});
