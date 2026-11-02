import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vite-plus/test';

const packageRoot = join(import.meta.dirname, '../..');
const cliEntry = join(packageRoot, 'dist/cli/cli.mjs');
const envPublicUrl = pathToFileURL(join(packageRoot, 'dist/runtime/env-public.mjs')).href;
const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['', 'true'])('rejects secret sync with closed stdin and CI=%s', (ci) => {
  const root = mkdtempSync(join(tmpdir(), 'void-secret-cli-'));
  roots.push(root);
  mkdirSync(join(root, '.void'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(root, '.void/project.json'), '{"platform":"cloudflare"}\n');
  writeFileSync(
    join(root, 'void.config.ts'),
    'export default { cloudflare: { name: "test-worker", account_id: "test-account" } };\n',
  );
  writeFileSync(
    join(root, 'env.ts'),
    `import { defineEnv, string } from ${JSON.stringify(envPublicUrl)};\n` +
      'export default defineEnv({ API_TOKEN: string() });\n',
  );
  const file = join(root, 'production.env');
  writeFileSync(file, 'API_TOKEN=test-secret-value\n');

  const result = spawnSync(process.execPath, [cliEntry, 'secret', 'sync', file], {
    cwd: root,
    input: '',
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: root,
      USERPROFILE: root,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      CI: ci,
      CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:1',
    },
  });

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stdout + result.stderr).toBe(1);
  const output = result.stdout + result.stderr;
  expect(output).toContain('--yes');
  expect(output).not.toContain('Continue?');
  expect(output).not.toContain('Synced');
  expect(output).not.toContain('test-secret-value');
});
