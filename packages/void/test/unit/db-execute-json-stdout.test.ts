import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vite-plus/test';

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const source = (path: string) =>
  pathToFileURL(join(import.meta.dirname, '..', '..', 'src', path)).href;

const cli = fileURLToPath(new URL('../../dist/cli/cli.mjs', import.meta.url));

it('keeps config and subprocess output off `void db execute --json` stdout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'void-execute-json-stdout-'));
  roots.push(root);
  const preload = join(root, 'preload.cjs');
  writeFileSync(preload, 'globalThis.voidDbPreloaded = true;\n');
  const args = ['--require', preload, cli, 'db', 'execute', '--json'];
  writeFileSync(join(root, 'fork.mjs'), "console.log('fork');\n");
  const harness = join(root, 'harness.mjs');
  writeFileSync(
    harness,
    `import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const { getLocalD1Target } = await import(${JSON.stringify(source('cli/db.ts'))});
const { openSqliteDatabase } = await import(${JSON.stringify(source('migrations/runner.ts'))});
// The database is created before the config exists, so the setup prints nothing.
const { databasePath } = getLocalD1Target(process.cwd());
mkdirSync(dirname(databasePath), { recursive: true });
(await openSqliteDatabase(databasePath)).close();
writeFileSync('void.config.ts', ${JSON.stringify(`import { execFileSync, fork, spawn, spawnSync } from 'node:child_process';
import { writeSync } from 'node:fs';
if (!(globalThis as { voidDbPreloaded?: boolean }).voidDbPreloaded) {
  throw new Error('Node preload missing');
}
const print = (text: string) => ['-e', \`console.log(\${JSON.stringify(text)})\`];
console.log('config');
writeSync(1, 'config fd\\n');
setTimeout(() => writeSync(1, 'later fd\\n'), 10);
execFileSync(process.execPath, print('execFileSync'), { stdio: 'inherit' });
spawnSync(process.execPath, print('spawnSync'), { stdio: [0, process.stdout, 2] });
spawn(process.execPath, print('spawn'), { stdio: ['ignore', 'inherit', 'inherit'] });
fork('fork.mjs');
const warn = (text: string) => ['-e', \`console.log('out'); console.error(\${JSON.stringify(text)})\`];
// A child whose stdout the config reads and whose stderr it sends to stdout.
if (
  execFileSync(process.execPath, warn('stderr to process.stdout'), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', process.stdout],
  }) !== 'out\\n'
) {
  throw new Error('captured output changed');
}
spawnSync(process.execPath, warn('stderr to fd 1'), { stdio: ['ignore', 'ignore', 1] });
spawn(process.execPath, warn('spawn stderr to stdout'), { stdio: ['ignore', 'ignore', process.stdout] });
// Output the config reads is still its own.
if (execFileSync(process.execPath, print('captured'), { encoding: 'utf8' }) !== 'captured\\n') {
  throw new Error('captured output changed');
}
export default {};
`)});
`,
  );

  execFileSync(process.execPath, [harness], { cwd: root });

  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      execFile(
        process.execPath,
        [...args, 'SELECT 1 AS one'],
        { cwd: root, encoding: 'utf8', timeout: 30_000 },
        (error, stdout, stderr) =>
          error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve({ stdout, stderr }),
      );
    },
  );

  expect(JSON.parse(stdout)).toEqual([
    { results: [{ one: 1 }], success: true, meta: expect.any(Object) },
  ]);
  expect(stdout.endsWith(']\n')).toBe(true);
  expect(new Set(stderr.split('\n'))).toEqual(
    new Set([
      'config',
      'config fd',
      'later fd',
      'execFileSync',
      'spawnSync',
      'spawn',
      'fork',
      'stderr to process.stdout',
      'stderr to fd 1',
      'spawn stderr to stdout',
      '',
    ]),
  );
  const failure = spawnSync(process.execPath, [...args, 'SELECT * FROM missing'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(failure.status).toBe(1);
  expect(failure.stdout).toBe('');
  expect(failure.stderr).toContain('no such table: missing');
  expect(failure.stderr).toContain('config fd');
});
