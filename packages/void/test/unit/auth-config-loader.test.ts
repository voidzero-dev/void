import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunnableDevEnvironment, createServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AUTH_CONFIG_ENVIRONMENT,
  devAuthConfigImporter,
  loadVoidAuthConfig,
} from '../../src/auth/config.ts';

const tempDirs: Array<string> = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'void-auth-config-'));
  tempDirs.push(dir);
  return dir;
}

describe('loadVoidAuthConfig', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('returns undefined without a config file', async () => {
    const importModule = vi.fn();
    expect(await loadVoidAuthConfig(null, importModule)).toBeUndefined();
    expect(importModule).not.toHaveBeenCalled();
  });

  it.each([
    ['default', "export default { marker: 'default' };", 'default'],
    ['auth', "export const auth = { marker: 'auth' };", 'auth'],
    ['config', "export const config = { marker: 'config' };", 'config'],
  ])('reads the %s export', async (_name, source, marker) => {
    const path = join(createTempDir(), 'auth.ts');
    writeFileSync(path, source);
    expect(await loadVoidAuthConfig(path)).toEqual({ marker });
  });

  it('evaluates the config through the module importer it is given', async () => {
    const importModule = vi.fn(async () => ({ auth: { marker: 'runner' } }));
    expect(await loadVoidAuthConfig('/app/auth.ts', importModule)).toEqual({ marker: 'runner' });
    expect(importModule).toHaveBeenCalledWith('/app/auth.ts');
  });

  it("imports through the dev server's auth config environment when it has one", async () => {
    const dir = createTempDir();
    const path = join(dir, 'auth.ts');
    writeFileSync(path, "export default { marker: 'first' };");
    const server = await createServer({
      root: dir,
      configFile: false,
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, ws: false, watch: null },
      environments: {
        [AUTH_CONFIG_ENVIRONMENT]: {
          consumer: 'server',
          dev: { createEnvironment: (name, config) => createRunnableDevEnvironment(name, config) },
        },
      },
    });
    try {
      const importModule = devAuthConfigImporter(server)!;
      expect(await loadVoidAuthConfig(path, importModule)).toEqual({ marker: 'first' });
    } finally {
      await server.close();
    }
    const plain = await createServer({
      root: dir,
      configFile: false,
      logLevel: 'silent',
      server: { middlewareMode: true, ws: false, watch: null },
    });
    try {
      expect(devAuthConfigImporter(plain)).toBeUndefined();
    } finally {
      await plain.close();
    }
  });
});
