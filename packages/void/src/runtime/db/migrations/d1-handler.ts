import {
  canonicalJson,
  canonicalSql,
  getMigrationPlanHashInput,
  isSingleStatement,
  splitSqlStatements,
} from '@void/deploy-core';
import type { MigrationExecutionPlan, MigrationPlanBundle } from '../migrations/plan.ts';

export type MigrationEntry = {
  name: string;
  sql: string;
};

export type MigrationResult = {
  name: string;
  applied: boolean;
  durationMs: number;
  error?: string;
  status?: 'applied' | 'skipped' | 'failed';
  stability?: 'stable' | 'legacy';
};

export type MigrationResponse = {
  ok: boolean;
  migrations: Array<MigrationResult>;
  error?: string;
  protocolVersion?: 2;
  attemptId?: string;
  confirmedApplied?: Array<string>;
  confirmedSkipped?: Array<string>;
  stability?: 'stable' | 'legacy';
  warnings?: Array<string>;
};

type AttemptRow = {
  attempt_id: string;
  deployment_id: string | null;
  migration_list_hash: string;
  planned_names_json: string;
  plan_hashes_json: string;
  status: 'running' | 'completed' | 'failed' | 'unknown';
  started_at: string;
  completed_at: string | null;
  error: string | null;
};

const SUPPORTED_CLASSIFIER_VERSION = 1;

export function createMigrationHandler(
  env: Record<string, unknown>,
  migrations: Array<MigrationEntry> | undefined,
  runAuthMigrations?: () => Promise<void>,
  planBundle?: MigrationPlanBundle,
) {
  return async (request: Request): Promise<Response> => {
    const token = request.headers.get('x-void-internal');
    if (!token || token !== (env as Record<string, string>).__VOID_PROXY_TOKEN) {
      return Response.json(
        { ok: false, error: 'unauthorized', migrations: [] } satisfies MigrationResponse,
        { status: 401 },
      );
    }

    const url = new URL(request.url);
    try {
      const db = (env as Record<string, D1Database>).DB;
      if (!db) {
        return Response.json(
          { ok: false, error: 'no D1 binding found', migrations: [] } satisfies MigrationResponse,
          { status: 500 },
        );
      }

      if (request.method === 'GET' && url.pathname === '/__void/migrate/capabilities') {
        const verified = await verifyPlanBundle(migrations ?? [], planBundle);
        return Response.json({
          classifierVersion: verified.classifierVersion,
          destructiveValidation: verified.destructiveValidation,
          dialect: 'sqlite',
          endpoints: {
            app: '/__void/migrate/app',
            auth: runAuthMigrations ? '/__void/migrate/auth' : undefined,
            reconcile: '/__void/migrate/app/attempt/:attemptId',
          },
          migrationListHash: verified.migrationListHash,
          protocolVersion: 2,
        });
      }

      if (request.method === 'POST' && url.pathname === '/__void/migrate/app') {
        const body = (await request.json().catch(() => ({}))) as {
          attemptId?: string;
          deploymentId?: string;
        };
        if (!body.attemptId) {
          return Response.json(
            { ok: false, protocolVersion: 2, error: 'attemptId required', migrations: [] },
            { status: 400 },
          );
        }
        const result = await runD1AppMigrations(db, migrations ?? [], planBundle, {
          attemptId: body.attemptId,
          deploymentId: body.deploymentId,
        });
        const status = result.ok
          ? 200
          : result.error?.startsWith('migration already in progress')
            ? 409
            : 500;
        return Response.json(result, { status });
      }

      if (request.method === 'GET' && url.pathname.startsWith('/__void/migrate/app/attempt/')) {
        const attemptId = decodeURIComponent(url.pathname.split('/').pop() ?? '');
        const result = await reconcileAttempt(db, attemptId);
        return Response.json(result, { status: result.ok ? 200 : 409 });
      }

      if (request.method === 'POST' && url.pathname === '/__void/migrate/auth') {
        if (runAuthMigrations) {
          await runAuthMigrations();
        }
        return Response.json({ ok: true, protocolVersion: 2 });
      }

      const result = await runD1LegacyMigrations(db, migrations ?? []);
      if (result.ok && runAuthMigrations) {
        try {
          await runAuthMigrations();
        } catch (err) {
          return Response.json(
            {
              ...result,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            } satisfies MigrationResponse,
            { status: 500 },
          );
        }
      }
      return Response.json(result);
    } catch (err) {
      return Response.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          migrations: [],
        } satisfies MigrationResponse,
        { status: 500 },
      );
    }
  };
}

