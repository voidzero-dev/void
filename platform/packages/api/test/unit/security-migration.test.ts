import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { SecurityEngine } from '@void/platform/security-models';
import { SECURITY_MAX_MONTHLY_USD, SECURITY_MODES } from '@void/platform/security-policy';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  MAX_CAP_CENTS,
  SECURITY_ENGINES,
  SECURITY_POLICY_MODES,
  projectSecuritySettings,
  securityFindingEvents,
  securityFindings,
  securityMemoryRejected,
  securityNotifications,
  securityPlatformSpend,
  securityProjectEvents,
  securityProjectSpend,
  securityPublicRequests,
  securityScanBypasses,
  securityScans,
} from '../../src/schema.ts';

const root = resolve(import.meta.dirname, '../../drizzle');
const MIGRATION = '0065_security_audits';
const SECURITY_TABLES = [
  projectSecuritySettings,
  securityFindingEvents,
  securityFindings,
  securityMemoryRejected,
  securityNotifications,
  securityPlatformSpend,
  securityProjectEvents,
  securityProjectSpend,
  securityPublicRequests,
  securityScanBypasses,
  securityScans,
].map((table) => getTableConfig(table).name);

type JournalEntry = { idx: number; tag: string; when: number };

function readJournal(): Array<JournalEntry> {
  return (
    JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<JournalEntry>;
    }
  ).entries;
}

function readMigration(tag: string): string {
  return readFileSync(resolve(root, `${tag}.sql`), 'utf8');
}

