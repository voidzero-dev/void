import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vite-plus/test';

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const cli = fileURLToPath(new URL('../../dist/cli/cli.mjs', import.meta.url));

function runVoid(root: string, args: Array<string>) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
}

it('keeps config output and failures off `void deploy --json` stdout', () => {
  const root = mkdtempSync(join(tmpdir(), 'void-deploy-json-stdout-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'workerapp' }));
  writeFileSync(
    join(root, 'void.config.ts'),
    `import { writeSync } from 'node:fs';
console.log('config log');
writeSync(1, 'config fd\\n');
export default {};
`,
  );
  mkdirSync(join(root, 'routes'));
  writeFileSync(join(root, 'routes/index.ts'), 'export const GET = () => "hi";\n');

  // A Worker app is refused before any Cloudflare call, after void.config.ts ran.
  const refused = runVoid(root, [
    'deploy',
    '--platform',
    'cloudflare',
    '--preview',
    'pr-1',
    '--json',
  ]);
  expect(refused.status).toBe(1);
  expect(refused.stdout).toBe('');
  expect(refused.stderr).toContain('config log');
  expect(refused.stderr).toContain('config fd');
  expect(refused.stderr).toContain('--preview currently supports static sites');

  const parseError = runVoid(root, ['deploy', '--json']);
  expect(parseError.status).toBe(1);
  expect(parseError.stdout).toBe('');
  expect(parseError.stderr).toContain('--json is available only with --preview');
});
