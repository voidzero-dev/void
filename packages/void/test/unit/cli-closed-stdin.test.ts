import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vite-plus/test';

it.each(['ignore', 'pipe'] as const)(
  'exits 1 when db connect reaches EOF on %s stdin',
  (stdin) => {
    const cli = fileURLToPath(new URL('../../dist/cli/cli.mjs', import.meta.url));
    const root = mkdtempSync(join(tmpdir(), 'void-closed-stdin-'));
    try {
      writeFileSync(join(root, 'void.config.ts'), "export default { database: 'pg' };\n");
      const result = spawnSync(process.execPath, [cli, 'db', 'connect', '--local-only'], {
        cwd: root,
        env: { ...process.env, HOME: root, USERPROFILE: root, NO_COLOR: '1' },
        encoding: 'utf8',
        stdio: [stdin, 'pipe', 'pipe'],
        timeout: 20_000,
      });
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain('Standard input closed before the prompt was answered.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
