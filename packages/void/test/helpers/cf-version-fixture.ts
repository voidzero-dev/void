import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, vi } from 'vite-plus/test';
import { prepareCfBuildOutput } from '../../src/cli/cf-build-output.ts';
import { createCfCommand } from '../../src/cli/cf-version-runner.ts';

// Vitest's per-file module isolation gives each suite its own roots and hooks.
const roots: Array<string> = [];
const cleanups: Array<() => unknown> = [];
const pinnedCfVersion = JSON.parse(
  readFileSync(fileURLToPath(import.meta.resolve('cf/package.json')), 'utf8'),
).version as string;
const voidVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  .version as string;
const cfUserAgent: string = `cf-cli/${pinnedCfVersion} void/${voidVersion}`;
// Each real cf subprocess loads cf's bundle before it does any work. That takes about half a
// second when idle and several seconds on a busy machine, which can pass Vitest's 5s default.
const REAL_CF_TIMEOUT_MS: number = process.platform === 'win32' ? 20_000 : 15_000;
const REAL_CF_ACTIVATION_TIMEOUT_MS: number = process.platform === 'win32' ? 60_000 : 30_000;

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Serve a fake Cloudflare API until the test ends and return its base URL. */
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`;
}

/** Compare JSON with its key order, which a deep equality check ignores. */
function expectSameJson(actual: unknown, expected: unknown): void {
  expect(JSON.stringify(actual, null, 2)).toBe(JSON.stringify(expected, null, 2));
}

/** The real pinned cf, whose child sees only a synthetic token and the fake API. */
function pinnedCf(
  apiBaseUrl: string,
  accountId = 'account-id',
  env: NodeJS.ProcessEnv = {},
): ReturnType<typeof createCfCommand> {
  return createCfCommand({
    accountId,
    apiBaseUrl,
    verifyUploader: () => true,
    env: () => ({
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      WINDIR: process.env.WINDIR,
      TMP: process.env.TMP,
      TEMP: process.env.TEMP,
      NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
      NODE_DISABLE_COMPILE_CACHE: process.env.NODE_DISABLE_COMPILE_CACHE,
      CI: 'true',
      CLOUDFLARE_API_TOKEN: 'synthetic-token',
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_API_BASE_URL: apiBaseUrl,
      ...env,
    }),
  });
}

async function output(
  config: Record<string, unknown> = {},
  additionalAsset = false,
): Promise<NonNullable<Awaited<ReturnType<typeof prepareCfBuildOutput>>>> {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-runner-test-'));
  roots.push(root);
  const worker = join(root, 'dist', 'ssr');
  mkdirSync(worker, { recursive: true });
  writeFileSync(join(worker, 'index.js'), 'export default { fetch: () => new Response("ok") };');
  const assets = config.assets as { directory?: string } | undefined;
  if (assets?.directory) {
    const directory = join(worker, assets.directory);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'index.html'), '<h1>Public</h1>');
    if (additionalAsset) {
      writeFileSync(join(directory, 'module.js'), 'export const ready = true;');
      writeFileSync(join(directory, 'style.css'), 'body { color: red; }');
      writeFileSync(join(directory, 'image.png'), Buffer.from([137, 80, 78, 71]));
      writeFileSync(join(directory, 'opaque.unknown'), 'opaque');
    }
    writeFileSync(join(directory, 'private.txt'), 'Never upload this');
    writeFileSync(join(directory, '.assetsignore'), 'private.txt\n');
  }
  writeFileSync(
    join(worker, 'wrangler.json'),
    JSON.stringify({
      name: 'void-test',
      compatibility_date: '2026-09-29',
      main: 'index.js',
      workers_dev: true,
      ...config,
    }),
  );
  const prepared = await prepareCfBuildOutput(worker, 'account-id');
  expect(prepared).not.toBeNull();
  return prepared!;
}

export {
  cfUserAgent,
  cleanups,
  expectSameJson,
  listen,
  output,
  pinnedCf,
  pinnedCfVersion,
  REAL_CF_ACTIVATION_TIMEOUT_MS,
  REAL_CF_TIMEOUT_MS,
  roots,
  voidVersion,
};
