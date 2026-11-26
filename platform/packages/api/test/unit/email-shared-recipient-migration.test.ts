import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { platformDatabaseSchemaDigest } from '@void/platform/installer';
import { expect, it } from 'vite-plus/test';

it('declares only the exact canonical 0.22.0 predecessor and fences legacy deletion for every unresolved recipient state', async () => {
  const root = resolve(import.meta.dirname, '../../drizzle');
  const journal = JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const compatibility = JSON.parse(readFileSync(resolve(root, 'compatibility.json'), 'utf8')) as {
    lineage: string;
    rollbackSafeFrom: Array<{ platformVersion: string; schemaDigest: string }>;
  };
  const baseline = journal.entries.filter((entry) => entry.idx <= 55);
  expect(baseline.at(-1)?.tag).toBe('0055_durable_deployment_execution');
  expect(baseline.slice(-2)).toMatchObject([
    { idx: 54, tag: '0054_project_mode', when: 1_790_841_384_175 },
    { idx: 55, tag: '0055_durable_deployment_execution', when: 1_790_864_531_640 },
  ]);
  const migration = journal.entries.find((entry) => entry.idx === 56);
  expect(migration).toMatchObject({ idx: 56, tag: '0056_email_shared_recipients' });
  expect(migration!.when).toBeGreaterThan(baseline.at(-1)!.when);
  const previousSnapshot = JSON.parse(
    readFileSync(resolve(root, 'meta/0055_snapshot.json'), 'utf8'),
  );
  const snapshot = JSON.parse(readFileSync(resolve(root, 'meta/0056_snapshot.json'), 'utf8'));
  expect(snapshot.prevId).toBe(previousSnapshot.id);
  expect(snapshot.id).not.toBe(previousSnapshot.id);
  expect(snapshot.tables).toEqual({
    ...previousSnapshot.tables,
    'public.email_shared_recipients': expect.any(Object),
  });
  const schemaDigest = platformDatabaseSchemaDigest(
    compatibility.lineage,
    baseline.map((entry) => ({
      index: entry.idx,
      tag: entry.tag,
      timestampMillis: entry.when,
      sha256: createHash('sha256')
        .update(readFileSync(resolve(root, `${entry.tag}.sql`)))
        .digest('hex'),
    })),
  );
  expect(schemaDigest).toBe('bef2a1cfaad1dcad4aca2a4932ef9aa9b9d8025dca495e3b1027902405da902a');
  expect(
    compatibility.rollbackSafeFrom.filter((entry) => entry.schemaDigest === schemaDigest),
  ).toEqual([{ platformVersion: '0.22.0', schemaDigest }]);
  const db = new PGlite();
  try {
    for (const entry of baseline) {
      await db.exec(readFileSync(resolve(root, `${entry.tag}.sql`), 'utf8'));
    }
    expect(
      (
        await db.query(
          "SELECT column_default FROM information_schema.columns WHERE table_name='projects' AND column_name='mode'",
        )
      ).rows,
    ).toEqual([{ column_default: "'void'::text" }]);
    expect(
      (await db.query("SELECT to_regclass('public.deployment_operations') AS name")).rows,
    ).toEqual([{ name: 'deployment_operations' }]);
    await db.exec(
      `INSERT INTO users (id, provider_id, login) VALUES ('owner', '1', 'owner'); INSERT INTO projects (id, user_id, slug) VALUES ('guarded', 'owner', 'guarded'), ('unrelated', 'owner', 'unrelated');`,
    );
    const existingTables = (
      await db.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
      )
    ).rows.map((row) => row.tablename);
    const catalog = async () =>
      (
        await db.query(
          "SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name, ordinal_position",
          [existingTables],
        )
      ).rows;
    const before = await catalog();
    await db.exec(readFileSync(resolve(root, '0056_email_shared_recipients.sql'), 'utf8'));
    expect(await catalog()).toEqual(before);
    await db.exec(
      `INSERT INTO email_shared_recipients (id, installation_id, project_id, route_id, recipient, rule_name) VALUES ('recipient', 'installation', 'guarded', 'route', 'guarded@mail.example.com', 'owned-rule');`,
    );
    for (const status of ['pending', 'reconciling', 'ready', 'blocked', 'unknown']) {
      await db.query('UPDATE email_shared_recipients SET status=$1 WHERE id=$2', [
        status,
        'recipient',
      ]);
      await expect(db.exec("DELETE FROM projects WHERE id='guarded'")).rejects.toMatchObject({
        code: '23503',
      });
      await expect(
        db.exec("UPDATE projects SET slug='reused' WHERE id='guarded'"),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(db.exec("DELETE FROM users WHERE id='owner'")).rejects.toThrow();
    }
    // Status updates and unrelated project teardown continue to work on an old
    // Worker; only unsafe ownership release is fenced.
    await db.exec(
      "UPDATE projects SET status='deleting', slug=slug WHERE id='guarded'; DELETE FROM projects WHERE id='unrelated';",
    );
    expect((await db.query("SELECT id, slug FROM projects WHERE id='guarded'")).rows).toEqual([
      { id: 'guarded', slug: 'guarded' },
    ]);
    await db.exec(
      "UPDATE email_shared_recipients SET status='removed' WHERE id='recipient'; DELETE FROM projects WHERE id='guarded'; INSERT INTO projects (id, user_id, slug) VALUES ('replacement', 'owner', 'guarded');",
    );
    expect((await db.query('SELECT project_id,status FROM email_shared_recipients')).rows).toEqual([
      { project_id: 'guarded', status: 'removed' },
    ]);
  } finally {
    await db.close();
  }
}, 15_000);
