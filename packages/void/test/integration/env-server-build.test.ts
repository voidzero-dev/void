import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { envSchemaPlugin } from '../../src/plugin-env-schema.ts';

const roots: Array<string> = [];
const runtime = join(import.meta.dirname, '../../src/runtime');
const publicEnvUrl = pathToFileURL(join(runtime, 'env/public.ts')).href;
const runtimeEnvUrl = pathToFileURL(join(runtime, 'env/runtime.ts')).href;

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('production server environment', () => {
  it.each([undefined, 'https://build.example.com'])(
    'uses public build values at boot and during SSR (shell: %s)',
    async (shellValue) => {
      const root = mkdtempSync(join(tmpdir(), 'void-env-server-build-'));
      roots.push(root);
      vi.stubEnv('VITE_ORIGIN', shellValue);
      vi.stubEnv('SERVER_TOKEN', 'build-secret-must-not-be-bundled');
      writeFileSync(join(root, 'package.json'), '{"type":"module"}');
      writeFileSync(join(root, '.env'), 'VITE_ORIGIN=http://localhost:5173\n');
      writeFileSync(
        join(root, 'env.ts'),
        `import { defineEnv, string } from ${JSON.stringify(publicEnvUrl)};
export default defineEnv({
  VITE_ORIGIN: string()${shellValue ? '' : ".default('https://default.example.com')"},
  SERVER_TOKEN: string(),
});`,
      );
      writeFileSync(
        join(root, 'entry.ts'),
        `import './env.ts';
import { env, _validateEnvOnce } from ${JSON.stringify(publicEnvUrl)};
import { withRuntimeEnv } from ${JSON.stringify(runtimeEnvUrl)};
export async function render(values) {
  return withRuntimeEnv(values, async () => {
    const beforeBoot = env.VITE_ORIGIN;
    await _validateEnvOnce(values);
    return { beforeBoot, origin: env.VITE_ORIGIN, token: env.SERVER_TOKEN,
      hasOrigin: 'VITE_ORIGIN' in env, keys: Object.keys(env) };
  });
}`,
      );
      await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [envSchemaPlugin(root)],
        build: {
          ssr: join(root, 'entry.ts'),
          outDir: join(root, 'dist'),
          rollupOptions: {
            external: ['cloudflare:workers'],
            output: { entryFileNames: 'entry.mjs' },
          },
        },
      });

      const entry = join(root, 'dist/entry.mjs');
      expect(readFileSync(entry, 'utf8')).not.toContain('build-secret-must-not-be-bundled');
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { render } from ${JSON.stringify(pathToFileURL(entry).href)};
console.log(JSON.stringify(await render({ SERVER_TOKEN: 'remote-secret' })));`,
        ],
        { encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        beforeBoot: shellValue ?? 'https://default.example.com',
        origin: shellValue ?? 'https://default.example.com',
        token: 'remote-secret',
        hasOrigin: true,
        keys: expect.arrayContaining(['SERVER_TOKEN', 'VITE_ORIGIN']),
      });

      const missingSecret = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { render } from ${JSON.stringify(pathToFileURL(entry).href)};
await render({});`,
        ],
        { encoding: 'utf8' },
      );
      expect(missingSecret.status).not.toBe(0);
      expect(missingSecret.stderr).toContain('SERVER_TOKEN is required but missing');
    },
  );
});
