import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudflareOperation } from '@void/deploy-cloudflare';
import { afterEach, expect, it } from 'vite-plus/test';
import { createDefaultRunWrangler } from '../../src/cli/provision.ts';

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// A stand-in for the operation process: it writes a result envelope unless the
// operation is interactive, which writes to the terminal instead.
async function runWith(operation: CloudflareOperation) {
  const directory = mkdtempSync(join(tmpdir(), 'void-runner-interactive-'));
  directories.push(directory);
  const entry = join(directory, 'operation.mjs');
  writeFileSync(
    entry,
    `const operation = JSON.parse(process.argv[2]);
if (!operation.interactive) {
  process.stdout.write(JSON.stringify({ operationResult: 1, data: { versionId: 'decoded' } }) + '\\n');
}`,
  );
  let child: ChildProcess | undefined;
  const run = createDefaultRunWrangler(directory, {
    launcher: [process.execPath, entry],
    onSpawnedChild: (spawned) => {
      child = spawned;
    },
  });
  const result = await run(operation, { accountId: 'account' });
  return { child: child!, result };
}

it('keeps the default operation process off the terminal', async () => {
  for (const operation of [
    { type: 'versions.upload', configPath: 'wrangler.json' },
    { type: 'worker.deploy', configPath: 'wrangler.json' },
    { type: 'versions.upload', configPath: 'wrangler.json', interactive: false },
  ] as const) {
    const { child, result } = await runWith(operation);
    // stdin 'ignore' has no stream; stdout and stderr are pipes.
    expect(child.stdin).toBeNull();
    expect(child.stdout).not.toBeNull();
    expect(child.stderr).not.toBeNull();
    expect(result.status).toBe(0);
    expect(result.data).toEqual({ versionId: 'decoded' });
  }
});

it('gives only an interactive upload the terminal and reads only its exit status', async () => {
  for (const type of ['versions.upload', 'worker.deploy'] as const) {
    const { child, result } = await runWith({
      type,
      configPath: 'wrangler.json',
      interactive: true,
    });
    // 'inherit' passes this process's streams through, so the child has none of its own.
    expect(child.stdin).toBeNull();
    expect(child.stdout).toBeNull();
    expect(child.stderr).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result).not.toHaveProperty('data');
  }
});
