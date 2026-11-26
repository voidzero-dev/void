import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../drizzle');
const MIGRATION = '0065_security_audits';

type JournalEntry = { idx: number; tag: string };

function readMigration(tag: string): string {
  return readFileSync(resolve(root, `${tag}.sql`), 'utf8');
}

// An old runtime keeps working: 0065 only adds tables and leaves every existing column as it was.
it('applies 0065 on top of 0064 without touching existing columns', async () => {
  const journal = (
    JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<JournalEntry>;
    }
  ).entries;
  expect(journal.find((entry) => entry.idx === 65)?.tag).toBe(MIGRATION);
  const db = new PGlite();
  try {
    for (const entry of journal.filter((entry) => entry.idx < 65)) {
      await db.exec(readMigration(entry.tag));
    }
    const catalog = async () =>
      (
        await db.query<{ table_name: string }>(
          "SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position",
        )
      ).rows;
    const before = await catalog();
    const oldTables = new Set(before.map((row) => row.table_name));
    await db.exec(readMigration(MIGRATION));
    const after = await catalog();
    expect(after.filter((row) => oldTables.has(row.table_name))).toEqual(before);
    expect(after.some((row) => row.table_name === 'security_scans')).toBe(true);

    // One running scan per project.
    await db.exec(
      `INSERT INTO users (id, provider_id, login) VALUES ('owner', '1', 'owner');
       INSERT INTO projects (id, user_id, slug) VALUES ('kept', 'owner', 'kept');
       INSERT INTO security_scans (id, project_id, deployment_id, status, trigger, lease_until)
         VALUES ('ss_run', 'kept', 'dpl_1', 'running', 'deploy', now());`,
    );
    await expect(
      db.exec(
        "INSERT INTO security_scans (id, project_id, deployment_id, status, trigger, lease_until) VALUES ('ss_run2', 'kept', 'dpl_3', 'running', 'gate', now())",
      ),
    ).rejects.toMatchObject({ code: '23505' });
  } finally {
    await db.close();
  }
}, 30_000);
