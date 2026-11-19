import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { packageFixturePath } from '../../../../test/fixture-dir.ts';
import { generateValidatedSqliteMigrations } from '../../src/drizzle/generate.ts';
import { collectMigrations } from '../../src/migrations/collect.ts';
import { openMigrationValidationDatabase } from '../../src/migrations/sqlite-validation.ts';

const roots: Array<string> = [];
function fixture(): string {
  const root = mkdtempSync(packageFixturePath(import.meta.dirname, 'tmp-drizzle-generate-'));
  roots.push(root);
  return root;
}

function files(root: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => [
        join(entry.parentPath, entry.name),
        readFileSync(join(entry.parentPath, entry.name)).toString('base64'),
      ]),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('SQLite migration generation', () => {
  // This exercises three Drizzle Kit CLI runs, which can exceed the default timeout on Windows CI.
  it('rolls back SQL, journal and snapshots when Drizzle copies a newly added column from the old table', async () => {
    const root = fixture();
    const migrations = join(root, 'migrations');
    const schema = join(root, 'schema.ts');
    const config = join(root, 'drizzle.config.json');
    writeFileSync(
      config,
      JSON.stringify({ dialect: 'sqlite', schema: './schema.ts', out: './migrations' }),
    );
    const generate = () => {
      execFileSync(
        process.execPath,
        [
          join(fileURLToPath(import.meta.resolve('drizzle-kit')), '..', 'bin.cjs'),
          'generate',
          '--config',
          config,
        ],
        { cwd: root, stdio: 'pipe' },
      );
    };
    const schemaSource = (columns: string) => `
      import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
      export const session = sqliteTable('session', {
        id: text('id').primaryKey(), ${columns}
      });
    `;
    writeFileSync(schema, schemaSource("token: text('token').default('legacy'),"));
    await generateValidatedSqliteMigrations(migrations, generate);
    expect(collectMigrations(migrations)[0]?.sql).toContain('CREATE TABLE `session`');
    const before = files(migrations);

    // Removing a default forces a table rebuild while Better Auth adds impersonatedBy.
    writeFileSync(
      schema,
      schemaSource("token: text('token'), impersonatedBy: text('impersonatedBy'),"),
    );
    await expect(generateValidatedSqliteMigrations(migrations, generate)).rejects.toThrow(
      /impersonatedBy/,
    );
    expect(files(migrations)).toEqual(before);

    // A subsequent additive change must still generate from the ORIGINAL snapshot.
    writeFileSync(
      schema,
      schemaSource(
        "token: text('token').default('legacy'), impersonatedBy: text('impersonatedBy'),",
      ),
    );
    await generateValidatedSqliteMigrations(migrations, generate);
    const db = await openMigrationValidationDatabase(collectMigrations(migrations));
    try {
      expect(db.prepare('PRAGMA table_info(session)').all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'impersonatedBy' }),
          expect.objectContaining({ name: 'token', dflt_value: "'legacy'" }),
        ]),
      );
    } finally {
      db.close();
    }
  }, 20_000);

  it('leaves existing invalid history untouched and explains why regenerating cannot fix it', async () => {
    const root = fixture();
    writeFileSync(join(root, '0000.sql'), 'CREATE TABLE session (id TEXT);');
    writeFileSync(join(root, '0001.sql'), 'SELECT "impersonatedBy" FROM session;');
    const before = files(root);
    const generate = vi.fn();
    await expect(generateValidatedSqliteMigrations(root, generate)).rejects.toThrow(
      /Repair the unapplied migration/,
    );
    expect(generate).not.toHaveBeenCalled();
    expect(files(root)).toEqual(before);
  });

  it('restores original bytes when the generator fails after changing metadata', async () => {
    const root = fixture();
    const meta = join(root, 'meta');
    mkdirSync(meta);
    const journal = join(meta, '_journal.json');
    writeFileSync(journal, '{"entries":[]}\n');
    writeFileSync(join(root, 'README.md'), 'Keep custom files.\n');
    const before = files(root);
    await expect(
      generateValidatedSqliteMigrations(root, () => {
        writeFileSync(journal, '{}');
        writeFileSync(join(meta, '0000_snapshot.json'), '{}');
        throw new Error('generator failed');
      }),
    ).rejects.toThrow(/previous SQL, snapshots and journal were restored/);
    expect(files(root)).toEqual(before);
  });

  it('removes newly created migration artifacts after a failed initial generation', async () => {
    const root = join(fixture(), 'migrations');
    await expect(
      generateValidatedSqliteMigrations(root, () => {
        mkdirSync(root);
        writeFileSync(join(root, '0000.sql'), 'INVALID SQL;');
      }),
    ).rejects.toThrow(/0000.sql/);
    expect(existsSync(root)).toBe(false);
  });
});
