import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { toSlash } from 'pathslash';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';
import { collectPrerenderPaths } from '../../src/prerender.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SOURCE_PLAYGROUND = 'playground/kitchen-sink';
let playground: IsolatedPlayground;
let dist: string;

let buildOutput = '';

describe('playground/kitchen-sink build', () => {
  beforeAll(() => {
    playground = createIsolatedPlayground(ROOT, SOURCE_PLAYGROUND);
    const pg = playground.root;
    dist = join(pg, 'dist');

    rmSync(join(pg, 'dist'), { recursive: true, force: true });
    rmSync(join(pg, '.void'), { recursive: true, force: true });

    mkdirSync(join(pg, '.void'), { recursive: true });
    writeFileSync(
      join(pg, '.void', 'project.json'),
      JSON.stringify({ projectId: 'test-leak-project-id', slug: 'test-leak' }),
    );

    // Build this fixture directly. Other suites create and remove temporary
    // workspace packages concurrently, so rediscovering the whole task graph
    // adds an unrelated race to a test of Vite's emitted worker artifacts.
    const result = spawn.sync('vp', ['build'], {
      cwd: pg,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        VOID_TOKEN: 'test-leak-token-do-not-use',
        VOID_CLOUDFLARE_DEPLOY_BUILD: '1',
        VITE_APP_TITLE: 'Kitchen Sink Production',
      },
    });

    buildOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.status, buildOutput).toBe(0);
  });

  afterAll(() => {
    playground?.cleanup();
  });
  it('emits the SSR worker entry', () => {
    expect(existsSync(join(dist, 'ssr/index.js'))).toBe(true);
  });

  it('discovers prerender paths without remote production secrets', async () => {
    await expect(
      collectPrerenderPaths({
        root: playground.root,
        workerDir: join(dist, 'ssr'),
        persistDir: join(playground.root, '.void'),
        projectId: 'test-leak-project-id',
        voidToken: '',
      }),
    ).resolves.toEqual([]);
  });

  it('does not warn about unexpected Node.js imports', () => {
    expect(buildOutput).not.toContain('Unexpected Node.js imports for environment "ssr"');
    expect(buildOutput).not.toContain('pg-pool');
  });

  it('does not emit deploy-blocking top-level await in env or db runtime chunks', () => {
    const jsFiles = collectFiles(join(dist, 'ssr')).filter((file) => file.endsWith('.js'));
    const runtimeFiles = jsFiles.filter(
      (file) => /\/env-[^/]+\.js$/.test(file) || /\/_virtual_void-db-[^/]+\.js$/.test(file),
    );

    expect(runtimeFiles.length).toBeGreaterThan(0);

    for (const file of runtimeFiles) {
      expect(readFileSync(file, 'utf8')).not.toContain('await import(');
    }
  });

  it('does not leak __VOID_* credentials into dist/ssr/wrangler.json', () => {
    const wranglerConfig = JSON.parse(readFileSync(join(dist, 'ssr', 'wrangler.json'), 'utf-8'));
    const vars = (wranglerConfig.vars ?? {}) as Record<string, unknown>;
    // These are legitimate, non-credential runtime routing vars for a custom Workers AI
    // or Images binding / AI Gateway. Exclude them from the credential leak filter.
    const allowedRuntimeMarkers = new Set([
      '__VOID_AI_BINDING',
      '__VOID_AI_GATEWAY',
      '__VOID_IMAGES_BINDING',
    ]);
    const leakedKeys = Object.keys(vars).filter(
      (key) => key.startsWith('__VOID_') && !allowedRuntimeMarkers.has(key),
    );
    expect(leakedKeys).toEqual([]);
  });

  it('binds Workers AI and emits the AI Gateway var for self-host deploys', () => {
    const wranglerConfig = JSON.parse(readFileSync(join(dist, 'ssr', 'wrangler.json'), 'utf-8'));
    // kitchen-sink imports `void/ai` at request time, so the build infers
    // `needsAI` and injects the Workers AI binding on `command === 'build'`.
    expect(wranglerConfig.ai).toEqual({ binding: 'AI' });
    // `ai.gateway` in playground/kitchen-sink/void.config.ts becomes the runtime var
    // read by the direct Workers AI backend.
    const vars = (wranglerConfig.vars ?? {}) as Record<string, unknown>;
    expect(vars.__VOID_AI_GATEWAY).toBe('kitchen-sink-gw');
  });

  it('does not ship local .env values and declares required server secrets', () => {
    const wranglerConfig = JSON.parse(readFileSync(join(dist, 'ssr', 'wrangler.json'), 'utf-8'));
    const vars = (wranglerConfig.vars ?? {}) as Record<string, unknown>;
    expect(vars.APP_NAME).toBeUndefined();
    expect(vars.SECRET_KEY).toBeUndefined();
    expect(vars.API_URL).toBeUndefined();
    expect(vars.VITE_APP_TITLE).toBeUndefined();
    expect(wranglerConfig.secrets?.required).toEqual([
      'APP_NAME',
      'SECRET_KEY',
      'API_URL',
      'BETTER_AUTH_SECRET',
    ]);
    expect(vars.BETTER_AUTH_SECRET).toBeUndefined();
  });

  it('includes sandbox bindings and container metadata', () => {
    const wranglerConfig = JSON.parse(readFileSync(join(dist, 'ssr', 'wrangler.json'), 'utf-8'));
    expect(wranglerConfig.compatibility_flags).toContain('nodejs_compat');
    expect(wranglerConfig.durable_objects.bindings).toContainEqual({
      name: 'SANDBOX',
      class_name: 'SandboxV1',
    });
    expect(wranglerConfig.containers).toEqual([
      expect.objectContaining({
        name: 'void-sandbox-v1',
        class_name: 'SandboxV1',
      }),
    ]);
    expect(wranglerConfig.migrations).toContainEqual({
      tag: 'void-sandbox-v2',
      new_sqlite_classes: ['SandboxV1'],
    });
  });
});

function collectFiles(dir: string): Array<string> {
  const files: Array<string> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = toSlash(join(dir, entry.name));
    if (entry.isDirectory()) {
      files.push(...collectFiles(entryPath));
    } else {
      files.push(entryPath);
    }
  }
  return files;
}
