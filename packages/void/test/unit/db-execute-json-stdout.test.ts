import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vite-plus/test';

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const source = (path: string) =>
  pathToFileURL(join(import.meta.dirname, '..', '..', 'src', path)).href;

// Child processes write to the process's own stdout, which only a real process can observe.
it('keeps the stdout of processes that void.config.ts starts off `void db execute --json` stdout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'void-execute-json-stdout-'));
  roots.push(root);
  writeFileSync(join(root, 'fork.mjs'), "console.log('fork');\n");
  const harness = join(root, 'harness.mjs');
  writeFileSync(
    harness,
    `import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const { getLocalD1Target, runDbCommand } = await import(${JSON.stringify(source('cli/db.ts'))});
const { openSqliteDatabase } = await import(${JSON.stringify(source('migrations/runner.ts'))});
// The database is created before the config exists, so the setup prints nothing.
const { databasePath } = getLocalD1Target(process.cwd());
mkdirSync(dirname(databasePath), { recursive: true });
(await openSqliteDatabase(databasePath)).close();
writeFileSync('void.config.ts', ${JSON.stringify(`import { execFileSync, fork, spawn, spawnSync } from 'node:child_process';
const print = (text: string) => ['-e', \`console.log(\${JSON.stringify(text)})\`];
console.log('config');
execFileSync(process.execPath, print('execFileSync'), { stdio: 'inherit' });
spawnSync(process.execPath, print('spawnSync'), { stdio: [0, process.stdout, 2] });
spawn(process.execPath, print('spawn'), { stdio: ['ignore', 'inherit', 'inherit'] });
fork('fork.mjs');
// Output the config reads is still its own.
if (execFileSync(process.execPath, print('captured'), { encoding: 'utf8' }) !== 'captured\\n') {
  throw new Error('captured output changed');
}
export default {};
`)});
await runDbCommand(process.cwd(), { action: 'execute', command: 'SELECT 1 AS one', json: true });
`,
  );

  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      execFile(
        process.execPath,
        [harness],
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
    new Set(['config', 'execFileSync', 'spawnSync', 'spawn', 'fork', '']),
  );
});
