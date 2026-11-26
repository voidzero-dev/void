import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { outro } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { packageFixturePath } from '../../../../test/fixture-dir.ts';
import { getLocalD1Target, runDbCommand } from '../../src/cli/db.ts';
import { collectMigrations } from '../../src/migrations/collect.ts';
import { openSqliteDatabase } from '../../src/migrations/runner.ts';

let root: string;

vi.mock('../../src/cli/yarn-pnp.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/yarn-pnp.ts')>()),
  get drizzleKitBin() {
    return join(root, 'drizzle-kit.cjs');
  },
}));

vi.mock('@voidzero-dev/vite-plus-prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voidzero-dev/vite-plus-prompts')>()),
  outro: vi.fn(),
}));

function stubDrizzle(stdout: string, stderr = '', status = 0): void {
  writeFileSync(
    join(root, 'drizzle-kit.cjs'),
    `process.stdout.write(${JSON.stringify(stdout)});
const error = ${JSON.stringify(stderr)};
if (error) console.error(error);
process.exit(${status});`,
  );
}

async function useInstalledDrizzleKit(): Promise<void> {
  const { drizzleKitBin } = await vi.importActual<typeof import('../../src/cli/yarn-pnp.ts')>(
    '../../src/cli/yarn-pnp.ts',
  );
  writeFileSync(
    join(root, 'drizzle-kit.cjs'),
    `Object.defineProperty(process.stdin, 'isTTY', { value: false });
require(${JSON.stringify(drizzleKitBin)});`,
  );
}

function writeSchema(table: string): void {
  writeFileSync(
    join(root, 'db/schema.ts'),
    `import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
export const table = sqliteTable('${table}', { id: integer('id').primaryKey() });
`,
  );
}

const drizzleTimeout = process.platform === 'win32' ? 30_000 : 10_000;

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(packageFixturePath(import.meta.dirname, 'void-db-drizzle-'));
  mkdirSync(join(root, 'db'));
  writeSchema('items');
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit:${code}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('void db push', () => {
  const successMessage = expect.stringContaining('Database schema pushed.');

  it.each([
    ['a declined prompt', '[\u001b[31mx\u001b[0m] All changes were aborted\n', ''],
    ['a missing terminal', '', 'Error: Interactive prompts require a TTY terminal\n'],
  ])('fails on %s even when Drizzle Kit exits 0', async (_reason, stdout, stderr) => {
    stubDrizzle(stdout, stderr);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runDbCommand(root, { action: 'push' })).rejects.toThrow('process.exit:1');
    expect(error).toHaveBeenCalledExactlyOnceWith(
      'Database schema push did not complete. For prompts, run `void db push` in a terminal. To review changes, use `void db generate` and `void db migrate`.',
    );
    expect(outro).not.toHaveBeenCalledWith(successMessage, expect.anything());
  });

  it('exits successfully when the database is already up to date', async () => {
    stubDrizzle('\n[\u001b[34mi\u001b[0m] No changes detected\n');

    await runDbCommand(root, { action: 'push' });
    expect(outro).not.toHaveBeenCalledWith(successMessage, expect.anything());
  });

  it('fails when Drizzle Kit exits nonzero after printing a completion message', async () => {
    stubDrizzle('[i] No changes detected\n', '', 2);

    await expect(runDbCommand(root, { action: 'push' })).rejects.toThrow('process.exit:1');
    expect(outro).not.toHaveBeenCalledWith(successMessage, expect.anything());
  });

  it.each(['_void_migrations', '_migrations'])(
    'preserves rows in the %s journal when adding a table',
    { timeout: drizzleTimeout },
    async (journal) => {
      await useInstalledDrizzleKit();
      const { databasePath } = getLocalD1Target(root);
      mkdirSync(dirname(databasePath), { recursive: true });
      const db = await openSqliteDatabase(databasePath);
      try {
        db.exec(`
          CREATE TABLE ${journal} (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
          INSERT INTO ${journal} VALUES ('0000_init.sql', '2026-01-01');
        `);
        await runDbCommand(root, { action: 'push' });
        expect(outro).toHaveBeenCalledWith(successMessage, expect.anything());
        expect(db.prepare(`SELECT * FROM ${journal}`).all()).toEqual([
          { name: '0000_init.sql', applied_at: '2026-01-01' },
        ]);
        expect(db.prepare('SELECT * FROM items').all()).toEqual([]);
      } finally {
        db.close();
      }
    },
  );
});

describe('void db generate', () => {
  it(
    'generates SQL, succeeds on an unchanged schema, and fails when a rename needs a TTY',
    {
      timeout: drizzleTimeout,
    },
    async () => {
      await useInstalledDrizzleKit();
      const migrations = join(root, 'db/migrations');
      const successMessage = expect.stringContaining('Migration generation complete.');

      await runDbCommand(root, { action: 'generate' });
      const files = collectMigrations(migrations);
      expect(files).toHaveLength(1);
      expect(outro).toHaveBeenCalledWith(successMessage, expect.anything());

      await runDbCommand(root, { action: 'generate' });
      expect(collectMigrations(migrations)).toEqual(files);

      vi.mocked(outro).mockClear();
      writeSchema('inventory');
      await expect(runDbCommand(root, { action: 'generate' })).rejects.toThrow('process.exit:1');
      expect(outro).not.toHaveBeenCalledWith(successMessage, expect.anything());
      expect(collectMigrations(migrations)).toEqual(files);
    },
  );
});