function statements(tag: string): Array<string> {
  return readMigration(tag)
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

describe('security audits migration files', () => {
  it('uses the same modes, engines and max cap as the shared policy', () => {
    // Adding an engine to `SecurityEngine` fails typecheck here until it is listed.
    const engines: Record<SecurityEngine, true> = {
      void_loop: true,
      agent_sdk: true,
      codex_sdk: true,
    };
    expect([...SECURITY_ENGINES].sort()).toEqual(Object.keys(engines).sort());
    expect(SECURITY_POLICY_MODES).toEqual(SECURITY_MODES);
    expect(MAX_CAP_CENTS).toBe(SECURITY_MAX_MONTHLY_USD * 100);
  });

  it('appends 0065 after 0064 with a linked snapshot that only adds the security tables', () => {
    const journal = readJournal();
    const previous = journal.find((entry) => entry.idx === 64);
    const migration = journal.find((entry) => entry.idx === 65);
    expect(previous?.tag).toBe('0064_project_ai_logging');
    expect(migration?.tag).toBe(MIGRATION);
    expect(migration!.when).toBeGreaterThan(previous!.when);

    const previousSnapshot = JSON.parse(
      readFileSync(resolve(root, 'meta/0064_snapshot.json'), 'utf8'),
    );
    const snapshot = JSON.parse(readFileSync(resolve(root, 'meta/0065_snapshot.json'), 'utf8'));
    expect(snapshot.prevId).toBe(previousSnapshot.id);
    expect(snapshot.tables).toEqual({
      ...previousSnapshot.tables,
      ...Object.fromEntries(SECURITY_TABLES.map((name) => [`public.${name}`, expect.any(Object)])),
    });
  });

  it('only creates new tables, their constraints and their indexes', () => {
    const kinds = new Set<string>();
    for (const statement of statements(MIGRATION)) {
      const label = statement.slice(0, 80);
      let table: string | undefined;
      if (statement.startsWith('CREATE TABLE "')) {
        kinds.add('table');
        table = statement.slice('CREATE TABLE "'.length).split('"')[0];
      } else if (statement.startsWith('ALTER TABLE "')) {
        kinds.add('constraint');
        table = statement.slice('ALTER TABLE "'.length).split('"')[0];
        expect(statement.split('"')[2], label).toBe(' ADD CONSTRAINT ');
      } else if (
        statement.startsWith('CREATE INDEX "') ||
        statement.startsWith('CREATE UNIQUE INDEX "')
      ) {
        kinds.add('index');
        table = statement.split(' ON "')[1]?.split('"')[0];
      }
      expect(SECURITY_TABLES, label).toContain(table);
    }
    expect([...kinds].sort()).toEqual(['constraint', 'index', 'table']);
  });
});

describe('security audits migration on PGlite', () => {
  const db = new PGlite();

  beforeAll(async () => {
    for (const entry of readJournal().filter((entry) => entry.idx < 65)) {
      await db.exec(readMigration(entry.tag));
    }
    await db.exec(
      `INSERT INTO users (id, provider_id, login) VALUES ('owner', '1', 'owner');
       INSERT INTO projects (id, user_id, slug) VALUES ('doomed', 'owner', 'doomed'), ('kept', 'owner', 'kept');`,
    );
    // An old runtime keeps working: 0065 must leave every existing column as it was.
    const catalog = async () =>
      (
        await db.query(
          "SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position",
        )
      ).rows;
    const before = await catalog();
    await db.exec(readMigration(MIGRATION));
    const after = await catalog();
    expect(
      after.filter((row) => !SECURITY_TABLES.includes((row as { table_name: string }).table_name)),
    ).toEqual(before);
  }, 30_000);

  afterAll(async () => {
    await db.close();
  });

  async function rejects(statement: string, code: string): Promise<void> {
    await expect(db.exec(statement)).rejects.toMatchObject({ code });
  }

  it('allows one running scan and one open public request per project', async () => {
    await db.exec(
      `INSERT INTO security_scans (id, project_id, deployment_id, status, trigger, lease_until)
         VALUES ('ss_run', 'kept', 'dpl_1', 'running', 'deploy', now());
       INSERT INTO security_scans (id, project_id, deployment_id, status, trigger)
         VALUES ('ss_queued', 'kept', 'dpl_2', 'queued', 'deploy');`,
    );
    await rejects(
      "INSERT INTO security_scans (id, project_id, deployment_id, status, trigger, lease_until) VALUES ('ss_run2', 'kept', 'dpl_3', 'running', 'gate', now())",
      '23505',
    );
    // A running scan needs a lease; only a local check has no deployment.
    await rejects(
      "INSERT INTO security_scans (id, project_id, deployment_id, status, trigger) VALUES ('ss_nolease', 'doomed', 'dpl_3', 'running', 'deploy')",
      '23514',
    );
    await rejects(
      "INSERT INTO security_scans (id, project_id, status, trigger) VALUES ('ss_nodpl', 'kept', 'queued', 'deploy')",
      '23514',
    );
    await db.exec(
      "INSERT INTO security_scans (id, project_id, status, trigger) VALUES ('ss_local', 'kept', 'queued', 'local')",
    );
    await rejects(
      "INSERT INTO security_scans (id, project_id, deployment_id, status, trigger) VALUES ('ss_bad', 'kept', 'dpl_4', 'paused', 'deploy')",
      '23514',
    );

    await db.exec(
      `INSERT INTO security_public_requests (id, project_id, state, requested_via, target_deployment_id)
         VALUES ('spr_open', 'kept', 'waiting_scan', 'project', 'dpl_1');
       INSERT INTO security_public_requests (id, project_id, state, requested_via, target_deployment_id, cancel_cause, closed_at)
         VALUES ('spr_closed', 'kept', 'canceled', 'admin', 'dpl_1', 'protect', now());`,
    );
    await rejects(
      "INSERT INTO security_public_requests (id, project_id, state, requested_via, target_deployment_id) VALUES ('spr_open2', 'kept', 'held_findings', 'operator', 'dpl_1')",
      '23505',
    );
    // Closed rows carry `closed_at`; only canceled rows carry a cancel cause.
    await rejects(
      "INSERT INTO security_public_requests (id, project_id, state, requested_via, target_deployment_id) VALUES ('spr_noclose', 'doomed', 'passed', 'project', 'dpl_1')",
      '23514',
    );
    await rejects(
      "INSERT INTO security_public_requests (id, project_id, state, requested_via, target_deployment_id, cancel_cause, closed_at) VALUES ('spr_cause', 'doomed', 'passed', 'project', 'dpl_1', 'protect', now())",
      '23514',
    );
  });

  it('keeps F-numbers and fingerprint keys unique per project and resolutions consistent', async () => {
    const finding = (id: string, project: string, number: number, key: string) =>
      `INSERT INTO security_findings (id, project_id, number, fingerprint_key, verdict, severity, title, category, first_scan_id, last_seen_scan_id)
         VALUES ('${id}', '${project}', ${number}, '${key}', 'confirmed', 'high', 'SQL injection', 'injection', 'ss_run', 'ss_run')`;
    await db.exec(finding('sf_1', 'kept', 1, 'key-a'));
    await db.exec(finding('sf_other', 'doomed', 1, 'key-a'));
    await rejects(finding('sf_2', 'kept', 1, 'key-b'), '23505');
    await rejects(finding('sf_3', 'kept', 2, 'key-a'), '23505');
    expect(
      (
        await db.query<{ next_finding_number: number; policy_override: string }>(
          "INSERT INTO project_security_settings (project_id) VALUES ('kept') RETURNING next_finding_number, policy_override",
        )
      ).rows,
    ).toEqual([{ next_finding_number: 1, policy_override: 'inherit' }]);

    await rejects("UPDATE security_findings SET state = 'resolved' WHERE id = 'sf_1'", '23514');
    await rejects("UPDATE security_findings SET resolution = 'fixed' WHERE id = 'sf_1'", '23514');
    await db.exec(
      "UPDATE security_findings SET state = 'resolved', resolution = 'fixed', resolved_at = now() WHERE id = 'sf_1'",
    );
    await rejects(
      "UPDATE security_findings SET severity_override = 'urgent' WHERE id = 'sf_1'",
      '23514',
    );
    await rejects(
      "INSERT INTO security_finding_events (id, finding_id, project_id, actor_kind, action, comment) VALUES ('sfe_empty', 'sf_1', 'kept', 'user', 'commented', '')",
      '23514',
    );
  });

  it('checks bypasses, cancel causes, notices, rejections and the urgent set', async () => {
    const bypass = (id: string, reason: string, state = 'held_no_result') =>
      `INSERT INTO security_scan_bypasses (id, project_id, request_id, deployment_id, actor_kind, actor_user_id, reason, request_state) VALUES ('${id}', 'kept', 'spr_closed', 'dpl_1', 'user', 'owner', '${reason}', '${state}')`;
    await rejects(bypass('sb_empty', ''), '23514');
    await rejects(bypass('sb_long', 'x'.repeat(4001)), '23514');
    // A bypass never skips open urgent findings, so it is not taken from `held_findings`.
    await rejects(bypass('sb_held', 'launch', 'held_findings'), '23514');
    await db.exec(bypass('sb_max', 'x'.repeat(4000), 'needs_deploy'));

    await rejects(
      "INSERT INTO security_public_requests (id, project_id, state, requested_via, target_deployment_id, closed_at) VALUES ('spr_nocause', 'doomed', 'canceled', 'project', 'dpl_1', now())",
      '23514',
    );
    await rejects(
      "INSERT INTO project_security_settings (project_id, provider_notice_version) VALUES ('doomed', 1)",
      '23514',
    );

    const rejected = (reason: string) =>
      `INSERT INTO security_memory_rejected (project_id, fingerprint_key, reason, scan_id) VALUES ('kept', 'key-r', '${reason}', 'ss_run')`;
    await db.exec(rejected('first'));
    await rejects(rejected('again'), '23505');
    await db.exec(
      `${rejected('latest')} ON CONFLICT (project_id, fingerprint_key) DO UPDATE SET reason = excluded.reason`,
    );
    expect(
      (await db.query("SELECT reason FROM security_memory_rejected WHERE project_id = 'kept'"))
        .rows,
    ).toEqual([{ reason: 'latest' }]);

    // The urgent set uses the human override when one is set.
    const finding = (id: string, number: number, severity: string, override: string) =>
      `INSERT INTO security_findings (id, project_id, number, fingerprint_key, verdict, severity, severity_override, title, category, first_scan_id, last_seen_scan_id)
         VALUES ('${id}', 'doomed', ${number}, 'key-${id}', 'confirmed', '${severity}', ${override}, 'XSS', 'xss', 'ss_run', 'ss_run')`;
    await db.exec(
      [
        finding('sf_high', 10, 'high', 'NULL'),
        finding('sf_lowered', 11, 'high', "'low'"),
        finding('sf_raised', 12, 'low', "'critical'"),
      ].join(';'),
    );
    const [index] = (
      await db.query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_security_findings_urgent'",
      )
    ).rows;
    const predicate = index.indexdef.split(' WHERE ')[1];
    expect(predicate).toBeTruthy();
    expect(
      (
        await db.query(
          `SELECT id FROM security_findings WHERE id IN ('sf_high', 'sf_lowered', 'sf_raised') AND ${predicate} ORDER BY id`,
        )
      ).rows,
    ).toEqual([{ id: 'sf_high' }, { id: 'sf_raised' }]);
  });

  it('stores spend by UTC month and keeps a notification project only for project emails', async () => {
    await db.exec(
      `INSERT INTO security_project_spend (project_id, month, spent_nano_usd) VALUES ('kept', '2026-11-01', 1500000000000000);
       INSERT INTO security_platform_spend (month, spent_nano_usd) VALUES ('2026-11-01', 3);`,
    );
    expect((await db.query('SELECT spent_nano_usd FROM security_project_spend')).rows).toEqual([
      { spent_nano_usd: 1_500_000_000_000_000 },
    ]);
    await rejects("INSERT INTO security_platform_spend (month) VALUES ('2026-11-02')", '23514');
    await rejects(
      "INSERT INTO security_project_spend (project_id, month, reserved_nano_usd) VALUES ('doomed', '2026-11-01', -1)",
      '23514',
    );
    await rejects(
      "INSERT INTO project_security_settings (project_id, monthly_cap_cents) VALUES ('doomed', 100000001)",
      '23514',
    );

    await db.exec(
      `INSERT INTO security_notifications (id, kind, dedupe_key) VALUES ('sn_platform', 'cap_platform', 'cap_platform:2026-11:80');
       INSERT INTO security_notifications (id, kind, project_id, scan_ids, dedupe_key) VALUES ('sn_findings', 'findings', 'kept', ARRAY['ss_run'], 'findings:ss_run');`,
    );
    expect(
      (
        await db.query(
          "SELECT status, attempts, next_attempt_at IS NOT NULL AS due FROM security_notifications WHERE id = 'sn_findings'",
        )
      ).rows,
    ).toEqual([{ status: 'pending', attempts: 0, due: true }]);
    await rejects(
      "INSERT INTO security_notifications (id, kind, dedupe_key) VALUES ('sn_orphan', 'findings', 'findings:x')",
      '23514',
    );
    await rejects(
      "INSERT INTO security_notifications (id, kind, project_id, dedupe_key) VALUES ('sn_dupe', 'reopen', 'kept', 'findings:ss_run')",
      '23505',
    );
  });

  it('cascades every project row on delete but keeps the platform month total', async () => {
    await db.exec(
      `INSERT INTO project_security_settings (project_id, monthly_cap_cents) VALUES ('doomed', 10000);
       INSERT INTO security_project_events (id, project_id, actor_kind, action, cap_kind, new_cents) VALUES ('spe_1', 'doomed', 'user', 'cap_changed', 'own', 10000);
       INSERT INTO security_scans (id, project_id, deployment_id, status, trigger, lease_until) VALUES ('ss_doomed', 'doomed', 'dpl_d', 'running', 'deploy', now());
       INSERT INTO security_finding_events (id, finding_id, project_id, scan_id, actor_kind, action) VALUES ('sfe_1', 'sf_other', 'doomed', 'ss_doomed', 'scanner', 'created');
       INSERT INTO security_memory_rejected (project_id, fingerprint_key, reason, scan_id) VALUES ('doomed', 'key-z', 'not reachable', 'ss_doomed');
       INSERT INTO security_public_requests (id, project_id, state, requested_via, target_deployment_id, closed_at) VALUES ('spr_doomed', 'doomed', 'bypassed', 'project', 'dpl_d', now());
       INSERT INTO security_scan_bypasses (id, project_id, request_id, deployment_id, actor_kind, actor_user_id, reason, request_state) VALUES ('sb_1', 'doomed', 'spr_doomed', 'dpl_d', 'user', 'owner', 'launch today', 'held_no_result');
       INSERT INTO security_project_spend (project_id, month, spent_nano_usd) VALUES ('doomed', '2026-11-01', 7);
       INSERT INTO security_notifications (id, kind, project_id, dedupe_key) VALUES ('sn_doomed', 'scan_bypass', 'doomed', 'scan_bypass:sb_1');`,
    );
    // A request a bypass points to cannot be removed on its own (retention keeps it).
    await rejects("DELETE FROM security_public_requests WHERE id = 'spr_doomed'", '23503');

    await db.exec("DELETE FROM projects WHERE id = 'doomed'");
    for (const table of SECURITY_TABLES) {
      const column = table === 'security_platform_spend' ? null : 'project_id';
      if (column) {
        expect(
          (await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE project_id = 'doomed'`))
            .rows,
          table,
        ).toEqual([{ n: 0 }]);
      }
    }
    expect(
      (await db.query('SELECT month, spent_nano_usd FROM security_platform_spend')).rows,
    ).toEqual([{ month: new Date('2026-11-01T00:00:00Z'), spent_nano_usd: 3 }]);
    expect(
      (await db.query("SELECT count(*)::int AS n FROM security_findings WHERE project_id = 'kept'"))
        .rows,
    ).toEqual([{ n: 1 }]);
    expect((await db.query('SELECT id FROM security_notifications ORDER BY id')).rows).toEqual([
      { id: 'sn_findings' },
      { id: 'sn_platform' },
    ]);
  });
});
