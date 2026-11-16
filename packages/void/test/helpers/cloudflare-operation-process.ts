import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CloudflareOperation } from '@void/deploy-cloudflare';
import { afterEach } from 'vite-plus/test';
import { encodeCloudflareOperation } from '../../src/cli/cloudflare-process.ts';
import { resolveCloudflareOperationArgv } from '../../src/cli/preset.ts';

/** Cleanups run after each test, last registered first. Tests may push their own. */
export const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

export function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Serve on a random local port until the test ends and return the origin. */
export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// Children get only what Node needs, so host credentials cannot leak into a test.
export const systemEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  SYSTEMROOT: process.env.SYSTEMROOT,
  WINDIR: process.env.WINDIR,
  TMP: process.env.TMP,
  TEMP: process.env.TEMP,
  NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
  NODE_DISABLE_COMPILE_CACHE: process.env.NODE_DISABLE_COMPILE_CACHE,
};

export function tokenEnv(
  api?: string,
  token: 'CLOUDFLARE_API_TOKEN' | 'CF_API_TOKEN' = 'CLOUDFLARE_API_TOKEN',
): NodeJS.ProcessEnv {
  return {
    ...systemEnv,
    CI: 'true',
    [token]: 'synthetic-token',
    CLOUDFLARE_ACCOUNT_ID: 'test-account',
    ...(api ? { CLOUDFLARE_API_BASE_URL: `${api}/client/v4` } : {}),
  };
}

/**
 * Run the operation process the CLI spawns. `preload` is imported first to stub cf, and `input`,
 * when given, is written to its stdin.
 */
export function runOperation(
  cwd: string,
  request: CloudflareOperation | Array<string>,
  env: NodeJS.ProcessEnv,
  preload?: string,
  input?: string,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const [command, ...prefix] = resolveCloudflareOperationArgv();
  const args = Array.isArray(request) ? request : encodeCloudflareOperation(request);
  return new Promise((resolve) => {
    const child = execFile(
      command!,
      [...(preload ? ['--import', pathToFileURL(preload).href] : []), ...prefix, ...args],
      { cwd, encoding: 'utf8', timeout: 20_000, maxBuffer: 128 * 1024 * 1024, env },
      (error, stdout, stderr) =>
        resolve({ status: error ? Number(error.code) || 1 : 0, stdout, stderr }),
    );
    if (input !== undefined) {
      child.stdin!.end(input);
    }
  });
}