async function createTrackingTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS _void_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
    )
    .run();
}

async function createAttemptTables(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS _void_migration_attempts (
        attempt_id TEXT PRIMARY KEY,
        deployment_id TEXT,
        migration_list_hash TEXT NOT NULL,
        planned_names_json TEXT NOT NULL,
        plan_hashes_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'unknown')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS _void_migration_lock (
        name TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS _void_migration_fences (
        attempt_id TEXT PRIMARY KEY,
        owned INTEGER NOT NULL CHECK (owned = 1)
      )`,
    ),
  ]);
}

async function upgradeTrackingTable(db: D1Database, fencedAttemptId?: string): Promise<void> {
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
    .all();
  if (!results || results.length === 0) {
    return;
  }
  await db.batch([
    ...ownershipFence(db, fencedAttemptId),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS _void_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`,
    ),
    db.prepare(
      `INSERT OR IGNORE INTO _void_migrations (name, applied_at) SELECT name, applied_at FROM _migrations`,
    ),
    db.prepare(`DROP TABLE _migrations`),
  ]);
}

async function readAppliedSet(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare('SELECT name FROM _void_migrations').all();
  return new Set((results ?? []).map((row) => row.name as string));
}

async function runD1AppMigrations(
  db: D1Database,
  migrations: Array<MigrationEntry>,
  planBundle: MigrationPlanBundle | undefined,
  attempt: { attemptId: string; deploymentId?: string },
): Promise<MigrationResponse> {
  const verified = await verifyPlanBundle(migrations, planBundle);
  await createAttemptTables(db);

  const now = new Date().toISOString();
  const plannedNames = migrations.map((migration) => migration.name);
  const planHashes = verified.plans.map((plan) => plan.planHash);
  // Raw legacy exec cannot share a transaction with an ownership check. Such
  // attempts retain their lock until their executor finishes.
  const fenced = verified.plans.every((plan) => plan.kind !== 'legacy-unsplit-multi-statement');
  const lock = await acquireAttemptLock(db, attempt.attemptId, now, [
    db
      .prepare(
        `INSERT INTO _void_migration_attempts
          (attempt_id, deployment_id, migration_list_hash, planned_names_json, plan_hashes_json, status, started_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      )
      .bind(
        attempt.attemptId,
        attempt.deploymentId ?? null,
        verified.migrationListHash,
        JSON.stringify(plannedNames),
        JSON.stringify(planHashes),
        now,
      ),
    ...(fenced
      ? [
          db
            .prepare('INSERT INTO _void_migration_fences (attempt_id, owned) VALUES (?, 1)')
            .bind(attempt.attemptId),
        ]
      : []),
  ]);
  if (lock !== 'acquired') {
    return lock;
  }

  const migrationResults: Array<MigrationResult> = [];
  const confirmedApplied: Array<string> = [];
  const confirmedSkipped: Array<string> = [];
  let warnings = verified.plans.flatMap((plan) => plan.warnings ?? []);
  let stability: 'stable' | 'legacy' = 'stable';

  try {
    await createTrackingTable(db);
    await upgradeTrackingTable(db, fenced ? attempt.attemptId : undefined);
    const applied = await readAppliedSet(db);
    // A migration applied earlier never runs again, so its warning cannot be acted on.
    warnings = verified.plans.flatMap((plan, index) =>
      applied.has(migrations[index]!.name) ? [] : (plan.warnings ?? []),
    );

    for (let index = 0; index < migrations.length; index++) {
      const migration = migrations[index]!;
      const plan = verified.plans[index]!;
      if (plan.stability === 'legacy') {
        stability = 'legacy';
      }

      if (applied.has(migration.name)) {
        confirmedSkipped.push(migration.name);
        migrationResults.push({
          applied: false,
          durationMs: 0,
          name: migration.name,
          stability: plan.stability,
          status: 'skipped',
        });
        continue;
      }

      const start = Date.now();
      try {
        await executeMigrationPlan(db, migration, plan, fenced ? attempt.attemptId : undefined);
        applied.add(migration.name);
        confirmedApplied.push(migration.name);
        migrationResults.push({
          applied: true,
          durationMs: Date.now() - start,
          name: migration.name,
          stability: plan.stability,
          status: 'applied',
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        migrationResults.push({
          applied: false,
          durationMs: Date.now() - start,
          error,
          name: migration.name,
          stability: plan.stability,
          status: 'failed',
        });
        await markAttempt(db, attempt.attemptId, 'failed', error);
        await releaseAttemptLock(db, attempt.attemptId);
        return {
          ok: false,
          protocolVersion: 2,
          attemptId: attempt.attemptId,
          confirmedApplied,
          confirmedSkipped,
          error: `migration ${migration.name} failed`,
          migrations: migrationResults,
          stability,
          warnings,
        };
      }
    }

    await markAttempt(db, attempt.attemptId, 'completed');
    await releaseAttemptLock(db, attempt.attemptId);
    return {
      ok: true,
      protocolVersion: 2,
      attemptId: attempt.attemptId,
      confirmedApplied,
      confirmedSkipped,
      migrations: migrationResults,
      stability,
      warnings,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await markAttempt(db, attempt.attemptId, 'failed', error).catch(() => {});
    await releaseAttemptLock(db, attempt.attemptId).catch(() => {});
    return {
      ok: false,
      protocolVersion: 2,
      attemptId: attempt.attemptId,
      confirmedApplied,
      confirmedSkipped,
      error,
      migrations: migrationResults,
      stability,
      warnings,
    };
  }
}

async function acquireAttemptLock(
  db: D1Database,
  attemptId: string,
  acquiredAt: string,
  initialize: Array<D1PreparedStatement>,
): Promise<'acquired' | MigrationResponse> {
  for (let tries = 0; tries < 2; tries++) {
    try {
      // Publish the attempt and its lock together. A missing attempt row must
      // never be mistaken for an orphan in between these writes.
      await db.batch([
        db
          .prepare(
            'INSERT INTO _void_migration_lock (name, attempt_id, acquired_at) VALUES (?, ?, ?)',
          )
          .bind('app', attemptId, acquiredAt),
        ...initialize,
      ]);
      return 'acquired';
    } catch {
      const existing = await db
        .prepare('SELECT attempt_id FROM _void_migration_lock WHERE name = ?')
        .bind('app')
        .first<{ attempt_id: string }>();
      if (!existing && (await readAttempt(db, attemptId))) {
        return reconcileAttempt(db, attemptId, false);
      }
      if (existing?.attempt_id) {
        const row = await readAttempt(db, existing.attempt_id);
        if (row?.status === 'completed' || row?.status === 'failed') {
          await releaseAttemptLock(db, existing.attempt_id).catch(() => {});
          continue;
        }
      }
      return {
        ok: false,
        protocolVersion: 2,
        attemptId,
        migrations: [],
        error: `migration already in progress for attempt ${existing?.attempt_id ?? 'unknown'}`,
      };
    }
  }
  return {
    ok: false,
    protocolVersion: 2,
    attemptId,
    migrations: [],
    error: 'migration lock could not be acquired',
  };
}

async function executeMigrationPlan(
  db: D1Database,
  migration: MigrationEntry,
  plan: MigrationExecutionPlan,
  fencedAttemptId?: string,
): Promise<void> {
  const appliedAt = new Date().toISOString();
  if (plan.kind === 'single-statement') {
    await db.batch([
      ...ownershipFence(db, fencedAttemptId),
      db.prepare(migration.sql),
      db
        .prepare('INSERT INTO _void_migrations (name, applied_at) VALUES (?, ?)')
        .bind(migration.name, appliedAt),
    ]);
    return;
  }
  if (plan.kind === 'breakpoint-framed') {
    await db.batch([
      ...ownershipFence(db, fencedAttemptId),
      ...plan.statements.map((statement) => db.prepare(statement)),
      db
        .prepare('INSERT INTO _void_migrations (name, applied_at) VALUES (?, ?)')
        .bind(migration.name, appliedAt),
    ]);
    return;
  }

  await runUnsplitMigration(db, migration, appliedAt, fencedAttemptId);
}

/**
 * D1 `exec()` treats each line as its own statement, so multi-line statements
 * fail there. Run each top-level statement through one batch instead, and keep
 * `exec()` only for SQL the splitter cannot divide safely (trigger bodies).
 */
async function runUnsplitMigration(
  db: D1Database,
  migration: MigrationEntry,
  appliedAt: string,
  fencedAttemptId?: string,
): Promise<void> {
  const record = db
    .prepare('INSERT OR IGNORE INTO _void_migrations (name, applied_at) VALUES (?, ?)')
    .bind(migration.name, appliedAt);
  const statements = splitSqlStatements(migration.sql);
  if (statements) {
    await db.batch([
      ...ownershipFence(db, fencedAttemptId),
      ...statements.map((statement) => db.prepare(statement)),
      record,
    ]);
    return;
  }
  await db.exec(migration.sql);
  await record.run();
}

/** Fail the whole D1 batch if recovery has revoked this executor's ownership. */
function ownershipFence(db: D1Database, attemptId?: string): Array<D1PreparedStatement> {
  if (!attemptId) {
    return [];
  }
  return [
    db
      .prepare(
        `INSERT INTO _void_migration_fences (attempt_id, owned)
     VALUES (?, EXISTS(SELECT 1 FROM _void_migration_lock WHERE name = 'app' AND attempt_id = ?))
     ON CONFLICT(attempt_id) DO UPDATE SET owned = excluded.owned`,
      )
      .bind(attemptId, attemptId),
  ];
}

function attemptUpdate(
  db: D1Database,
  attemptId: string,
  status: 'completed' | 'failed' | 'unknown',
  error?: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE _void_migration_attempts
       SET status = ?, completed_at = ?, error = ?
       WHERE attempt_id = ? AND status ${status === 'completed' ? "IN ('running', 'unknown')" : "= 'running'"}`,
    )
    .bind(status, new Date().toISOString(), error ?? null, attemptId);
}

async function markAttempt(
  db: D1Database,
  attemptId: string,
  status: 'completed' | 'failed' | 'unknown',
  error?: string,
): Promise<void> {
  await attemptUpdate(db, attemptId, status, error).run();
}

async function releaseAttemptLock(db: D1Database, attemptId: string): Promise<void> {
  await db
    .prepare('DELETE FROM _void_migration_lock WHERE name = ? AND attempt_id = ?')
    .bind('app', attemptId)
    .run();
}

async function readAttempt(db: D1Database, attemptId: string): Promise<AttemptRow | null> {
  return db
    .prepare('SELECT * FROM _void_migration_attempts WHERE attempt_id = ?')
    .bind(attemptId)
    .first<AttemptRow>();
}

async function reconcileAttempt(
  db: D1Database,
  attemptId: string,
  recover = true,
): Promise<MigrationResponse> {
  await createAttemptTables(db);
  await createTrackingTable(db);
  const row = await readAttempt(db, attemptId);
  if (!row) {
    return {
      ok: false,
      protocolVersion: 2,
      attemptId,
      migrations: [],
      error: 'migration attempt not found',
    };
  }
  const fenced = await db
    .prepare('SELECT attempt_id FROM _void_migration_fences WHERE attempt_id = ?')
    .bind(attemptId)
    .first();
  if (recover && fenced) {
    // Revocation and status move together. Any already submitted migration is
    // ordered before this transaction or fails its fence after it; read the
    // confirmed prefix only AFTER revocation. Never revoke older executors or
    // raw exec attempts, which cannot enforce a fence in their SQL transaction.
    await db.batch([
      attemptUpdate(db, attemptId, 'unknown', 'migration outcome unknown'),
      db
        .prepare('DELETE FROM _void_migration_lock WHERE name = ? AND attempt_id = ?')
        .bind('app', attemptId),
    ]);
  }
  const plannedNames = JSON.parse(row.planned_names_json) as Array<string>;
  const applied = await readAppliedSet(db);
  const confirmed = plannedNames.filter((name) => applied.has(name));
  const complete = confirmed.length === plannedNames.length;
  if (complete && row.status !== 'completed') {
    await markAttempt(db, attemptId, 'completed').catch(() => {});
  }
  const inProgress = !fenced && !complete && (row.status === 'running' || row.status === 'unknown');
  if (complete || row.status === 'completed' || row.status === 'failed') {
    await releaseAttemptLock(db, attemptId);
  }
  return {
    ok: complete,
    protocolVersion: 2,
    attemptId,
    confirmedApplied: [],
    confirmedSkipped: confirmed,
    migrations: plannedNames.map((name) => ({
      applied: false,
      durationMs: 0,
      name,
      status: applied.has(name) ? 'skipped' : 'failed',
    })),
    error: complete
      ? undefined
      : inProgress
        ? `migration already in progress for attempt ${attemptId}; wait for this migration to finish before retrying recovery`
        : (row.error ?? 'migration outcome unknown'),
    stability: 'stable',
  };
}

async function verifyPlanBundle(
  migrations: Array<MigrationEntry>,
  planBundle: MigrationPlanBundle | undefined,
): Promise<MigrationPlanBundle> {
  if (!planBundle || planBundle.protocolVersion !== 2) {
    throw new Error('migration protocol v2 execution plans are missing');
  }
  if (
    planBundle.classifierVersion !== SUPPORTED_CLASSIFIER_VERSION ||
    planBundle.destructiveValidation !== 'passed'
  ) {
    throw new Error('unsupported migration execution plan metadata');
  }
  if (planBundle.plans.length !== migrations.length) {
    throw new Error('migration execution plan count does not match bundled migrations');
  }
  for (let index = 0; index < migrations.length; index++) {
    const migration = migrations[index]!;
    const plan = planBundle.plans[index]!;
    if (
      plan.name !== migration.name ||
      plan.dialect !== 'sqlite' ||
      plan.classifierVersion !== SUPPORTED_CLASSIFIER_VERSION
    ) {
      throw new Error(`invalid migration execution plan for ${migration.name}`);
    }
    const sqlHash = await sha256Hex(canonicalSql(migration.sql));
    if (plan.sqlHash !== sqlHash) {
      throw new Error(`migration SQL hash mismatch for ${migration.name}`);
    }
    const planHash = await hashPlan(plan);
    if (plan.planHash !== planHash) {
      throw new Error(`migration plan hash mismatch for ${migration.name}`);
    }
  }
  const migrationListHash = await sha256Hex(
    canonicalJson(planBundle.plans.map((plan) => [plan.name, plan.sqlHash, plan.planHash])),
  );
  if (planBundle.migrationListHash !== migrationListHash) {
    throw new Error('migration list hash mismatch');
  }
  return planBundle;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function hashPlan(plan: MigrationExecutionPlan): Promise<string> {
  return sha256Hex(canonicalJson(getMigrationPlanHashInput(plan)));
}

async function runD1LegacyMigrations(
  db: D1Database,
  migrations: Array<MigrationEntry>,
): Promise<MigrationResponse> {
  await createTrackingTable(db);
  await upgradeTrackingTable(db);

  const applied = await readAppliedSet(db);
  const migrationResults: Array<MigrationResult> = [];

  for (const migration of migrations) {
    if (applied.has(migration.name)) {
      migrationResults.push({ name: migration.name, applied: false, durationMs: 0 });
      continue;
    }

    const start = Date.now();
    try {
      const statements = splitMigrationSql(migration.sql);
      if (statements.length === 1) {
        if (isSingleStatement(statements[0])) {
          await db.prepare(statements[0]).run();
          await recordLegacyMigration(db, migration.name);
        } else {
          await runUnsplitMigration(db, migration, new Date().toISOString());
        }
      } else {
        for (const statement of statements) {
          await db.prepare(statement).run();
        }
        await recordLegacyMigration(db, migration.name);
      }
      migrationResults.push({
        name: migration.name,
        applied: true,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      migrationResults.push({
        name: migration.name,
        applied: false,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        ok: false,
        migrations: migrationResults,
        error: `migration ${migration.name} failed`,
      };
    }
  }

  return { ok: true, migrations: migrationResults };
}

async function recordLegacyMigration(db: D1Database, name: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO _void_migrations (name, applied_at) VALUES (?, ?)')
    .bind(name, new Date().toISOString())
    .run();
}

export function splitMigrationSql(sql: string): Array<string> {
  const lines = sql.split(/\r?\n/);
  if (
    !lines.some((line) => isStatementBreakpointLine(line) || hasInlineStatementBreakpoint(line))
  ) {
    return [sql];
  }

  const statements: Array<string> = [];
  const current: Array<string> = [];

  for (const line of lines) {
    if (isStatementBreakpointLine(line)) {
      const statement = current.join('\n').trim();
      if (statement) {
        statements.push(statement);
      }
      current.length = 0;
      continue;
    }

    if (hasInlineStatementBreakpoint(line)) {
      current.push(line.replace(/-->\s*statement-breakpoint\s*$/, ''));
      const statement = current.join('\n').trim();
      if (statement) {
        statements.push(statement);
      }
      current.length = 0;
      continue;
    }

    current.push(line);
  }

  const statement = current.join('\n').trim();
  if (statement) {
    statements.push(statement);
  }

  return statements.length > 0 ? statements : [sql];
}

function isStatementBreakpointLine(line: string): boolean {
  return line.trim() === '--> statement-breakpoint';
}

function hasInlineStatementBreakpoint(line: string): boolean {
  return /;\s*-->\s*statement-breakpoint\s*$/.test(line.trim());
}
