import { createHash } from 'node:crypto';
import { canonicalJson } from '@void/deploy-core';
import { eq } from 'drizzle-orm';
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from 'vite-plus/test';
import { deleteRollbackLease } from '../../src/db.ts';
import type { Db } from '../../src/db.ts';
import app from '../../src/index.ts';
// oxlint-disable-next-line import/no-namespace -- The test replaces or spies on members of the module object.
import * as projectAccess from '../../src/project-access.ts';
import {
  deployments,
  domains,
  projectMembers,
  projectMigrations,
  projects,
  resources,
  users,
} from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  createTestDeployment,
  mockCfApi,
  cfSuccess,
  cfError,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import { setTestDb } from './setup.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Stateful D1 mock used by the migration endpoint integration tests.
 *
 * This mock implements just enough of the D1 REST query surface to
 * exercise the full runRemoteMigrations code path end-to-end through
 * the Hono app: the tracking-table create, legacy-table detection and
 * upgrade, the `_void_migrations` select, per-migration execution,
 * the atomic SQL/tracking batch, and the rename UPDATE.
 *
 * Failure injection hooks:
 *   - `failingSqlPatterns`: list of `{ match, message, status? }` rules
 *     checked in order against every incoming SQL string. The first
 *     match returns a cfError response for that one query, so tests
 *     can simulate "CREATE TABLE X already exists" on the first run
 *     and succeed on subsequent queries.
 *   - `queries`: every request is appended verbatim for assertions.
 *
 * The mock intentionally does NOT actually parse or execute application
 * SQL — that's the system under test's responsibility. It records the
 * SQL, tracks the `_void_migrations` and (optionally) `_migrations`
 * rows as in-memory maps, and always returns success for unknown
 * application SQL unless a failing pattern says otherwise.
 */
type FailingRule = {
  match: RegExp;
  message: string;
  status?: number;
  // If true, only fail the first N matches then succeed afterwards
  maxHits?: number;
  hits?: number;
};

type D1MockState = {
  trackingRows: Map<string, string>;
  legacyRows?: Map<string, string>;
  failingSqlPatterns: Array<FailingRule>;
  queries: Array<{ sql: string; params?: Array<unknown> }>;
  /**
   * Models whether `_void_migrations` actually exists on the remote DB. Any
   * SELECT / INSERT / UPDATE targeting `_void_migrations` while this is false
   * returns a "no such table" error, just like D1. The flag flips to `true`
   * the first time the mock sees `CREATE TABLE IF NOT EXISTS _void_migrations`,
   * so a test that reorders `ensureTrackingTable()` and dropped the CREATE
   * would immediately break on downstream queries.
   *
   * Defaults to `true` when `trackingRows` is pre-populated (the test is
   * simulating an existing project) and `false` otherwise.
   */
  voidTableExists: boolean;
  /**
   * When `true`, the mock tracks identical application CREATE TABLE strings
   * across calls and returns "already exists" on the second+ occurrence.
   * Used to simulate real concurrent-CREATE races where the first request
   * commits the DDL before the second request runs the same statement.
   */
  simulateDuplicateCreate?: boolean;
  _seenCreateSql?: Set<string>;
};

function createD1State(init: Partial<D1MockState> = {}): D1MockState {
  const trackingRows = new Map(init.trackingRows ?? []);
  return {
    trackingRows,
    legacyRows: init.legacyRows ? new Map(init.legacyRows) : undefined,
    failingSqlPatterns: init.failingSqlPatterns ?? [],
    queries: [],
    voidTableExists: init.voidTableExists ?? trackingRows.size > 0,
    simulateDuplicateCreate: init.simulateDuplicateCreate,
    _seenCreateSql: init.simulateDuplicateCreate ? new Set() : undefined,
  };
}

function makeQueryD1(state: D1MockState) {
  const noVoidTable = () => cfError('no such table: _void_migrations', 400);

  return (_url: string, init?: RequestInit): Response => {
    const parsed = init?.body ? JSON.parse(String(init.body)) : {};
    const sql = String(parsed.sql ?? '');
    const params = parsed.params;
    state.queries.push({ sql, params });

    for (const rule of state.failingSqlPatterns) {
      if (rule.match.test(sql)) {
        rule.hits = (rule.hits ?? 0) + 1;
        if (rule.maxHits !== undefined && rule.hits > rule.maxHits) {
          continue;
        }
        return cfError(rule.message, rule.status ?? 500);
      }
    }

    // CREATE tracking table — always succeeds and flips the table-exists bit.
    if (/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+_void_migrations/i.test(sql)) {
      state.voidTableExists = true;
      return cfSuccess([{ results: [] }]);
    }

    // sqlite_master probe for legacy _migrations
    if (/sqlite_master[\s\S]*_migrations/i.test(sql)) {
      const legacyPresent = !!state.legacyRows;
      return cfSuccess([{ results: legacyPresent ? [{ name: '_migrations' }] : [] }]);
    }

    // Legacy upgrade copy. Gated on _void_migrations existing — if the
    // production code ever issues this before the CREATE, the mock surfaces
    // a "no such table" error exactly like real D1 would.
    if (/INSERT\s+OR\s+IGNORE\s+INTO\s+_void_migrations[\s\S]*FROM\s+_migrations/i.test(sql)) {
      if (!state.voidTableExists) {
        return noVoidTable();
      }
      if (state.legacyRows) {
        for (const [name, appliedAt] of state.legacyRows) {
          if (!state.trackingRows.has(name)) {
            state.trackingRows.set(name, appliedAt);
          }
        }
      }
      return cfSuccess([{ results: [] }]);
    }

    // DROP legacy table
    if (/DROP\s+TABLE\s+_migrations\b/i.test(sql)) {
      state.legacyRows = undefined;
      return cfSuccess([{ results: [] }]);
    }

    // SELECT name FROM _void_migrations (runRemoteMigrations applied set)
    if (/SELECT\s+name\s+FROM\s+_void_migrations\s*$/i.test(sql.trim())) {
      if (!state.voidTableExists) {
        return noVoidTable();
      }
      const results = Array.from(state.trackingRows.keys()).map((name) => ({ name }));
      return cfSuccess([{ results }]);
    }

    // SELECT name FROM _void_migrations WHERE name = ? — multi-statement
    // recovery recheck. Reads the live trackingRows so a concurrent winner's
    // tracking row that landed between the loser's preflight and its failing
    // SQL is correctly observed.
    if (/SELECT\s+name\s+FROM\s+_void_migrations\s+WHERE\s+name\s*=\s*\?/i.test(sql)) {
      if (!state.voidTableExists) {
        return noVoidTable();
      }
      const name = Array.isArray(params) ? (params[0] as string | undefined) : undefined;
      const found = name !== undefined && state.trackingRows.has(name) ? [{ name }] : [];
      return cfSuccess([{ results: found }]);
    }

    // SELECT name, applied_at FROM _void_migrations (GET endpoint)
    if (/SELECT\s+name,\s*applied_at\s+FROM\s+_void_migrations/i.test(sql)) {
      if (!state.voidTableExists) {
        return noVoidTable();
      }
      const results = Array.from(state.trackingRows.entries()).map(([name, applied_at]) => ({
        name,
        applied_at,
      }));
      return cfSuccess([{ results }]);
    }

    // SELECT name, applied_at FROM _migrations (legacy)
    if (/SELECT\s+name,\s*applied_at\s+FROM\s+_migrations/i.test(sql)) {
      if (!state.legacyRows) {
        return cfError('no such table: _migrations', 400);
      }
      const results = Array.from(state.legacyRows.entries()).map(([name, applied_at]) => ({
        name,
        applied_at,
      }));
      return cfSuccess([{ results }]);
    }

    // UPDATE rename
    if (/UPDATE\s+_void_migrations\s+SET\s+name\s*=\s*\?\s+WHERE\s+name\s*=\s*\?/i.test(sql)) {
      if (!state.voidTableExists) {
        return noVoidTable();
      }
      let changes = 0;
      if (Array.isArray(params) && typeof params[0] === 'string' && typeof params[1] === 'string') {
        const [to, from] = params as [string, string];
        const appliedAt = state.trackingRows.get(from);
        if (appliedAt !== undefined) {
          state.trackingRows.delete(from);
          state.trackingRows.set(to, appliedAt);
          changes = 1;
        }
      }
      return cfSuccess([{ results: [], meta: { changes } }]);
    }

    // SELECT for concurrent-rename conflict classification — the rename
    // handler re-reads both the `from` and `to` row names after a
    // zero-changes UPDATE to decide between "already landed" and 409.
    if (
      /SELECT\s+name\s+FROM\s+_void_migrations\s+WHERE\s+name\s*=\s*\?\s+OR\s+name\s*=\s*\?/i.test(
        sql,
      )
    ) {
      if (!state.voidTableExists) {
        return noVoidTable();
      }
      const results: Array<{ name: string }> = [];
      if (Array.isArray(params)) {
        for (const p of params) {
          if (typeof p === 'string' && state.trackingRows.has(p)) {
            results.push({ name: p });
          }
        }
      }
      return cfSuccess([{ results }]);
    }

    // The migration SQL and tracking row share one atomic request. Failure
    // injection above rejects the entire request before either is persisted.
    const tracking =
      /\n;\nINSERT INTO _void_migrations \(name, applied_at\) VALUES \('((?:[^']|'')*)', '([^']+)'\);$/.exec(
        sql,
      );
    if (tracking) {
      if (!state.voidTableExists) {
        return noVoidTable();
      }
      const name = tracking[1].replaceAll("''", "'");
      if (state.trackingRows.has(name)) {
        return cfError('UNIQUE constraint failed: _void_migrations.name', 500);
      }
      state.trackingRows.set(name, tracking[2]);
      return cfSuccess([{ results: [] }]);
    }

    // Application SQL — simulate real-world concurrent-CREATE races when
    // requested: first occurrence of an exact CREATE TABLE string succeeds,
    // every subsequent one returns "already exists". This is specifically
    // for the concurrent /apply test to exercise the single-statement
    // recovery path from the second request's perspective.
    if (state.simulateDuplicateCreate && /^\s*CREATE\s+TABLE\b/i.test(sql)) {
      const seen = state._seenCreateSql!;
      if (seen.has(sql)) {
        return cfError('table already exists', 500);
      }
      seen.add(sql);
    }

    // Anything else — application SQL — succeed by default
    return cfSuccess([{ results: [] }]);
  };
}

async function insertD1Resource(
  db: TestEnv['db'],
  projectId: string,
  overrides: { id?: string; cfId?: string; binding?: string } = {},
): Promise<void> {
  await db.insert(resources).values({
    id: overrides.id ?? `res_${projectId}`,
    project_id: projectId,
    type: 'd1',
    cf_id: overrides.cfId ?? `${projectId}-d1`,
    binding_name: overrides.binding ?? 'DB',
  });
}

async function insertHyperdriveResource(db: TestEnv['db'], projectId: string): Promise<void> {
  await db.insert(resources).values({
    id: `res_${projectId}_hyperdrive`,
    project_id: projectId,
    type: 'hyperdrive',
    cf_id: `${projectId}-hyperdrive`,
    binding_name: 'HYPERDRIVE',
  });
}

function authedReq(path: string, jwt: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${jwt}`);
  if (init?.body) {
    headers.set('Content-Type', 'application/json');
  }
  return new Request(`http://localhost${path}`, {
    ...init,
    headers,
  });
}

function sha256Hex(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function buildTestExecutionPlan(input: {
  name: string;
  sql: string;
  kind: 'single-statement' | 'breakpoint-framed' | 'legacy-unsplit-multi-statement';
  stability: 'stable' | 'legacy';
  statements?: Array<string>;
}): Record<string, unknown> {
  const plan: Record<string, unknown> = {
    classifierVersion: 1,
    dialect: 'sqlite',
    kind: input.kind,
    name: input.name,
    sqlHash: sha256Hex(input.sql.replaceAll(/\r\n?/g, '\n')),
    stability: input.stability,
  };
  if (input.kind === 'breakpoint-framed') {
    plan.statements = input.statements ?? [];
  }
  plan.planHash = sha256Hex(canonicalJson(plan));
  return plan;
}

describe('GET /projects/:id/migrations', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(new Request('http://localhost/projects/proj_fake/migrations'), env);
    expect(res.status).toBe(401);
  });

  it('returns 403 for wrong user', async () => {
    const alice = await createTestUser(env.db, 'alice-mig');
    const bob = await createTestUser(env.db, 'bob-mig');
    const project = await createTestProject(env.db, alice.id, 'alice-mig-app');

    const res = await app.fetch(authedReq(`/projects/${project.id}/migrations`, bob.jwt), env);
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown project id', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(authedReq('/projects/proj_nonexistent/migrations', user.jwt), env);
    expect(res.status).toBe(404);
  });

  it('returns empty applied when no D1 resource exists', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'no-d1-app');

    const res = await app.fetch(authedReq(`/projects/${project.id}/migrations`, user.jwt), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: [] });
  });

  it('returns applied migrations from platform metadata for external database projects', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-mig-status');
    await insertHyperdriveResource(env.db, project.id);
    await env.db.insert(projectMigrations).values([
      {
        project_id: project.id,
        name: '002_alter.sql',
        applied_at: '2025-01-02T00:00:00Z',
      },
      {
        project_id: project.id,
        name: '001_create.sql',
        applied_at: '2025-01-01T00:00:00Z',
      },
    ]);

    const expected = {
      applied: [
        { name: '001_create.sql', applied_at: '2025-01-01 00:00:00' },
        { name: '002_alter.sql', applied_at: '2025-01-02 00:00:00' },
      ],
    };

    for (const dialect of ['postgresql', 'mysql']) {
      const explicitDialect = await app.fetch(
        authedReq(`/projects/${project.id}/migrations?dialect=${dialect}`, user.jwt),
        env,
      );
      expect(explicitDialect.status).toBe(200);
      expect(await explicitDialect.json()).toEqual(expected);
    }

    const inferredDialect = await app.fetch(
      authedReq(`/projects/${project.id}/migrations`, user.jwt),
      env,
    );
    expect(inferredDialect.status).toBe(200);
    expect(await inferredDialect.json()).toEqual(expected);
  });

  it('returns applied migrations from _void_migrations', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'd1-mig-app');
    await insertD1Resource(env.db, project.id);

    mockCfApi({
      queryD1: () =>
        cfSuccess([
          {
            results: [
              { name: '001_create.sql', applied_at: '2025-01-01T00:00:00Z' },
              { name: '002_alter.sql', applied_at: '2025-01-02T00:00:00Z' },
            ],
          },
        ]),
    });

    const res = await app.fetch(authedReq(`/projects/${project.id}/migrations`, user.jwt), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      applied: [
        { name: '001_create.sql', applied_at: '2025-01-01T00:00:00Z' },
        { name: '002_alter.sql', applied_at: '2025-01-02T00:00:00Z' },
      ],
    });
  });

  it('merges rows from _void_migrations and legacy _migrations without duplicates and sorts by name', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'd1-mig-merge');
    await insertD1Resource(env.db, project.id);

    // Two entries in the new table, two (one overlapping, one older) in the legacy.
    const state = createD1State({
      trackingRows: new Map([
        ['002_alter.sql', '2025-01-02T00:00:00Z'],
        ['003_index.sql', '2025-01-03T00:00:00Z'],
      ]),
      legacyRows: new Map([
        ['001_init.sql', '2024-12-31T00:00:00Z'],
        ['002_alter.sql', '2024-12-31T10:00:00Z'], // duplicate with different timestamp
      ]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(authedReq(`/projects/${project.id}/migrations`, user.jwt), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      applied: Array<{ name: string; applied_at: string }>;
    };
    // Sorted by name; _void_migrations is primary so duplicate keeps its timestamp
    expect(body.applied).toEqual([
      { name: '001_init.sql', applied_at: '2024-12-31T00:00:00Z' },
      { name: '002_alter.sql', applied_at: '2025-01-02T00:00:00Z' },
      { name: '003_index.sql', applied_at: '2025-01-03T00:00:00Z' },
    ]);
  });

  it('tolerates a missing _void_migrations table and returns only legacy rows', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'd1-mig-legacy-only');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({
      legacyRows: new Map([['001_init.sql', '2024-06-01T00:00:00Z']]),
      failingSqlPatterns: [
        {
          match: /SELECT\s+name,\s*applied_at\s+FROM\s+_void_migrations/i,
          message: 'no such table: _void_migrations',
          status: 400,
        },
      ],
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(authedReq(`/projects/${project.id}/migrations`, user.jwt), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      applied: [{ name: '001_init.sql', applied_at: '2024-06-01T00:00:00Z' }],
    });
  });

  it('surfaces a non-missing-table D1 failure on _void_migrations as 500', async () => {
    // CF API token expired, quota hit, "database is locked", … must not be
    // reported as `{ applied: [] }`, which looks identical to "nothing has
    // been applied yet" and causes callers to re-run migrations or make
    // other catastrophic decisions. GET surfaces everything that isn't a
    // plain missing-table error.
    //
    // Note: GET reads `_migrations` first (torn-read safety). The legacy read
    // returns "no such table" here (mock has no legacyRows), which is
    // swallowed. The _void_migrations read then fires and its auth error
    // must surface as a 500, not get papered over as an empty response.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'd1-mig-auth-fail');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({
      failingSqlPatterns: [
        {
          match: /SELECT\s+name,\s*applied_at\s+FROM\s+_void_migrations/i,
          message: 'Authentication error: bad token',
          status: 401,
        },
      ],
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(authedReq(`/projects/${project.id}/migrations`, user.jwt), env);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Authentication error');
  });

  it('reads legacy _migrations before _void_migrations (torn-read safety)', async () => {
    // GET must read the legacy table FIRST so that an in-flight upgrade
    // racing past `DROP TABLE _migrations` does not make applied migrations
    // transiently disappear. The upgrade is three non-atomic D1 calls:
    //   1. CREATE _void_migrations
    //   2. INSERT OR IGNORE ... FROM _migrations
    //   3. DROP TABLE _migrations
    //
    // If GET reads _void_migrations first, it can observe an empty result
    // (pre-upgrade: table just created but not populated) and then find
    // _migrations missing — returning `{ applied: [] }` for a project that
    // has migrations applied. Reading legacy first is race-free because
    // _migrations can only disappear AFTER its rows were copied into
    // _void_migrations, so the earlier read always captures a consistent
    // snapshot.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'd1-mig-read-order');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({
      trackingRows: new Map([['001_init.sql', '2025-01-01T00:00:00Z']]),
      legacyRows: new Map([['000_bootstrap.sql', '2024-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(authedReq(`/projects/${project.id}/migrations`, user.jwt), env);
    expect(res.status).toBe(200);

    const reads = state.queries
      .map((q) => q.sql)
      .filter((s) => /SELECT\s+name,\s*applied_at\s+FROM\s+_(?:void_)?migrations/i.test(s));
    // _migrations first, _void_migrations second
    expect(reads[0]).toMatch(/FROM\s+_migrations\b/i);
    expect(reads[1]).toMatch(/FROM\s+_void_migrations\b/i);
  });

  it('surfaces a non-missing-table D1 failure on legacy _migrations as 500', async () => {
    // Same discipline as the primary-table error path: if the legacy
    // probe returns anything other than "no such table", the endpoint
    // must refuse to paper over it.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'd1-mig-legacy-fail');
    await insertD1Resource(env.db, project.id);

    // _void_migrations is missing → first try throws "no such table"
    // (swallowed). Then the legacy probe fires and returns a real error
    // (not missing-table) → must surface.
    const state = createD1State({
      failingSqlPatterns: [
        {
          match: /SELECT\s+name,\s*applied_at\s+FROM\s+_void_migrations/i,
          message: 'no such table: _void_migrations',
          status: 400,
        },
        {
          match: /SELECT\s+name,\s*applied_at\s+FROM\s+_migrations/i,
          message: 'D1_ERROR: network timeout',
          status: 504,
        },
      ],
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(authedReq(`/projects/${project.id}/migrations`, user.jwt), env);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('network timeout');
  });
});

describe('POST /projects/:id/migrations/apply', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_fake/migrations/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ migrations: [] }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 for wrong user', async () => {
    const alice = await createTestUser(env.db, 'alice-apply');
    const bob = await createTestUser(env.db, 'bob-apply');
    const project = await createTestProject(env.db, alice.id, 'alice-apply-app');

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, bob.jwt, {
        method: 'POST',
        body: JSON.stringify({ migrations: [] }),
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown project id', async () => {
    const user = await createTestUser(env.db);
    const res = await app.fetch(
      authedReq('/projects/proj_nope/migrations/apply', user.jwt, {
        method: 'POST',
        body: JSON.stringify({ migrations: [] }),
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it('preserves the owner-suspension error from the locked capability recheck', async () => {
    const owner = await createTestUser(env.db, 'suspended-apply-owner');
    const collaborator = await createTestUser(env.db, 'suspended-apply-collaborator');
    const project = await createTestProject(env.db, owner.id, 'suspended-apply-project');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: collaborator.id,
      role: 'collaborator',
      added_by_user_id: owner.id,
    });

    const requireCapability = projectAccess.requireProjectCapability;
    let suspended = false;
    vi.spyOn(projectAccess, 'requireProjectCapability').mockImplementation(async (...args) => {
      const access = await requireCapability(...args);
      if (!suspended && args[3] === 'configure') {
        suspended = true;
        await env.db
          .update(users)
          .set({ suspended_reason: 'platform policy violation' })
          .where(eq(users.id, owner.id));
      }
      return access;
    });

    const response = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, collaborator.jwt, {
        method: 'POST',
        body: JSON.stringify({ migrations: [] }),
      }),
      env,
    );

    expect(suspended).toBe(true);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'project owner suspended',
      message: expect.stringMatching(/contact the platform administrator/i),
    });
  });

  it('returns 400 when no D1 resource exists', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'no-d1-apply');

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ migrations: [{ name: '001.sql', sql: 'SELECT 1' }] }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'no D1 database found for this project' });
  });

  it('returns 400 for invalid payload (missing migrations array)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'bad-payload-1');
    await insertD1Resource(env.db, project.id);

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'migrations array required' });
  });

  it('returns 400 for invalid payload (non-array migrations)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'bad-payload-2');
    await insertD1Resource(env.db, project.id);

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ migrations: 'nope' }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when a migration entry has a missing or non-string name', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'bad-payload-3');
    await insertD1Resource(env.db, project.id);

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ migrations: [{ sql: 'SELECT 1' }] }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'each migration must have a non-empty string "name" and string "sql"',
    });
  });

  it('returns 400 when a migration entry has a non-string sql', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'bad-payload-4');
    await insertD1Resource(env.db, project.id);

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001.sql', sql: 42 }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when a migration entry has an empty name', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'bad-payload-5');
    await insertD1Resource(env.db, project.id);

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '', sql: 'SELECT 1' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when the payload contains duplicate migration names', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'dup-names');
    await insertD1Resource(env.db, project.id);

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            { name: '001.sql', sql: 'SELECT 1' },
            { name: '001.sql', sql: 'SELECT 2' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'duplicate migration name: 001.sql' });
  });

  it('accepts protocol v2 execution plans only after server classification matches', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'v2-plan-ok');
    await insertD1Resource(env.db, project.id);
    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const sql = 'CREATE TABLE a (id TEXT);\n--> statement-breakpoint\nCREATE TABLE b (id TEXT);';
    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrationProtocolVersion: 2,
          migrations: [{ name: '001_breakpoints.sql', sql }],
          executionPlans: [
            buildTestExecutionPlan({
              name: '001_breakpoints.sql',
              sql,
              kind: 'breakpoint-framed',
              stability: 'stable',
              statements: ['CREATE TABLE a (id TEXT);', 'CREATE TABLE b (id TEXT);'],
            }),
          ],
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings?: Array<string>; applied: Array<string> };
    expect(body.applied).toEqual(['001_breakpoints.sql']);
    expect(body.warnings?.[0]).toContain('legacy compensating runner');
    expect(state.trackingRows.has('001_breakpoints.sql')).toBe(true);
  });

  it('rejects execution plans whose breakpoint statements only match marker-shaped strings', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'v2-plan-bad');
    const sql =
      "INSERT INTO logs(message) VALUES('--> statement-breakpoint');\n" +
      'CREATE TABLE later (id TEXT);';

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrationProtocolVersion: 2,
          migrations: [{ name: '001_bad_plan.sql', sql }],
          executionPlans: [
            buildTestExecutionPlan({
              name: '001_bad_plan.sql',
              sql,
              kind: 'breakpoint-framed',
              stability: 'stable',
              statements: [
                "INSERT INTO logs(message) VALUES('",
                "');\nCREATE TABLE later (id TEXT);",
              ],
            }),
          ],
        }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      'kind does not match server classification',
    );
  });

  it('accepts an empty migrations array and reports zero applied and zero skipped', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'empty-apply');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ migrations: [] }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applied: [], skipped: [] });
  });

  it('applies a fresh migration end-to-end and writes the tracking row', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'fresh-apply');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001_init.sql', sql: 'CREATE TABLE users (id TEXT PRIMARY KEY)' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['001_init.sql'],
      skipped: [],
    });
    expect(state.trackingRows.has('001_init.sql')).toBe(true);
  });

  it('skips migrations already recorded in the tracking table', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'skip-applied');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({
      trackingRows: new Map([['001_init.sql', '2024-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            { name: '001_init.sql', sql: 'CREATE TABLE users (id TEXT)' },
            { name: '002_new.sql', sql: 'CREATE TABLE posts (id TEXT)' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['002_new.sql'],
      skipped: ['001_init.sql'],
    });
  });

  it('upgrades the legacy _migrations table into _void_migrations before applying', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'legacy-upgrade');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({
      legacyRows: new Map([['001_init.sql', '2024-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            { name: '001_init.sql', sql: 'CREATE TABLE users (id TEXT)' },
            { name: '002_posts.sql', sql: 'CREATE TABLE posts (id TEXT)' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['002_posts.sql'],
      skipped: ['001_init.sql'],
    });
    // Legacy table was dropped and row was migrated into _void_migrations
    expect(state.legacyRows).toBeUndefined();
    expect(state.trackingRows.get('001_init.sql')).toBe('2024-01-01T00:00:00Z');
    expect(state.trackingRows.has('002_posts.sql')).toBe(true);

    // Pin the exact query ordering for ensureTrackingTable + upgrade:
    //   1. CREATE TABLE IF NOT EXISTS _void_migrations
    //   2. sqlite_master probe for _migrations
    //   3. INSERT OR IGNORE ... FROM _migrations (copy)
    //   4. DROP TABLE _migrations
    //   5. SELECT name FROM _void_migrations (applied set)
    // Any reordering that moves an INSERT / UPDATE / SELECT on
    // _void_migrations before the CREATE would have been caught by the
    // mock's `voidTableExists` gating, but pinning the order here gives
    // the whole upgrade a single assertion to regress on.
    const upgradeSteps = state.queries
      .map((q) => q.sql)
      .filter((s) =>
        /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+_void_migrations|FROM\s+sqlite_master|INSERT\s+OR\s+IGNORE\s+INTO\s+_void_migrations[\s\S]*FROM\s+_migrations|DROP\s+TABLE\s+_migrations\b|^\s*SELECT\s+name\s+FROM\s+_void_migrations\s*$/i.test(
          s,
        ),
      );
    expect(upgradeSteps[0]).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+_void_migrations/i);
    expect(upgradeSteps[1]).toMatch(/FROM\s+sqlite_master/i);
    expect(upgradeSteps[2]).toMatch(
      /INSERT\s+OR\s+IGNORE\s+INTO\s+_void_migrations[\s\S]*FROM\s+_migrations/i,
    );
    expect(upgradeSteps[3]).toMatch(/DROP\s+TABLE\s+_migrations\b/i);
    expect(upgradeSteps[4]).toMatch(/^\s*SELECT\s+name\s+FROM\s+_void_migrations\s*$/i);
  });

  it('upgrade preserves existing _void_migrations timestamps when legacy has a conflicting row', async () => {
    // Real-world migration path: a project ran the old `_migrations`
    // tracking table, partially upgraded, and now has both tables with
    // an overlapping row. Production uses `INSERT OR IGNORE … FROM
    // _migrations`, so the existing `_void_migrations` row must win for
    // the overlap and the missing legacy rows must be copied verbatim.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'legacy-overlap');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({
      trackingRows: new Map([
        ['001_init.sql', '2025-06-01T00:00:00Z'], // newer, wins on overlap
        ['002_alter.sql', '2025-06-02T00:00:00Z'],
      ]),
      legacyRows: new Map([
        ['001_init.sql', '2024-01-01T00:00:00Z'], // older, should NOT overwrite
        ['003_index.sql', '2024-02-02T00:00:00Z'], // missing from void — should copy
      ]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    // Empty migrations list — we only want to exercise ensureTrackingTable
    // + upgrade + applied-set return, not apply anything new.
    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ migrations: [] }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applied: [], skipped: [] });

    // Legacy table was dropped; all three rows in the current table.
    expect(state.legacyRows).toBeUndefined();
    expect(state.trackingRows.size).toBe(3);
    // Overlap: void-side timestamp preserved (INSERT OR IGNORE does NOT overwrite).
    expect(state.trackingRows.get('001_init.sql')).toBe('2025-06-01T00:00:00Z');
    // Non-overlap: void-side row untouched.
    expect(state.trackingRows.get('002_alter.sql')).toBe('2025-06-02T00:00:00Z');
    // Missing-from-void row was copied verbatim, including its applied_at.
    expect(state.trackingRows.get('003_index.sql')).toBe('2024-02-02T00:00:00Z');
  });

  it('tolerates a concurrent legacy-upgrade race where the winner already copied and dropped', async () => {
    // Two overlapping /migrations/apply calls both pass the sqlite_master
    // probe for `_migrations` in ensureTrackingTable. The winner runs the
    // INSERT OR IGNORE ... FROM _migrations copy AND drops the legacy
    // table. The loser's copy INSERT then fails with `no such table:
    // _migrations` because the winner's DROP already landed. The loser's
    // copy INSERT must catch ONLY `no such table` errors and continue;
    // the DROP fails safely via the existing catch; the loser completes
    // with 200.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'legacy-upgrade-race');
    await insertD1Resource(env.db, project.id);

    // Simulate the winner's outcome: the legacy rows have already been
    // copied into `_void_migrations` and the legacy table was dropped by
    // the time the loser's copy INSERT dispatches. We model this by
    // starting with the rows already in trackingRows and no legacyRows,
    // BUT keeping the sqlite_master probe returning the legacy table as
    // present — which is what the loser would see because both callers
    // probed before either's upgrade ran. The failing-pattern then makes
    // the loser's INSERT fail with `no such table` exactly like D1 would.
    //
    // The mock's sqlite_master probe checks `!!state.legacyRows`, so we
    // keep it defined (empty map) just for the probe and flip it off
    // inside the failing-pattern so any subsequent DROP also reports
    // "already gone" style behavior.
    const state = createD1State({
      trackingRows: new Map([['001_init.sql', '2024-01-01T00:00:00Z']]),
      legacyRows: new Map(),
      failingSqlPatterns: [
        {
          match: /INSERT\s+OR\s+IGNORE\s+INTO\s+_void_migrations[\s\S]*FROM\s+_migrations/i,
          message: 'no such table: _migrations',
          status: 400,
        },
      ],
    });
    // The probe path reads `!!state.legacyRows`; an empty Map is truthy,
    // so the probe reports the legacy table as present (matching what the
    // loser would see before its own upgrade runs). That drives the copy
    // INSERT, which the failing-pattern rejects with `no such table`.
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            { name: '001_init.sql', sql: 'CREATE TABLE users (id TEXT)' },
            { name: '002_posts.sql', sql: 'CREATE TABLE posts (id TEXT)' },
          ],
        }),
      }),
      env,
    );

    // Must NOT 500 even though the copy INSERT failed with `no such table`.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['002_posts.sql'],
      skipped: ['001_init.sql'],
    });
    // The winner's row is still there and the new migration was tracked.
    expect(state.trackingRows.get('001_init.sql')).toBe('2024-01-01T00:00:00Z');
    expect(state.trackingRows.has('002_posts.sql')).toBe(true);
  });

  it('blocks a pending destructive migration without the pragma', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'destructive-block');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001_drop.sql', sql: 'DROP TABLE users' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('001_drop.sql');
    expect(body.error).toContain('void:allow-destructive');
    // Destructive was blocked before any DDL was issued to D1
    const appSql = state.queries.find((q) => /DROP\s+TABLE\s+users/i.test(q.sql));
    expect(appSql).toBeUndefined();
  });

  it('blocks a destructive migration with a malformed pragma (missing space after --)', async () => {
    // Production uses `sql.includes(DESTRUCTIVE_PRAGMA)` with the exact
    // literal `-- void:allow-destructive`. A pragma like
    // `--void:allow-destructive` (no space after `--`) is not a valid
    // SQL comment in sqlite and must not unlock the destructive path —
    // pin that so anyone who loosens the matcher trips this test.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'destructive-near-miss-1');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_drop.sql',
              sql: '--void:allow-destructive\nDROP TABLE users',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('001_drop.sql');
    // Nothing reached D1 — the destructive guard short-circuited before
    // any application SQL was submitted.
    const droppedReached = state.queries.find((q) => /DROP\s+TABLE\s+users/i.test(q.sql));
    expect(droppedReached).toBeUndefined();
  });

  it('blocks a destructive migration whose pragma is hidden in a string literal (not a real comment)', async () => {
    // Attack: the pragma appears inside a string literal, not as a SQL
    // comment. A raw `sql.includes('-- void:allow-destructive')` check
    // authorizes the request even though the literal is just data, not a
    // directive. The route tokenizes strings/comments and only honors the
    // pragma when it's a real comment.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'destructive-literal-attack');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_sneaky.sql',
              sql:
                "INSERT INTO notes(txt) VALUES('-- void:allow-destructive');\n" +
                'DROP TABLE users;',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('001_sneaky.sql');
    expect(body.error).toContain('void:allow-destructive');
    // Nothing reached D1 — the destructive guard short-circuited
    const droppedReached = state.queries.find((q) => /DROP\s+TABLE\s+users/i.test(q.sql));
    expect(droppedReached).toBeUndefined();
  });

  it('blocks a destructive migration whose pragma is inside an identifier quote', async () => {
    // Variant of the string-literal attack: a double-quoted identifier
    // that happens to contain the pragma text. Identifier quotes are not
    // comments, so they must not authorize destructive SQL.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'destructive-ident-attack');
    await insertD1Resource(env.db, project.id);

    mockCfApi({ queryD1: makeQueryD1(createD1State()) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_ident.sql',
              sql: 'CREATE TABLE "-- void:allow-destructive" (id TEXT);\nDROP TABLE users;',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('does not false-positive on a destructive pattern that only appears inside a string literal', async () => {
    // Symmetric to the pragma attack: DESTRUCTIVE_PATTERNS must NOT match
    // when they only appear inside a string literal. A migration like
    // `INSERT INTO audit_log VALUES('DROP TABLE users')` is legitimate
    // logging data, not a destructive DDL, and must apply without the
    // pragma.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'no-false-positive');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_audit.sql',
              sql:
                'CREATE TABLE audit_log (msg TEXT);\n' +
                "INSERT INTO audit_log (msg) VALUES ('DROP TABLE users');",
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['001_audit.sql'],
      skipped: [],
    });
  });

  it('blocks a destructive migration with an upper-case pragma variant', async () => {
    // The pragma match is exact casing — "-- VOID:ALLOW-DESTRUCTIVE"
    // must stay blocked even though the intent is obvious. This pins
    // the matcher so it can't silently be replaced with a case-
    // insensitive `toLowerCase().includes(...)`.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'destructive-near-miss-2');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_drop.sql',
              sql: '-- VOID:ALLOW-DESTRUCTIVE\nDROP TABLE users',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const droppedReached = state.queries.find((q) => /DROP\s+TABLE\s+users/i.test(q.sql));
    expect(droppedReached).toBeUndefined();
  });

  it('allows a destructive migration when the pragma is present', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'destructive-ok');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_drop.sql',
              sql: '-- void:allow-destructive\nDROP TABLE legacy_users',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['001_drop.sql'],
      skipped: [],
    });
  });

  it('covers the DROP COLUMN destructive pattern', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'drop-col-block');
    await insertD1Resource(env.db, project.id);

    mockCfApi({ queryD1: makeQueryD1(createD1State()) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_drop_col.sql',
              sql: 'ALTER TABLE users DROP COLUMN email',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('covers the ALTER TABLE RENAME destructive pattern', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'alter-rename-block');
    await insertD1Resource(env.db, project.id);

    mockCfApi({ queryD1: makeQueryD1(createD1State()) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_rename.sql',
              sql: 'ALTER TABLE users RENAME TO customers',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('covers the TRUNCATE destructive pattern', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'truncate-block');
    await insertD1Resource(env.db, project.id);

    mockCfApi({ queryD1: makeQueryD1(createD1State()) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_trunc.sql',
              sql: 'TRUNCATE TABLE sessions',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('blocks a DROP VIEW migration without the pragma', async () => {
    // Views can be load-bearing parts of an app schema (materialized
    // lookups, exposed read APIs), so dropping one without the pragma
    // must require the same explicit opt-in as DROP TABLE.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'drop-view-block');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_drop_view.sql',
              sql: 'DROP VIEW active_users',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('void:allow-destructive');
    // The DDL must not have been dispatched — the guard short-circuits.
    expect(state.queries.find((q) => /DROP\s+VIEW/i.test(q.sql))).toBeUndefined();
  });

  it('blocks a quoted-identifier ALTER TABLE RENAME', async () => {
    // A SQLite-valid form like
    // `ALTER TABLE "user data" RENAME TO users_archive` (quoted
    // identifier with whitespace) must still be caught by the guard.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'alter-rename-quoted');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_quoted_rename.sql',
              sql: 'ALTER TABLE "user data" RENAME TO users_archive',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('void:allow-destructive');
    expect(state.queries.find((q) => /RENAME/i.test(q.sql))).toBeUndefined();
  });

  it('blocks destructive SQL whose pragma is documentation inside a block comment', async () => {
    // Only a standalone `-- void:allow-destructive` line-comment
    // directive authorizes. A docstring like
    //   /* See -- void:allow-destructive for usage */
    // is documentation, not authorization.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pragma-in-block');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_drop.sql',
              sql:
                '/* docs: use -- void:allow-destructive to permit table drops */\n' +
                'DROP TABLE users',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('void:allow-destructive');
    expect(state.queries.find((q) => /DROP\s+TABLE\s+users/i.test(q.sql))).toBeUndefined();
  });

  it('blocks destructive SQL whose pragma is part of a longer line comment', async () => {
    // A line comment that mentions the pragma but is not standalone — e.g.
    //   -- TODO: maybe add void:allow-destructive here?
    // — must NOT authorize. Only a line comment whose trimmed content is
    // exactly `-- void:allow-destructive` counts.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pragma-in-line-doc');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_drop.sql',
              sql: '-- TODO: maybe add -- void:allow-destructive here?\n' + 'DROP TABLE users',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('void:allow-destructive');
    expect(state.queries.find((q) => /DROP\s+TABLE\s+users/i.test(q.sql))).toBeUndefined();
  });

  it('blocks DROP TABLE separated from its keyword by a block comment', async () => {
    // SQLite parses `DROP/**/TABLE users` as a real DROP TABLE. Block
    // comments must be replaced with a single space (not deleted) so
    // `DROP/**/TABLE` becomes `DROP TABLE` in the tokenized code stream
    // and the guard regex fires.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'block-comment-bypass');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001_drop.sql', sql: 'DROP/**/TABLE users' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('void:allow-destructive');
    // The DDL must not have been dispatched — the guard short-circuits before
    // any application SQL hits the mock.
    expect(state.queries.find((q) => /DROP[\s\S]*TABLE/i.test(q.sql))).toBeUndefined();
  });

  it('blocks ALTER TABLE RENAME TO separated by a block comment', async () => {
    // Companion to the DROP TABLE block-comment test. The RENAME family
    // must also be caught when the ALTER keyword is separated from TABLE
    // by a block comment.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'block-comment-rename');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_rename.sql',
              sql: 'ALTER/**/TABLE users RENAME TO users_archive',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('void:allow-destructive');
    expect(state.queries.find((q) => /RENAME/i.test(q.sql))).toBeUndefined();
  });

  it('blocks destructive SQL with a trailing pragma on the same line', async () => {
    // The standalone-pragma rule must verify the `--` starts its line.
    // Otherwise a migration like:
    //   CREATE TABLE t (id TEXT); -- void:allow-destructive
    //   DROP TABLE users
    // would extract `-- void:allow-destructive` from the trailing comment
    // on line 1 and authorize the DROP TABLE on line 2.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'trailing-pragma');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_drop.sql',
              sql: 'CREATE TABLE t (id TEXT); -- void:allow-destructive\nDROP TABLE users',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('void:allow-destructive');
    expect(state.queries.find((q) => /DROP\s+TABLE\s+users/i.test(q.sql))).toBeUndefined();
  });

  it('still authorizes a standalone-line pragma directive', async () => {
    // A real standalone pragma line authorizes destructive SQL exactly
    // as documented.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'standalone-pragma');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_drop.sql',
              sql: '-- void:allow-destructive\nDROP TABLE users',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(state.queries.find((q) => /DROP\s+TABLE\s+users/i.test(q.sql))).toBeDefined();
    expect(state.trackingRows.has('001_drop.sql')).toBe(true);
  });

  it('does NOT block ALTER TABLE ADD COLUMN named "rename"', async () => {
    // A broad regex like `/\bALTER\s+TABLE\b[^;]*?\bRENAME\b/i` would
    // match any later token named `rename`, not actual rename syntax.
    // A legal additive migration like
    // `ALTER TABLE users ADD COLUMN rename TEXT` must pass through.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'add-col-named-rename');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_add_col_rename.sql',
              sql: 'ALTER TABLE users ADD COLUMN rename TEXT',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    // The migration was actually dispatched and recorded, not gated.
    expect(
      state.queries.find((q) => /ALTER\s+TABLE\s+users\s+ADD\s+COLUMN\s+rename/i.test(q.sql)),
    ).toBeDefined();
    expect(state.trackingRows.has('001_add_col_rename.sql')).toBe(true);
  });

  it('still blocks ALTER TABLE RENAME COLUMN', async () => {
    // Counterpart to the ADD COLUMN test: the narrowed regex must still
    // catch the real destructive forms — RENAME TO (table rename) and
    // RENAME COLUMN.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rename-column-still-blocked');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_rename_col.sql',
              sql: 'ALTER TABLE users RENAME COLUMN name TO full_name',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('void:allow-destructive');
    expect(state.queries.find((q) => /RENAME\s+COLUMN/i.test(q.sql))).toBeUndefined();
  });

  it('blocks legacy ALTER TABLE RENAME <col> TO <col> without COLUMN keyword', async () => {
    // SQLite still accepts the legacy bare column rename form
    // `ALTER TABLE t RENAME old_col TO new_col` (no `COLUMN` keyword).
    // The destructive regex must catch this alongside RENAME TO / RENAME
    // COLUMN.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'legacy-rename-bare');
    await insertD1Resource(env.db, project.id);
    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_rename.sql',
              sql: 'ALTER TABLE users RENAME old_col TO new_col',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('void:allow-destructive');
    expect(state.queries.find((q) => /RENAME/i.test(q.sql))).toBeUndefined();
  });

  it('allows legacy ALTER TABLE RENAME <col> TO <col> with the pragma', async () => {
    // When the caller acknowledges the legacy form is destructive via
    // the standalone pragma, the migration runs.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'legacy-rename-bare-ok');
    await insertD1Resource(env.db, project.id);
    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_rename.sql',
              sql: '-- void:allow-destructive\nALTER TABLE users RENAME old_col TO new_col',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(state.trackingRows.has('001_rename.sql')).toBe(true);
  });

  it('blocks legacy ALTER TABLE RENAME with double-quoted identifiers', async () => {
    // Same legacy bare form but using `"old col"` / `"new col"` identifier
    // quoting. The tokenizer replaces the body with `"_"`, so the legacy
    // branch `[^;\s]+\s+TO\b` matches on the placeholder.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'legacy-rename-quoted');
    await insertD1Resource(env.db, project.id);
    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_rename.sql',
              sql: 'ALTER TABLE users RENAME "old col" TO "new col"',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('void:allow-destructive');
  });

  it('blocks legacy ALTER TABLE RENAME with bracketed identifiers', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'legacy-rename-bracket');
    await insertD1Resource(env.db, project.id);
    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_rename.sql',
              sql: 'ALTER TABLE users RENAME [old col] TO [new col]',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('void:allow-destructive');
  });

  it('does NOT block ALTER TABLE ADD COLUMN rename TEXT under the widened regex', async () => {
    // The legacy-form branch is `RENAME <tok> TO <tok>` — it requires a
    // trailing `TO` keyword after the identifier. An additive column named
    // `rename` has no trailing `TO`, so the widened regex must still let
    // it through.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'add-col-rename-r6');
    await insertD1Resource(env.db, project.id);
    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001_add.sql', sql: 'ALTER TABLE users ADD COLUMN rename TEXT' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(state.trackingRows.has('001_add.sql')).toBe(true);
  });

  it('does NOT block ALTER TABLE ADD COLUMN rename_col TEXT NOT NULL DEFAULT', async () => {
    // Variant with NOT NULL DEFAULT to ensure the trailing type/constraint
    // tokens don't accidentally satisfy the `[^;\s]+\s+TO\b` branch.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'add-col-rename-default');
    await insertD1Resource(env.db, project.id);
    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_add.sql',
              sql: "ALTER TABLE users ADD COLUMN rename_col TEXT NOT NULL DEFAULT ''",
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(state.trackingRows.has('001_add.sql')).toBe(true);
  });

  it('blocks ALTER TABLE RENAME TO with a semicolon inside a double-quoted identifier', async () => {
    // A semicolon inside a quoted identifier must not truncate the
    // `[^;]*?` lookahead in the destructive ALTER RENAME regex. Identifier
    // bodies are replaced with a neutral `_` placeholder so the code
    // stream contains `ALTER TABLE "_" RENAME TO users_archive` and the
    // guard fires.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'quoted-semicolon-rename');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_rename.sql',
              sql: 'ALTER TABLE "user;data" RENAME TO users_archive',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('void:allow-destructive');
    expect(state.queries.find((q) => /RENAME\s+TO/i.test(q.sql))).toBeUndefined();
  });

  it('blocks ALTER TABLE RENAME COLUMN with a semicolon inside a square-bracket identifier', async () => {
    // SQLite also accepts `[...]` bracket identifiers (T-SQL
    // compatibility). A bracketed identifier containing a semicolon
    // must not bypass the destructive guard.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'bracket-semicolon-rename');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_rename_col.sql',
              sql: 'ALTER TABLE [user;data] RENAME COLUMN a TO b',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('void:allow-destructive');
    expect(state.queries.find((q) => /RENAME\s+COLUMN/i.test(q.sql))).toBeUndefined();
  });

  it('blocks ALTER TABLE RENAME TO with a semicolon inside a backtick identifier', async () => {
    // MySQL-style backtick identifiers. The placeholder replacement
    // applies uniformly to all three identifier quote forms the tokenizer
    // recognizes.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'backtick-semicolon-rename');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_rename.sql',
              sql: 'ALTER TABLE `user;data` RENAME TO x',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('void:allow-destructive');
    expect(state.queries.find((q) => /RENAME\s+TO/i.test(q.sql))).toBeUndefined();
  });

  it('does NOT block CREATE TABLE with a destructive keyword inside the identifier', async () => {
    // Identifier bodies are replaced with a neutral placeholder so
    // destructive keywords INSIDE identifiers don't false-positive against
    // the destructive-pattern regexes. A legal migration like
    // `CREATE TABLE "DROP TABLE users" (x INT)` creates a table whose
    // name happens to contain the text "DROP TABLE users" — benign, and
    // the code stream sees `CREATE TABLE "_" (x INT)`.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'identifier-false-positive');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_weird_name.sql',
              sql: 'CREATE TABLE "DROP TABLE users" (x INT)',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    // The migration was actually dispatched and recorded, not gated.
    expect(state.queries.find((q) => /CREATE\s+TABLE/i.test(q.sql))).toBeDefined();
    expect(state.trackingRows.has('001_weird_name.sql')).toBe(true);
  });

  it('does not block a destructive migration that is already recorded as applied', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'destructive-already-applied');
    await insertD1Resource(env.db, project.id);

    // 001 is already in _void_migrations, so even though its SQL is
    // destructive the filter-then-check path lets the request through
    // (nothing in the pending slice is destructive).
    const state = createD1State({
      trackingRows: new Map([['001_drop.sql', '2024-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            { name: '001_drop.sql', sql: 'DROP TABLE users' },
            { name: '002_add.sql', sql: 'CREATE TABLE posts (id TEXT)' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['002_add.sql'],
      skipped: ['001_drop.sql'],
    });
  });

  it('blocks unbounded DELETE FROM without a WHERE clause', async () => {
    // An unbounded `DELETE FROM users` silently empties a table and has
    // the same irreversible blast radius as DROP TABLE, so it must
    // require the same explicit pragma opt-in.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-unbounded-delete');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001_delete.sql', sql: 'DELETE FROM users' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('001_delete.sql');
    expect(body.error).toContain('void:allow-destructive');
    expect(state.queries.find((q) => /DELETE\s+FROM\s+users/i.test(q.sql))).toBeUndefined();
  });

  it('blocks unbounded UPDATE without a WHERE clause', async () => {
    // A bare `UPDATE users SET email = NULL` mass-mutates every row.
    // Equivalent blast radius to DROP COLUMN, so it requires the pragma.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-unbounded-update');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001_update.sql', sql: 'UPDATE users SET email = NULL' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('001_update.sql');
    expect(body.error).toContain('void:allow-destructive');
    expect(state.queries.find((q) => /UPDATE\s+users\s+SET/i.test(q.sql))).toBeUndefined();
  });

  it('blocks unbounded DELETE even when a later statement has a WHERE clause', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f4-delete-later-where');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_mixed.sql',
              sql: "DELETE FROM users; UPDATE posts SET name = 'ok' WHERE id = '1';",
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('void:allow-destructive');
    expect(state.queries.find((q) => /DELETE\s+FROM\s+users/i.test(q.sql))).toBeUndefined();
  });

  it('blocks unbounded UPDATE when WHERE only appears inside a subquery', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f4-update-subquery-where');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_update.sql',
              sql: "UPDATE users SET name = (SELECT name FROM posts WHERE id = '1');",
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('void:allow-destructive');
    expect(state.queries.find((q) => /UPDATE\s+users\s+SET/i.test(q.sql))).toBeUndefined();
  });

  it('blocks INSERT OR REPLACE INTO without the pragma', async () => {
    // `INSERT OR REPLACE` silently deletes any row that collides with
    // the inserted primary key — a destructive overwrite dressed up as
    // an insert.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-insert-or-replace');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_replace.sql',
              sql: "INSERT OR REPLACE INTO users (id, name) VALUES (1, 'x')",
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('001_replace.sql');
    expect(body.error).toContain('void:allow-destructive');
    expect(state.queries.find((q) => /INSERT\s+OR\s+REPLACE\s+INTO/i.test(q.sql))).toBeUndefined();
  });

  it('blocks a trigger body containing unbounded DELETE', async () => {
    // The outer `CREATE TRIGGER` is benign DDL, but its body can contain
    // any statement the engine supports — including unbounded
    // DELETE/UPDATE/DROP. The guard must catch destructive DML nested in
    // a BEGIN…END block.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-trigger-delete');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_trigger.sql',
              sql: 'CREATE TRIGGER t AFTER INSERT ON logs BEGIN DELETE FROM old_logs; END',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('001_trigger.sql');
    expect(body.error).toContain('void:allow-destructive');
    expect(state.queries.find((q) => /DELETE\s+FROM\s+old_logs/i.test(q.sql))).toBeUndefined();
  });

  it('blocks a TEMP TRIGGER body containing unbounded UPDATE', async () => {
    // SQLite accepts the `TEMP` (and `TEMPORARY`) qualifier between
    // CREATE and TRIGGER. The trigger-body detector must accept both
    // forms so the temp qualifier can't be used to sidestep the recursion.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-temp-trigger');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_temp_trigger.sql',
              sql: 'CREATE TEMP TRIGGER t AFTER INSERT ON x BEGIN UPDATE x SET y = NULL; END',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('001_temp_trigger.sql');
    expect(body.error).toContain('void:allow-destructive');
    expect(state.queries.find((q) => /UPDATE\s+x\s+SET/i.test(q.sql))).toBeUndefined();
  });

  it('blocks a trigger body containing DROP TABLE', async () => {
    // Triggers can execute DDL as well as DML. A CREATE TRIGGER whose
    // body drops a table still bypasses the outer destructive-DDL regex
    // set — the recursion must re-run the full destructive check on the
    // body so inner DDL is also caught.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-trigger-drop');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_trigger_drop.sql',
              sql: 'CREATE TRIGGER t AFTER INSERT ON x BEGIN DROP TABLE legacy; END',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('001_trigger_drop.sql');
    expect(body.error).toContain('void:allow-destructive');
    expect(state.queries.find((q) => /DROP\s+TABLE\s+legacy/i.test(q.sql))).toBeUndefined();
  });

  it('does NOT block a bounded DELETE with a WHERE clause', async () => {
    // False-positive guard for the unbounded-DELETE detector: a DELETE
    // with a WHERE clause is a normal DML operation, not a mass-delete,
    // and must pass without the pragma. We treat `WHERE` anywhere in
    // the statement as "bounded"; the rare WHERE-in-subquery false
    // negative is acceptable because the pragma remains available.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-bounded-delete');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001_delete.sql', sql: 'DELETE FROM users WHERE id = 1' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['001_delete.sql'],
      skipped: [],
    });
  });

  it('does NOT block a bounded UPDATE with a WHERE clause', async () => {
    // False-positive guard for the unbounded-UPDATE detector: a bounded
    // UPDATE with a WHERE clause is normal DML and must pass without
    // the pragma.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-bounded-update');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_update.sql',
              sql: "UPDATE users SET email = 'x' WHERE id = 1",
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['001_update.sql'],
      skipped: [],
    });
  });

  it('does NOT block a plain INSERT INTO', async () => {
    // False-positive guard for the INSERT OR REPLACE detector: a plain
    // `INSERT INTO` without the `OR REPLACE` modifier is additive, not
    // destructive, and must pass without the pragma.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-plain-insert');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_insert.sql',
              sql: "INSERT INTO users (id, name) VALUES (1, 'x')",
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['001_insert.sql'],
      skipped: [],
    });
  });

  it('does NOT false-positive on a DML keyword inside a string literal', async () => {
    // The DML detectors must run against the tokenizer output (code
    // stream with string literals neutralized) so an audit-log insert
    // that happens to contain the text "DELETE FROM users" inside a
    // literal is not misclassified as an unbounded DELETE.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-dml-in-literal');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_audit.sql',
              sql: "INSERT INTO audit_log VALUES ('DELETE FROM users')",
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['001_audit.sql'],
      skipped: [],
    });
  });

  it('does NOT block a benign trigger body with additive DML', async () => {
    // False-positive guard for the trigger-body recursion: a trigger
    // that just INSERTs into a log table is additive — the inner
    // destructive check must pass cleanly on such benign bodies.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-benign-trigger');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_benign_trigger.sql',
              sql: 'CREATE TRIGGER t AFTER INSERT ON x BEGIN INSERT INTO log VALUES (NEW.id); END',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['001_benign_trigger.sql'],
      skipped: [],
    });
  });

  it('allows unbounded DELETE when the pragma is present', async () => {
    // When the caller acknowledges the mass-delete with the standalone
    // `-- void:allow-destructive` pragma, the guard lets the migration
    // run end-to-end, exactly as it does for destructive DDL.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f3-delete-ok');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_delete.sql',
              sql: '-- void:allow-destructive\nDELETE FROM users',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['001_delete.sql'],
      skipped: [],
    });
    expect(state.queries.find((q) => /DELETE\s+FROM\s+users/i.test(q.sql))).toBeDefined();
    expect(state.trackingRows.has('001_delete.sql')).toBe(true);
  });

  it('requires a tracking row before accepting an existing schema object', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'recovery-single');
    await insertD1Resource(env.db, project.id);

    // Simulate a prior deploy where the CREATE TABLE committed but the
    // tracking INSERT failed before it landed: tracking is empty, but
    // the next application-SQL run now returns "already exists".
    const state = createD1State({
      failingSqlPatterns: [
        {
          match: /CREATE\s+TABLE\s+users\s*\(/i,
          message: 'table users already exists',
          status: 500,
          maxHits: 1,
        },
      ],
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            {
              name: '001_init.sql',
              sql: 'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)',
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(state.trackingRows.has('001_init.sql')).toBe(false);
  });

  it('does NOT use the recovery path for a multi-statement migration and surfaces the error', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'recovery-multi');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({
      failingSqlPatterns: [
        {
          match: /CREATE\s+TABLE\s+users\s*\(/i,
          message: 'table users already exists',
          status: 500,
          maxHits: 1,
        },
      ],
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const multiSql = [
      'CREATE TABLE users (id TEXT PRIMARY KEY);',
      '--> statement-breakpoint',
      'CREATE INDEX users_idx ON users(id);',
    ].join('\n');

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001_init.sql', sql: multiSql }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('already exists');
    // No tracking row was written — the error propagated before the INSERT
    expect(state.trackingRows.has('001_init.sql')).toBe(false);
  });

  it('two concurrent /apply requests serialize via a project row lock and end with exactly one tracking row', async () => {
    // Two deploys fire `/migrations/apply` against the same project at
    // nearly the same time. The per-project pg transaction-scoped row
    // lock serializes them: the second request blocks at the transaction
    // boundary until the first has committed both its D1 writes and its
    // pg metadata append. The second request then observes the winner's
    // tracking row in its `ensureTrackingTable` read and skips the
    // migration entirely.
    //
    // If the lock is removed, the two requests interleave at the D1 layer
    // and the loser hits "already exists". The single-statement recovery
    // path (`runRemoteMigrations` + `INSERT OR IGNORE`) still saves the
    // loser in that case — the recovery path itself is verified by the
    // `reconciles a single-statement migration via the "already exists"
    // recovery path` test above.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'concurrent-apply');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({ simulateDuplicateCreate: true });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const body = JSON.stringify({
      migrations: [{ name: '001_init.sql', sql: 'CREATE TABLE users (id TEXT PRIMARY KEY)' }],
    });

    const [resA, resB] = await Promise.all([
      app.fetch(
        authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
          method: 'POST',
          body,
        }),
        env,
      ),
      app.fetch(
        authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
          method: 'POST',
          body,
        }),
        env,
      ),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // Exactly one tracking row — only the winner wrote it; the loser
    // observed it in its pre-run SELECT and skipped.
    expect(state.trackingRows.size).toBe(1);
    expect(state.trackingRows.has('001_init.sql')).toBe(true);

    // Only the winner ran the application CREATE TABLE. With the lock
    // the loser is fully serialized behind the winner and never even
    // attempts the DDL (no `simulateDuplicateCreate` "already exists"
    // response is ever returned).
    const createCalls = state.queries.filter((q) => /CREATE\s+TABLE\s+users\b/i.test(q.sql)).length;
    expect(createCalls).toBe(1);

    // Union of both responses: one applied, the other skipped. Order
    // is racy so sort before comparing.
    const bodyA = (await resA.json()) as { applied: Array<string>; skipped: Array<string> };
    const bodyB = (await resB.json()) as { applied: Array<string>; skipped: Array<string> };
    expect([...bodyA.applied, ...bodyB.applied].sort()).toEqual(['001_init.sql']);
    expect([...bodyA.skipped, ...bodyB.skipped].sort()).toEqual(['001_init.sql']);
  });

  it('two concurrent /apply requests on a multi-statement migration both succeed', async () => {
    // With the per-project row lock, the two requests fully serialize:
    // the second sees the winner's tracking row and skips without running
    // the body.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'concurrent-multi');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({ simulateDuplicateCreate: true });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const multiSql = [
      'CREATE TABLE users (id TEXT PRIMARY KEY);',
      '--> statement-breakpoint',
      'CREATE INDEX users_idx ON users(id);',
    ].join('\n');

    const body = JSON.stringify({
      migrations: [{ name: '001_init.sql', sql: multiSql }],
    });

    const [resA, resB] = await Promise.all([
      app.fetch(
        authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
          method: 'POST',
          body,
        }),
        env,
      ),
      app.fetch(
        authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
          method: 'POST',
          body,
        }),
        env,
      ),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // One tracking row after both requests complete.
    expect(state.trackingRows.size).toBe(1);
    expect(state.trackingRows.has('001_init.sql')).toBe(true);

    // Exactly one of the responses applied the migration; the other
    // skipped it. Order is racy, so check the union.
    const bodyA = (await resA.json()) as { applied: Array<string>; skipped: Array<string> };
    const bodyB = (await resB.json()) as { applied: Array<string>; skipped: Array<string> };
    expect([...bodyA.applied, ...bodyB.applied]).toEqual(['001_init.sql']);
    expect([...bodyA.skipped, ...bodyB.skipped]).toEqual(['001_init.sql']);

    // With the lock, only the winner dispatches the body — the loser
    // observes the tracking row and skips.
    const multiCalls = state.queries.filter((q) => q.sql.startsWith(multiSql)).length;
    expect(multiCalls).toBe(1);
  });

  it('propagates non-recoverable D1 errors as 500 and does not write the tracking row', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'generic-fail');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({
      failingSqlPatterns: [
        {
          match: /CREATE\s+TABLE\s+posts/i,
          message: 'syntax error near BOOM',
          status: 500,
        },
      ],
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001_init.sql', sql: 'CREATE TABLE posts (id TEXT, BOOM)' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('syntax error');
    expect(state.trackingRows.has('001_init.sql')).toBe(false);
  });

  it('updates the active deployment applied_migrations metadata after a successful apply', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'meta-update');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            { name: '001_init.sql', sql: 'CREATE TABLE users (id TEXT)' },
            { name: '002_posts.sql', sql: 'CREATE TABLE posts (id TEXT)' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const updated = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deployment.id));
    expect(updated[0]?.applied_migrations).not.toBeNull();
    expect(JSON.parse(updated[0]!.applied_migrations!)).toEqual(['001_init.sql', '002_posts.sql']);
  });

  it('merges newly-applied migrations with existing deployment metadata without duplicates', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'meta-merge');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');

    // Pre-populate the deployment with an existing migration entry
    await env.db
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(['001_init.sql']) })
      .where(eq(deployments.id, deployment.id));

    const state = createD1State({
      trackingRows: new Map([['001_init.sql', '2024-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            { name: '001_init.sql', sql: 'CREATE TABLE users (id TEXT)' },
            { name: '002_posts.sql', sql: 'CREATE TABLE posts (id TEXT)' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const updated = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deployment.id));
    expect(JSON.parse(updated[0]!.applied_migrations!)).toEqual(['001_init.sql', '002_posts.sql']);
  });

  it('two concurrent /apply requests union their names into applied_migrations without lost updates', async () => {
    // Two concurrent POST /migrations/apply requests against the same
    // active deployment applying different migration names. The pg row
    // must end up with BOTH names. The per-project row lock fully
    // serializes the handlers, so this test is effectively "two
    // back-to-back /apply requests union correctly".
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'concurrent-meta');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    // Request A applies 001_a.sql; request B applies 002_b.sql. Different
    // names so each request's D1 apply succeeds independently (we're not
    // testing the D1 concurrent-apply path here, just the metadata merge).
    const bodyA = JSON.stringify({
      migrations: [{ name: '001_a.sql', sql: 'CREATE TABLE a (id TEXT)' }],
    });
    const bodyB = JSON.stringify({
      migrations: [{ name: '002_b.sql', sql: 'CREATE TABLE b (id TEXT)' }],
    });

    const [resA, resB] = await Promise.all([
      app.fetch(
        authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
          method: 'POST',
          body: bodyA,
        }),
        env,
      ),
      app.fetch(
        authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
          method: 'POST',
          body: bodyB,
        }),
        env,
      ),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // Deployment metadata must contain BOTH names — order is commit order
    // so either [001,002] or [002,001] is acceptable.
    const updated = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deployment.id));
    const merged: Array<string> = JSON.parse(updated[0]!.applied_migrations!);
    expect(merged.slice().sort()).toEqual(['001_a.sql', '002_b.sql']);
  });

  it('heals deployment metadata from skipped migrations even when nothing is newly applied', async () => {
    // A retry where the migration is classified as `skipped` (D1 row
    // already present) must still heal pg metadata — the handler appends
    // the UNION of applied + skipped so pg reconciles from D1 as the
    // source of truth.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'meta-heal');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');

    const state = createD1State({
      trackingRows: new Map([['001_init.sql', '2024-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001_init.sql', sql: 'CREATE TABLE users (id TEXT)' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const updated = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deployment.id));
    // Healed from the skipped set — pg now matches D1's source of truth.
    expect(updated[0]?.applied_migrations).not.toBeNull();
    expect(JSON.parse(updated[0]!.applied_migrations!)).toEqual(['001_init.sql']);
  });

  it('applies even when there is no active deployment yet (first-deploy edge case)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'no-active-deploy');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '001_init.sql', sql: 'CREATE TABLE users (id TEXT)' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: ['001_init.sql'],
      skipped: [],
    });
  });

  it('persists committed prefix to pg metadata even when a mid-batch migration fails', async () => {
    // When migration 001 commits to D1 (SQL execute AND tracking row
    // write) and then migration 002 hits a hard error, pg's
    // applied_migrations must still end up with 001 — otherwise rollback
    // diffs and rename corroboration would operate on corrupt metadata.
    //
    // Two parts:
    //   (1) runRemoteMigrations returns `result.failed` instead of
    //       throwing on per-migration errors, so the committed prefix
    //       stays on `result.applied` / `result.skipped`.
    //   (2) /apply appends the union (applied+skipped) to pg BEFORE
    //       surfacing the failure via a `return` (tx-committing) outcome.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r10f1-heal-prefix');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');

    const state = createD1State({
      failingSqlPatterns: [
        { match: /CREATE\s+TABLE\s+posts/i, message: 'no such column: nonsense' },
      ],
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            { name: '001_users.sql', sql: 'CREATE TABLE users (id TEXT)' },
            { name: '002_posts.sql', sql: 'CREATE TABLE posts (nonsense TEXT)' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      ok: boolean;
      error: string;
      applied: Array<string>;
      skipped: Array<string>;
      failed?: { name: string; error: string };
    };
    expect(body.ok).toBe(false);
    expect(body.applied).toEqual(['001_users.sql']);
    expect(body.skipped).toEqual([]);
    expect(body.failed?.name).toBe('002_posts.sql');

    // D1 tracking reflects the committed prefix (001 only).
    expect(state.trackingRows.has('001_users.sql')).toBe(true);
    expect(state.trackingRows.has('002_posts.sql')).toBe(false);

    // pg metadata reflects the SAME committed prefix — healing write
    // landed inside the locked tx BEFORE the error outcome returned.
    const row = await env.db.select().from(deployments).where(eq(deployments.id, deployment.id));
    expect(JSON.parse(row[0]!.applied_migrations!)).toEqual(['001_users.sql']);

    // Retry with the SAME payload: the runner now classifies 001 as
    // skipped (tracking row already present) and still fails on 002.
    // pg must already match D1 and the retry should idempotently
    // reconcile — applied_migrations stays [001] (not double-appended).
    const retry = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [
            { name: '001_users.sql', sql: 'CREATE TABLE users (id TEXT)' },
            { name: '002_posts.sql', sql: 'CREATE TABLE posts (nonsense TEXT)' },
          ],
        }),
      }),
      env,
    );
    expect(retry.status).toBe(500);
    const retryBody = (await retry.json()) as {
      ok: boolean;
      applied: Array<string>;
      skipped: Array<string>;
      failed?: { name: string };
    };
    // 001 is classified as skipped on the retry (already in applied set).
    expect(retryBody.skipped).toEqual(['001_users.sql']);
    expect(retryBody.applied).toEqual([]);
    expect(retryBody.failed?.name).toBe('002_posts.sql');

    const afterRetry = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deployment.id));
    // Still [001], no duplicates — appendAppliedMigrations dedupes under
    // FOR UPDATE so retries are safe.
    expect(JSON.parse(afterRetry[0]!.applied_migrations!)).toEqual(['001_users.sql']);
  });
});

describe('POST /projects/:id/migrations/rename', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_x/migrations/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ renames: [{ from: 'a', to: 'b' }] }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 for wrong user', async () => {
    const alice = await createTestUser(env.db, 'alice-rn');
    const bob = await createTestUser(env.db, 'bob-rn');
    const project = await createTestProject(env.db, alice.id, 'alice-rn-app');

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, bob.jwt, {
        method: 'POST',
        body: JSON.stringify({ renames: [{ from: 'a', to: 'b' }] }),
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown project id', async () => {
    const user = await createTestUser(env.db);
    const res = await app.fetch(
      authedReq('/projects/proj_none/migrations/rename', user.jwt, {
        method: 'POST',
        body: JSON.stringify({ renames: [{ from: 'a', to: 'b' }] }),
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 when no D1 resource exists', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-no-d1');
    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ renames: [{ from: 'a', to: 'b' }] }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'no D1 database found for this project' });
  });

  it('returns 400 for an empty renames array', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-empty');
    await insertD1Resource(env.db, project.id);
    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ renames: [] }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'renames array required' });
  });

  it('returns 400 for a missing renames field', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-missing');
    await insertD1Resource(env.db, project.id);
    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid rename entry (empty from or to)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-bad-entry');
    await insertD1Resource(env.db, project.id);

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ renames: [{ from: '', to: 'x' }] }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'each rename must have non-empty string "from" and "to"',
    });
  });

  it('renames tracking rows and updates the active deployment metadata', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-happy');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');

    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['001_init.sql', '002_alter.sql']),
      })
      .where(eq(deployments.id, deployment.id));

    const state = createD1State({
      trackingRows: new Map([
        ['001_init.sql', '2024-01-01T00:00:00Z'],
        ['002_alter.sql', '2024-01-02T00:00:00Z'],
      ]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [
            { from: '001_init.sql', to: '001_create_users.sql' },
            { from: '002_alter.sql', to: '002_add_email.sql' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(state.trackingRows.has('001_init.sql')).toBe(false);
    expect(state.trackingRows.has('002_alter.sql')).toBe(false);
    expect(state.trackingRows.get('001_create_users.sql')).toBe('2024-01-01T00:00:00Z');
    expect(state.trackingRows.get('002_add_email.sql')).toBe('2024-01-02T00:00:00Z');

    const updated = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deployment.id));
    expect(JSON.parse(updated[0]!.applied_migrations!)).toEqual([
      '001_create_users.sql',
      '002_add_email.sql',
    ]);
  });

  it('upgrades the legacy _migrations table before renaming', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-legacy');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({
      legacyRows: new Map([['001_init.sql', '2023-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [{ from: '001_init.sql', to: '001_renamed.sql' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(state.legacyRows).toBeUndefined();
    expect(state.trackingRows.has('001_init.sql')).toBe(false);
    expect(state.trackingRows.get('001_renamed.sql')).toBe('2023-01-01T00:00:00Z');
  });

  it('propagates a D1 UPDATE failure as 500', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-fail');
    await insertD1Resource(env.db, project.id);

    const state = createD1State({
      trackingRows: new Map([['001_init.sql', '2024-01-01T00:00:00Z']]),
      failingSqlPatterns: [
        {
          match: /UPDATE\s+_void_migrations/i,
          message: 'database is locked',
          status: 500,
        },
      ],
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [{ from: '001_init.sql', to: '001_renamed.sql' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('database is locked');
  });

  it('rejects a rename whose "from" is unknown and whose "to" is also unknown', async () => {
    // A request where neither side of a rename exists in
    // `_void_migrations` is a genuine operator error — the caller is
    // naming migrations that never landed. Return 400 so the mistake is
    // visible instead of silently no-op'ing.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-unknown');
    await insertD1Resource(env.db, project.id);

    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [{ from: 'does_not_exist.sql', to: 'still_nothing.sql' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('does_not_exist.sql');
    // No UPDATEs fired — only the ensure/select queries.
    expect(state.queries.find((q) => /UPDATE\s+_void_migrations/i.test(q.sql))).toBeUndefined();
    expect(state.trackingRows.size).toBe(0);
  });

  it('rewrites applied_migrations across active AND retained deployments', async () => {
    // Every project deployment (active + retained/inactive) must be
    // rewritten inside one transaction. Otherwise rollback diffs that
    // compare `applied_migrations` arrays across deployments produce
    // phantom deltas.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-all-deployments');
    await insertD1Resource(env.db, project.id);

    // Active deployment A (live) — has the full history.
    const activeDeployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['001_init.sql', '002_users.sql']),
      })
      .where(eq(deployments.id, activeDeployment.id));

    // Retained deployment B — older, only has the first migration. It must
    // also be rewritten even though it is not the active deployment.
    const retainedDeployment = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['001_init.sql']),
        retained: true,
      })
      .where(eq(deployments.id, retainedDeployment.id));

    const state = createD1State({
      trackingRows: new Map([
        ['001_init.sql', '2024-01-01T00:00:00Z'],
        ['002_users.sql', '2024-01-02T00:00:00Z'],
      ]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [{ from: '001_init.sql', to: '001_create_users.sql' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    // Remote _void_migrations reflects the rename.
    expect(state.trackingRows.has('001_init.sql')).toBe(false);
    expect(state.trackingRows.get('001_create_users.sql')).toBe('2024-01-01T00:00:00Z');

    // Both deployments' applied_migrations got rewritten.
    const activeRow = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, activeDeployment.id));
    expect(JSON.parse(activeRow[0]!.applied_migrations!)).toEqual([
      '001_create_users.sql',
      '002_users.sql',
    ]);
    const retainedRow = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, retainedDeployment.id));
    expect(JSON.parse(retainedRow[0]!.applied_migrations!)).toEqual(['001_create_users.sql']);
  });

  it('rejects a duplicate "from" in the rename batch', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-dup-from');
    await insertD1Resource(env.db, project.id);
    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [
            { from: '001.sql', to: '002.sql' },
            { from: '001.sql', to: '003.sql' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('duplicate "from"');
    // Short-circuited before any D1 calls.
    expect(state.queries.length).toBe(0);
  });

  it('rejects a duplicate "to" in the rename batch', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-dup-to');
    await insertD1Resource(env.db, project.id);
    const state = createD1State();
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [
            { from: '001.sql', to: '999.sql' },
            { from: '002.sql', to: '999.sql' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('duplicate "to"');
    expect(state.queries.length).toBe(0);
  });

  it('rejects a chain [a→b, b→c] in the rename batch', async () => {
    // Chains require two-phase renames across non-atomic D1 calls —
    // rejected up front to keep the execution path strictly linear and
    // prevent any possibility of a mid-batch PK collision.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-chain');
    await insertD1Resource(env.db, project.id);
    const state = createD1State({
      trackingRows: new Map([
        ['a.sql', '2024-01-01T00:00:00Z'],
        ['b.sql', '2024-01-02T00:00:00Z'],
      ]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [
            { from: 'a.sql', to: 'b.sql' },
            { from: 'b.sql', to: 'c.sql' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('chains not supported');
    // Batch validation happens before any D1 calls.
    expect(state.queries.length).toBe(0);
    // D1 tracking rows untouched.
    expect(state.trackingRows.has('a.sql')).toBe(true);
    expect(state.trackingRows.has('b.sql')).toBe(true);
  });

  it('rejects when "to" collides with an existing unrenamed migration', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-collide');
    await insertD1Resource(env.db, project.id);
    const state = createD1State({
      trackingRows: new Map([
        ['001_init.sql', '2024-01-01T00:00:00Z'],
        ['002_existing.sql', '2024-01-02T00:00:00Z'],
      ]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          // 001_init.sql exists AND 002_existing.sql exists — would collide
          // on the remote UPDATE's PRIMARY KEY.
          renames: [{ from: '001_init.sql', to: '002_existing.sql' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('already exist');
    // D1 tracking rows untouched — no UPDATE fired.
    expect(state.queries.find((q) => /UPDATE\s+_void_migrations/i.test(q.sql))).toBeUndefined();
    expect(state.trackingRows.has('001_init.sql')).toBe(true);
    expect(state.trackingRows.has('002_existing.sql')).toBe(true);
  });

  it('idempotent retry of an already-landed rename is a no-op 200', async () => {
    // After a successful rename, retrying the same payload finds `from` already
    // missing and `to` already present. The retry is only classified as
    // "already landed" when pg still references `from` somewhere — corroboration
    // that this is a legitimate retry after a prior D1-succeeded / pg-failed run.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-idempotent');
    await insertD1Resource(env.db, project.id);
    // pg still references the old name — corroboration for the already-landed classification.
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(['001_init.sql']) })
      .where(eq(deployments.id, deployment.id));

    const state = createD1State({
      trackingRows: new Map([['001_renamed.sql', '2024-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [{ from: '001_init.sql', to: '001_renamed.sql' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    // No UPDATE fired — validation short-circuited to a no-op.
    expect(state.queries.find((q) => /UPDATE\s+_void_migrations/i.test(q.sql))).toBeUndefined();
    expect(state.trackingRows.has('001_renamed.sql')).toBe(true);
  });

  it('partial-failure retry lands the remaining rename', async () => {
    // Prior run: rename 1 (001→001_new) landed but rename 2 (002→002_new)
    // failed mid-batch. Retrying the full batch detects rename 1 as already-done
    // (pg still has OLD name `001.sql` — fingerprint of a prior pg write that
    // never committed) and applies rename 2 for real.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-partial');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(['001.sql', '002.sql']) })
      .where(eq(deployments.id, deployment.id));

    const state = createD1State({
      trackingRows: new Map([
        ['001_new.sql', '2024-01-01T00:00:00Z'],
        ['002.sql', '2024-01-02T00:00:00Z'],
      ]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [
            { from: '001.sql', to: '001_new.sql' },
            { from: '002.sql', to: '002_new.sql' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    // Only one UPDATE fired — the second rename.
    const updateCalls = state.queries.filter((q) => /UPDATE\s+_void_migrations/i.test(q.sql));
    expect(updateCalls.length).toBe(1);
    expect(state.trackingRows.has('001_new.sql')).toBe(true);
    expect(state.trackingRows.has('002.sql')).toBe(false);
    expect(state.trackingRows.has('002_new.sql')).toBe(true);
  });

  it('happy path: two independent renames update remote + active + retained deployments', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-two-independent');
    await insertD1Resource(env.db, project.id);

    const active = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['001_init.sql', '002_alter.sql']),
      })
      .where(eq(deployments.id, active.id));

    const retained = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['001_init.sql', '002_alter.sql']),
        retained: true,
      })
      .where(eq(deployments.id, retained.id));

    const state = createD1State({
      trackingRows: new Map([
        ['001_init.sql', '2024-01-01T00:00:00Z'],
        ['002_alter.sql', '2024-01-02T00:00:00Z'],
      ]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [
            { from: '001_init.sql', to: '001_create_users.sql' },
            { from: '002_alter.sql', to: '002_add_email.sql' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    expect(state.trackingRows.get('001_create_users.sql')).toBe('2024-01-01T00:00:00Z');
    expect(state.trackingRows.get('002_add_email.sql')).toBe('2024-01-02T00:00:00Z');

    const activeRow = await env.db.select().from(deployments).where(eq(deployments.id, active.id));
    expect(JSON.parse(activeRow[0]!.applied_migrations!)).toEqual([
      '001_create_users.sql',
      '002_add_email.sql',
    ]);
    const retainedRow = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, retained.id));
    expect(JSON.parse(retainedRow[0]!.applied_migrations!)).toEqual([
      '001_create_users.sql',
      '002_add_email.sql',
    ]);
  });

  it('returns 409 when a concurrent rename redirected the same "from" to a different target', async () => {
    // Two concurrent /rename requests target the same `from` with different
    // `to` values. Pre-validation snapshots both pass, but only one UPDATE
    // actually changes a row. The loser's UPDATE returns `meta.changes === 0`,
    // and the handler rechecks `_void_migrations`: when the winner picked a
    // different target, return 409 WITHOUT rewriting pg metadata so pg and
    // D1 never diverge.
    //
    // The test forces the race by stubbing the UPDATE mock to report zero
    // changes and pre-seeding tracking state so the recheck finds the
    // winner's target already present.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rn-r7f1-conflict');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(['old.sql']) })
      .where(eq(deployments.id, deployment.id));

    // Baseline state: `old.sql` exists so pre-validation accepts `old.sql → to_b`,
    // and `to_a` also exists so the recheck finds the winner's target.
    // Pre-validation is (fromExists && !toExists) for old.sql→to_b since
    // `existing` reads the map below: old.sql present, to_b absent.
    // We also pre-populate `to_a` to simulate the winner having already
    // landed their rename before our UPDATE hit D1.
    const state = createD1State({
      trackingRows: new Map([
        ['old.sql', '2024-01-01T00:00:00Z'],
        ['to_a', '2024-01-01T00:00:00Z'],
      ]),
    });
    const base = makeQueryD1(state);

    // Intercept the specific UPDATE for `to_b` and force a zero-changes
    // response — the caller's pre-validation passed on an older snapshot,
    // but the real D1 state no longer has `old.sql` (the winner moved it
    // to `to_a`) so an UPDATE would report 0 changes.
    mockCfApi({
      queryD1: (url, init) => {
        const parsed = init?.body ? JSON.parse(String(init.body)) : {};
        const sql = String(parsed.sql ?? '');
        const params = parsed.params;
        if (
          /UPDATE\s+_void_migrations\s+SET\s+name\s*=\s*\?\s+WHERE\s+name\s*=\s*\?/i.test(sql) &&
          Array.isArray(params) &&
          params[0] === 'to_b'
        ) {
          state.queries.push({ sql, params });
          // Do NOT actually mutate state.trackingRows — simulate the row
          // already being gone (winner renamed old.sql → to_a before us).
          state.trackingRows.delete('old.sql');
          return cfSuccess([{ results: [], meta: { changes: 0 } }]);
        }
        return base(url, init);
      },
    });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ renames: [{ from: 'old.sql', to: 'to_b' }] }),
      }),
      env,
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('rename conflict');
    expect(body.error).toContain('old.sql');

    // D1 state: winner's rename is the surviving one — `to_a` present,
    // `to_b` never written. (old.sql was removed by the stubbed UPDATE path.)
    expect(state.trackingRows.has('to_a')).toBe(true);
    expect(state.trackingRows.has('to_b')).toBe(false);
    expect(state.trackingRows.has('old.sql')).toBe(false);

    // pg applied_migrations was NOT rewritten — the loser's 409 path must
    // not touch metadata for a rename that did not commit.
    const row = await env.db.select().from(deployments).where(eq(deployments.id, deployment.id));
    expect(JSON.parse(row[0]!.applied_migrations!)).toEqual(['old.sql']);
  });

  it('persists committed prefix to pg metadata when a later rename pair conflicts', async () => {
    // /rename loops over pairs sequentially. Earlier iterations can land
    // their UPDATE in D1 (durable) before a later pair fails. The handler
    // must catch per-pair failures, stop the loop, persist the committed
    // prefix via renameAppliedMigrationsForProject inside the same
    // row-locked tx, then return the 409/500 outcome so the tx commits
    // (healing write preserved) — otherwise pg's applied_migrations arrays
    // would still reference OLD names for pairs whose D1 UPDATE had already
    // committed.
    //
    // This test runs a 2-pair batch [a→a1, b→b1] where the first UPDATE
    // lands normally but the second UPDATE is intercepted to report 0 rows
    // changed and mutate D1 state so the recheck classifies it as a conflict.
    // Expected: 409, D1 has `a1` (committed) and `b` (untouched), pg's
    // applied_migrations rewritten from `a → a1`.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r10f2-rename-heal');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(['a.sql', 'b.sql']) })
      .where(eq(deployments.id, deployment.id));

    const state = createD1State({
      trackingRows: new Map([
        ['a.sql', '2024-01-01T00:00:00Z'],
        ['b.sql', '2024-01-02T00:00:00Z'],
      ]),
    });
    const base = makeQueryD1(state);

    // Intercept the second UPDATE (b → b1) to force a zero-changes
    // response AND mutate D1 state so the recheck cannot find either
    // `b` or `b1` — the "winner chose a different target" branch.
    mockCfApi({
      queryD1: (url, init) => {
        const parsed = init?.body ? JSON.parse(String(init.body)) : {};
        const sql = String(parsed.sql ?? '');
        const params = parsed.params;
        if (
          /UPDATE\s+_void_migrations\s+SET\s+name\s*=\s*\?\s+WHERE\s+name\s*=\s*\?/i.test(sql) &&
          Array.isArray(params) &&
          params[0] === 'b1.sql'
        ) {
          state.queries.push({ sql, params });
          // Simulate a concurrent winner having renamed `b.sql` to some
          // OTHER target out from under us. The recheck for (b.sql, b1.sql)
          // returns neither — that's the conflict classification branch.
          state.trackingRows.delete('b.sql');
          state.trackingRows.set('b_winner.sql', '2024-01-02T00:00:00Z');
          return cfSuccess([{ results: [], meta: { changes: 0 } }]);
        }
        return base(url, init);
      },
    });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [
            { from: 'a.sql', to: 'a1.sql' },
            { from: 'b.sql', to: 'b1.sql' },
          ],
        }),
      }),
      env,
    );

    // 409 from the second pair's conflict classification.
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      ok: boolean;
      error: string;
      committed: Array<{ from: string; to: string }>;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('rename conflict');
    expect(body.error).toContain('b.sql');
    // The response exposes the committed prefix for operator visibility.
    expect(body.committed).toEqual([{ from: 'a.sql', to: 'a1.sql' }]);

    // D1 state: `a` was renamed to `a1` by the first UPDATE (committed).
    // `b` was removed by the interceptor (simulating concurrent winner),
    // `b1` was never written. `b_winner.sql` is the winner's surviving row.
    expect(state.trackingRows.has('a.sql')).toBe(false);
    expect(state.trackingRows.has('a1.sql')).toBe(true);
    expect(state.trackingRows.has('b.sql')).toBe(false);
    expect(state.trackingRows.has('b1.sql')).toBe(false);
    expect(state.trackingRows.has('b_winner.sql')).toBe(true);

    // pg applied_migrations MUST reflect the committed prefix (a → a1),
    // even though the overall response is 409. Without the per-pair catch,
    // the thrown error would roll back the row-locked tx and pg would
    // still have ['a.sql', 'b.sql'].
    const row = await env.db.select().from(deployments).where(eq(deployments.id, deployment.id));
    expect(JSON.parse(row[0]!.applied_migrations!)).toEqual(['a1.sql', 'b.sql']);
  });

  it('same-payload retry reaches uncommitted suffix after partial-failure heal', async () => {
    // When the partial-failure heal rewrites pg's applied_migrations to the
    // committed prefix, the active deployment references `to`, not `from`,
    // so `activeDeploymentContainsMigration(from)` no longer corroborates
    // the classifier's `!fromExists && toExists` branch on retry. The
    // `migration_renames` audit log supplies a second corroboration source:
    // a matching row proves the exact (project_id, from, to) pair was
    // already committed here, so a retry can classify it as idempotent and
    // advance to the still-failing suffix.
    //
    // Repro shape:
    //   first POST  [a→a1, b→b1]: pair 1 succeeds, pair 2 intercepted to
    //                              return changes=0 with `b` still in D1,
    //                              conflict → 409. Heal writes pg
    //                              ['a1.sql','b.sql'] and audit row (a.sql,a1.sql).
    //   retry same payload       : pair 1 idempotent via audit log,
    //                              pair 2 UPDATE fires and succeeds → 200.
    //                              Final: D1 [a1, b1], pg ['a1.sql','b1.sql'].
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r11f1-retry-heal');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(['a.sql', 'b.sql']) })
      .where(eq(deployments.id, deployment.id));

    const state = createD1State({
      trackingRows: new Map([
        ['a.sql', '2024-01-01T00:00:00Z'],
        ['b.sql', '2024-01-02T00:00:00Z'],
      ]),
    });
    const base = makeQueryD1(state);

    // The interceptor fails the `b → b1` UPDATE exactly once. It reports
    // zero-changes WITHOUT mutating D1, so `b` is still present. The
    // recheck query then sees `b` (from) still there, classifying the
    // pair as a conflict and returning 409. On subsequent requests the
    // interceptor disables itself and pair 2 goes through base().
    let interceptFires = 0;
    mockCfApi({
      queryD1: (url, init) => {
        const parsed = init?.body ? JSON.parse(String(init.body)) : {};
        const sql = String(parsed.sql ?? '');
        const params = parsed.params;
        if (
          interceptFires === 0 &&
          /UPDATE\s+_void_migrations\s+SET\s+name\s*=\s*\?\s+WHERE\s+name\s*=\s*\?/i.test(sql) &&
          Array.isArray(params) &&
          params[0] === 'b1.sql' &&
          params[1] === 'b.sql'
        ) {
          interceptFires++;
          state.queries.push({ sql, params });
          // Do NOT mutate trackingRows — leave `b.sql` in place so the
          // recheck's WHERE name=b OR name=b1 finds `b`, which the
          // handler classifies as a conflict (from still present).
          return cfSuccess([{ results: [], meta: { changes: 0 } }]);
        }
        return base(url, init);
      },
    });

    // ---- first request: partial failure ----
    const firstRes = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [
            { from: 'a.sql', to: 'a1.sql' },
            { from: 'b.sql', to: 'b1.sql' },
          ],
        }),
      }),
      env,
    );
    expect(firstRes.status).toBe(409);
    const firstBody = (await firstRes.json()) as {
      ok: boolean;
      error: string;
      committed: Array<{ from: string; to: string }>;
    };
    expect(firstBody.ok).toBe(false);
    expect(firstBody.committed).toEqual([{ from: 'a.sql', to: 'a1.sql' }]);

    // D1 has a1 (committed) and b (unchanged), no b1.
    expect(state.trackingRows.has('a.sql')).toBe(false);
    expect(state.trackingRows.has('a1.sql')).toBe(true);
    expect(state.trackingRows.has('b.sql')).toBe(true);
    expect(state.trackingRows.has('b1.sql')).toBe(false);

    // pg healed to the committed prefix. `a.sql` is gone from the active
    // deployment — the post-heal state where only the audit log can
    // corroborate the idempotent classification on retry.
    const midRow = await env.db.select().from(deployments).where(eq(deployments.id, deployment.id));
    expect(JSON.parse(midRow[0]!.applied_migrations!)).toEqual(['a1.sql', 'b.sql']);

    // ---- second request: same payload, interceptor now disabled ----
    const secondRes = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [
            { from: 'a.sql', to: 'a1.sql' },
            { from: 'b.sql', to: 'b1.sql' },
          ],
        }),
      }),
      env,
    );
    expect(secondRes.status).toBe(200);
    const secondBody = (await secondRes.json()) as { ok: boolean };
    expect(secondBody.ok).toBe(true);

    // Pair 2's real UPDATE fired this time. Pair 1 must NOT have fired
    // again — the audit log classifies it as idempotent.
    const updateCalls = state.queries.filter((q) =>
      /UPDATE\s+_void_migrations\s+SET\s+name\s*=\s*\?\s+WHERE\s+name\s*=\s*\?/i.test(q.sql),
    );
    // Exactly 3 UPDATE-shaped calls total across both requests:
    //   1. first request pair 1 (a → a1) committed
    //   2. first request pair 2 (b → b1) intercepted failure
    //   3. second request pair 2 (b → b1) real success
    // Pair 1 on the retry must be skipped before any D1 UPDATE fires.
    expect(updateCalls.length).toBe(3);
    expect(
      updateCalls.filter(
        (q) => Array.isArray(q.params) && q.params[0] === 'a1.sql' && q.params[1] === 'a.sql',
      ).length,
    ).toBe(1);

    // Final D1 state: both renames landed.
    expect(state.trackingRows.has('a.sql')).toBe(false);
    expect(state.trackingRows.has('a1.sql')).toBe(true);
    expect(state.trackingRows.has('b.sql')).toBe(false);
    expect(state.trackingRows.has('b1.sql')).toBe(true);

    // Final pg state: fully reconciled.
    const finalRow = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deployment.id));
    expect(JSON.parse(finalRow[0]!.applied_migrations!)).toEqual(['a1.sql', 'b1.sql']);
  });

  it('invalidates stale audit rows when a prior landing is recycled as a new source', async () => {
    // Migration_renames audit rows must not act as permanent corroboration
    // across name recycling. When committed pair X→Y is recorded, any prior
    // audit rows with to_name = X are deleted — the prior landing at X is
    // no longer valid because X is being renamed away. Otherwise a
    // fat-fingered retry of a→a1 could silently corroborate against a stale
    // row after a1 had been renamed elsewhere and a different migration
    // renamed into a1.
    //
    // Repro shape:
    //   step 1: rename a.sql → a1.sql       → audit [(a,a1)]
    //   step 2: rename a1.sql → b.sql       → audit [(a1,b)]          (invalidate to_name=a1 → deletes (a,a1))
    //   step 3: rename x.sql → a1.sql       → audit [(a1,b),(x,a1)]   (invalidate to_name=x → no-op)
    //   step 4: retry a.sql → a1.sql        → 400 (audit row (a,a1) is gone)
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r12f2-lineage');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(['a.sql']) })
      .where(eq(deployments.id, deployment.id));

    const state = createD1State({
      trackingRows: new Map([['a.sql', '2024-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    // Step 1: a.sql → a1.sql
    const step1 = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ renames: [{ from: 'a.sql', to: 'a1.sql' }] }),
      }),
      env,
    );
    expect(step1.status).toBe(200);
    expect(state.trackingRows.has('a.sql')).toBe(false);
    expect(state.trackingRows.has('a1.sql')).toBe(true);

    // Step 2: a1.sql → b.sql
    const step2 = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ renames: [{ from: 'a1.sql', to: 'b.sql' }] }),
      }),
      env,
    );
    expect(step2.status).toBe(200);
    expect(state.trackingRows.has('a1.sql')).toBe(false);
    expect(state.trackingRows.has('b.sql')).toBe(true);

    // Pre-seed x.sql in D1 as if a separate /apply had added it. We
    // skip the actual /apply call to keep the test focused on the audit
    // log lineage — the rename classifier only cares about D1's
    // tracking rows existing for `from`.
    state.trackingRows.set('x.sql', '2024-01-03T00:00:00Z');

    // Step 3: x.sql → a1.sql (recycling the `a1` name for a different lineage)
    const step3 = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ renames: [{ from: 'x.sql', to: 'a1.sql' }] }),
      }),
      env,
    );
    expect(step3.status).toBe(200);
    expect(state.trackingRows.has('x.sql')).toBe(false);
    expect(state.trackingRows.has('a1.sql')).toBe(true);
    expect(state.trackingRows.has('b.sql')).toBe(true);

    // Step 4: stale retry of the original a.sql → a1.sql. The audit log
    // row (a.sql, a1.sql) was invalidated in step 2 when a1.sql was
    // renamed away, so the classifier has no corroboration source and
    // must reject as ambiguous.
    const step4 = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ renames: [{ from: 'a.sql', to: 'a1.sql' }] }),
      }),
      env,
    );
    expect(step4.status).toBe(400);
    const body = (await step4.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('ambiguous');
    expect(body.error).toContain('a.sql');
    expect(body.error).toContain('a1.sql');

    // D1 state unchanged by the rejected retry — still holds b.sql and
    // a1.sql (x's lineage), no a.sql.
    expect(state.trackingRows.has('a.sql')).toBe(false);
    expect(state.trackingRows.has('a1.sql')).toBe(true);
    expect(state.trackingRows.has('b.sql')).toBe(true);
  });

  it('apply-then-rename interleave: per-project row lock keeps D1 and pg in sync', async () => {
    // Without per-project serialization, an /apply that landed the
    // migration in D1 but had not yet appended to pg metadata could be
    // overtaken by a /rename that snapshots D1, rewrites pg for deployments
    // that don't yet reference the unwritten name, and returns 200. /apply
    // would then append the pre-rename name. Result: D1 has the new name,
    // pg has the old — permanent drift.
    //
    // The transaction-scoped row lock on the `projects` row serializes
    // /apply and /rename: /rename can only begin its critical section
    // after /apply has committed its pg write.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r7f2-apply-rename');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');

    const state = createD1State();
    const base = makeQueryD1(state);

    // Deferred: hold /apply inside its runRemoteMigrations application
    // SQL call so /rename starts second. Without the lock, /rename would
    // race past /apply's (not-yet-happened) pg append; with the lock,
    // /rename blocks at the transaction boundary until /apply commits.
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    let holdsFired = 0;

    mockCfApi({
      queryD1: async (url, init) => {
        const parsed = init?.body ? JSON.parse(String(init.body)) : {};
        const sql = String(parsed.sql ?? '');
        if (holdsFired === 0 && /CREATE\s+TABLE\s+users\b/i.test(sql)) {
          holdsFired++;
          // Pause until the rename request has been issued so the interleave
          // window is maximized. The test releases after a short delay to
          // let the second request reach the app and begin its transaction.
          await hold;
        }
        return base(url, init);
      },
    });

    const applyBody = JSON.stringify({
      migrations: [{ name: '001_old.sql', sql: 'CREATE TABLE users (id TEXT PRIMARY KEY)' }],
    });
    const renameBody = JSON.stringify({
      renames: [{ from: '001_old.sql', to: '001_new.sql' }],
    });

    const applyPromise = app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: applyBody,
      }),
      env,
    );
    // Give /apply a tick to enter its transaction and hit the hold.
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    const renamePromise = app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: renameBody,
      }),
      env,
    );
    // Give /rename a tick to issue its transaction call so it is queued
    // behind /apply's lock, then release.
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    release();

    const [applyRes, renameRes] = await Promise.all([applyPromise, renamePromise]);

    expect(applyRes.status).toBe(200);
    expect(renameRes.status).toBe(200);

    // D1 state: migration renamed.
    expect(state.trackingRows.has('001_old.sql')).toBe(false);
    expect(state.trackingRows.has('001_new.sql')).toBe(true);

    // pg state: active deployment's applied_migrations has the NEW name,
    // not the old. Without the lock this would be `['001_old.sql']`.
    const row = await env.db.select().from(deployments).where(eq(deployments.id, deployment.id));
    expect(JSON.parse(row[0]!.applied_migrations!)).toEqual(['001_new.sql']);
  });

  it('rejects an ambiguous rename when pg has no reference to "from"', async () => {
    // The `!fromExists && toExists` branch requires corroboration from pg:
    // a legitimate retry after a prior D1-succeeded / pg-failed run still
    // has `from` referenced in some deployment's `applied_migrations`. If
    // NO deployment references `from`, reject with 400 rather than rewriting
    // blindly against an unrelated existing D1 migration.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r8f2-ambiguous');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    // pg has an unrelated migration — no reference to `from`.
    await env.db
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(['999_unrelated.sql']) })
      .where(eq(deployments.id, deployment.id));

    // D1 has `to` (from a previous deploy) and does NOT have `from`.
    const state = createD1State({
      trackingRows: new Map([['002_add_email.sql', '2024-02-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [{ from: '001_init.sql', to: '002_add_email.sql' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('ambiguous');
    expect(body.error).toContain('001_init.sql');
    expect(body.error).toContain('002_add_email.sql');

    // D1 untouched.
    expect(state.trackingRows.has('002_add_email.sql')).toBe(true);
    expect(state.trackingRows.has('001_init.sql')).toBe(false);
    // No UPDATE fired.
    expect(state.queries.find((q) => /UPDATE\s+_void_migrations/i.test(q.sql))).toBeUndefined();

    // pg untouched — still the unrelated entry.
    const row = await env.db.select().from(deployments).where(eq(deployments.id, deployment.id));
    expect(JSON.parse(row[0]!.applied_migrations!)).toEqual(['999_unrelated.sql']);
  });

  it('heals a legitimate retry where pg still references "from" on the active deployment', async () => {
    // Fingerprint of a legitimate retry: pg still has `from` in a
    // deployment's applied_migrations (prior run's pg rewrite never
    // committed), D1 has `to` (prior run's D1 UPDATE did commit), D1
    // lacks `from`. The classifier should pass and the pg rewrite
    // should rename `from → to` to reconcile the metadata.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r8f2-heal-active');
    await insertD1Resource(env.db, project.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(['001_init.sql']) })
      .where(eq(deployments.id, deployment.id));

    const state = createD1State({
      trackingRows: new Map([['001_create_users.sql', '2024-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [{ from: '001_init.sql', to: '001_create_users.sql' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    // D1 untouched — the rename already landed there.
    expect(state.queries.find((q) => /UPDATE\s+_void_migrations/i.test(q.sql))).toBeUndefined();
    expect(state.trackingRows.has('001_create_users.sql')).toBe(true);

    // pg rewritten from `001_init.sql` to `001_create_users.sql`.
    const row = await env.db.select().from(deployments).where(eq(deployments.id, deployment.id));
    expect(JSON.parse(row[0]!.applied_migrations!)).toEqual(['001_create_users.sql']);
  });

  it('rejects rename when "from" only appears on a retained deployment', async () => {
    // Corroboration is narrowed to the active deployment. Retained-only
    // references are not sufficient — they may be historically inaccurate
    // from a legacy era when /rename only updated the active deployment,
    // which is the exact state the batch rewrite was introduced to heal.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r9f1-reject-retained');
    await insertD1Resource(env.db, project.id);

    // Active deployment already has the NEW name (consistent with D1).
    const activeDeployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(['001_create_users.sql']) })
      .where(eq(deployments.id, activeDeployment.id));

    // Retained deployment still has the OLD name. A retained reference alone
    // is not corroboration — ignored.
    const retainedDeployment = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['001_init.sql']),
        retained: true,
      })
      .where(eq(deployments.id, retainedDeployment.id));

    const state = createD1State({
      trackingRows: new Map([['001_create_users.sql', '2024-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [{ from: '001_init.sql', to: '001_create_users.sql' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('ambiguous');
    expect(body.error).toContain('001_init.sql');
    expect(body.error).toContain('001_create_users.sql');

    // D1 untouched.
    expect(state.queries.find((q) => /UPDATE\s+_void_migrations/i.test(q.sql))).toBeUndefined();
    expect(state.trackingRows.has('001_create_users.sql')).toBe(true);

    // Neither deployment row was rewritten.
    const activeRow = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, activeDeployment.id));
    expect(JSON.parse(activeRow[0]!.applied_migrations!)).toEqual(['001_create_users.sql']);

    const retainedRow = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, retainedDeployment.id));
    expect(JSON.parse(retainedRow[0]!.applied_migrations!)).toEqual(['001_init.sql']);
  });

  it('rejects fat-fingered rename targeting a historically-present migration', async () => {
    // Operator fat-fingers a rename that happens to name a migration still
    // present on a stale retained deployment. Active has a different set,
    // D1 has the real current set. A retained-only reference must not
    // corroborate — the handler rejects.
    //
    //   retained deployment (stale): ['001_init.sql']
    //   active deployment          : ['001_create_users.sql']
    //   D1 _void_migrations        : ['001_create_users.sql',
    //                                 '002_add_email.sql']
    //   request rename             : 001_init.sql → 002_add_email.sql
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r9f1-fat-finger');
    await insertD1Resource(env.db, project.id);

    const activeDeployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(['001_create_users.sql']) })
      .where(eq(deployments.id, activeDeployment.id));

    const retainedDeployment = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['001_init.sql']),
        retained: true,
      })
      .where(eq(deployments.id, retainedDeployment.id));

    const state = createD1State({
      trackingRows: new Map([
        ['001_create_users.sql', '2024-01-01T00:00:00Z'],
        ['002_add_email.sql', '2024-02-01T00:00:00Z'],
      ]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    const res = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/rename`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          renames: [{ from: '001_init.sql', to: '002_add_email.sql' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('ambiguous');
    expect(body.error).toContain('001_init.sql');
    expect(body.error).toContain('002_add_email.sql');

    // D1 untouched — still contains the original two migrations, no UPDATE.
    expect(state.queries.find((q) => /UPDATE\s+_void_migrations/i.test(q.sql))).toBeUndefined();
    expect(state.trackingRows.has('001_create_users.sql')).toBe(true);
    expect(state.trackingRows.has('002_add_email.sql')).toBe(true);
    expect(state.trackingRows.has('001_init.sql')).toBe(false);

    // pg untouched — the batch rewrite never fired.
    const activeRow = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, activeDeployment.id));
    expect(JSON.parse(activeRow[0]!.applied_migrations!)).toEqual(['001_create_users.sql']);

    const retainedRow = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, retainedDeployment.id));
    expect(JSON.parse(retainedRow[0]!.applied_migrations!)).toEqual(['001_init.sql']);
  });

  it('rollback/apply interleave: row lock keeps setActiveDeployment atomic with apply metadata', async () => {
    // Rollback's pointer flip and /apply's metadata append serialize on
    // the per-project row lock. /apply re-reads `locked.active_deployment_id`
    // AFTER acquiring the lock, so either:
    //   (a) /apply runs first, appends to the old active, then rollback flips;
    //   (b) rollback flips first, /apply re-reads and appends to the NEW active.
    //
    // Case (a) is acceptable — the new active has its own migration history
    // from the deploy that created it. This test pins case (b): the lock
    // prevents interleaving so /apply's append targets the post-rollback
    // active rather than silently writing to an about-to-be-replaced row.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r8f3-rollback-apply');
    await insertD1Resource(env.db, project.id);

    // Two retained deployments — `oldActive` is currently active, `target`
    // is what rollback will switch to.
    const oldActive = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['001_init.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'void' }),
      })
      .where(eq(deployments.id, oldActive.id));

    const target = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['001_init.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'void' }),
      })
      .where(eq(deployments.id, target.id));

    // D1 already has `001_init.sql` AND `002_new.sql` (simulating a
    // prior /apply that succeeded in D1 and landed the tracking row
    // for `002_new.sql` but had its pg append rolled back).
    const state = createD1State({
      trackingRows: new Map([
        ['001_init.sql', '2024-01-01T00:00:00Z'],
        ['002_new.sql', '2024-01-02T00:00:00Z'],
      ]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    // Kick rollback first — it will route through all the KV work and
    // then enter the row-locked setActiveDeployment. /apply kicks off
    // right after and races to acquire the same lock.
    const rollbackPromise = app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: target.id }),
      }),
      env,
    );
    // Give rollback a small head start so it reaches its locked
    // critical section before /apply tries to enter its own lock.
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    const applyPromise = app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: '002_new.sql', sql: 'CREATE TABLE posts (id TEXT)' }],
        }),
      }),
      env,
    );

    const [rollbackRes, applyRes] = await Promise.all([rollbackPromise, applyPromise]);
    expect(rollbackRes.status).toBe(200);
    expect(applyRes.status).toBe(200);

    // Final state: project.active_deployment_id points at target, and
    // target's applied_migrations contains `002_new.sql` — /apply's
    // metadata append landed on the post-rollback active, not the old
    // one. Without the project row lock, /apply's re-read could observe
    // the pre-rollback active and write to oldActive.
    const targetRow = await env.db.select().from(deployments).where(eq(deployments.id, target.id));
    const oldActiveRow = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, oldActive.id));

    // One of the two deployments MUST have the new name appended, and
    // it MUST be the one the project now points at — the lock guarantees
    // this consistency.
    const targetMigrations: Array<string> = JSON.parse(targetRow[0]!.applied_migrations!);
    const oldActiveMigrations: Array<string> = JSON.parse(oldActiveRow[0]!.applied_migrations!);

    // The new migration landed on the current active deployment (target),
    // which matches the post-rollback project.active_deployment_id.
    expect(targetMigrations).toContain('002_new.sql');
    // oldActive is untouched by /apply — rollback committed first, so
    // /apply's post-lock re-read saw target as the active deployment.
    expect(oldActiveMigrations).toEqual(['001_init.sql']);
  });

  it('rollback currentActive read and migrationDiff are computed inside the row lock', async () => {
    // Rollback's row lock covers the entire cutover: target + currentActive
    // re-reads, diff, pg flip, and external writes. By construction any
    // /apply that commits before the lock acquire is visible when the diff
    // is computed, and any /apply racing during rollback blocks on the same
    // lock and runs AFTER rollback commits.
    //
    // Scenario: an /apply that committed m3 to the current active deployment
    // MUST appear in the rollback diff. Running /apply fully to completion
    // before /rollback starts exercises the in-lock-diff invariant because
    // rollback's diff is computed against the post-apply pg snapshot.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r12f1-diff-lock');
    await insertD1Resource(env.db, project.id);

    const oldActive = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'void' }),
      })
      .where(eq(deployments.id, oldActive.id));

    const target = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'void' }),
      })
      .where(eq(deployments.id, target.id));

    // D1 already has m1. /apply will add m3.
    const state = createD1State({
      trackingRows: new Map([['m1.sql', '2024-01-01T00:00:00Z']]),
    });
    mockCfApi({ queryD1: makeQueryD1(state) });

    // Run /apply to completion first. It appends m3 to oldActive's
    // applied_migrations under its own row lock.
    const applyRes = await app.fetch(
      authedReq(`/projects/${project.id}/migrations/apply`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({
          migrations: [{ name: 'm3.sql', sql: 'CREATE TABLE posts (id TEXT)' }],
        }),
      }),
      env,
    );
    expect(applyRes.status).toBe(200);

    // Sanity: /apply committed m3.sql to oldActive in pg.
    const oldActiveMid = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, oldActive.id));
    expect(JSON.parse(oldActiveMid[0]!.applied_migrations!)).toEqual(['m1.sql', 'm3.sql']);

    // Now /rollback enters its locked tx, re-reads currentActive
    // (which now has [m1, m3]), computes diff, commits the flip, and
    // issues the external writes. The diff must reflect the
    // post-apply state.
    //
    // target has [m1] and currentActive has [m1, m3], so the diff is
    // non-empty and the destructive guard would reject without an
    // explicit opt-in. This test's invariant (in-lock diff computation)
    // is orthogonal to destructive-rejection, so echo the expected diff
    // via `allowDestructive`.
    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: target.id, allowDestructive: ['m3.sql'] }),
      }),
      env,
    );
    expect(rollbackRes.status).toBe(200);

    const rollbackBody = (await rollbackRes.json()) as {
      ok: boolean;
      deploymentId: string;
      migrationDiff: Array<string>;
    };
    expect(rollbackBody.ok).toBe(true);
    expect(rollbackBody.deploymentId).toBe(target.id);
    // diff contains m3.sql because rollback's in-lock currentActive
    // read sees [m1, m3] and target has [m1] → diff = [m3].
    expect(rollbackBody.migrationDiff).toEqual(['m3.sql']);
  });

  it('two rollbacks in sequence keep pg and ROUTING in sync, the second after the first has finished', async () => {
    // Two rollbacks run one after the other must leave a consistent state.
    // The row lock covers the whole cutover (pg flip + ROUTING.put + cron +
    // queue + ISR), so when both finish the final state is internally
    // consistent: whatever pg says is active, ROUTING points at the
    // matching worker, and the diffs returned by both rollbacks are
    // computed against the correct pre-flip snapshots.
    //
    // This test pins that invariant by holding rollback A mid-rollback
    // (inside its locked tx, AFTER the pg flip but during its
    // `ROUTING.put(slug, …)` external write) and kicking rollback B while
    // A is paused. B starts only after A has fully finished, post-commit
    // lease cleanup included.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r13f1-rb-rb');
    await insertD1Resource(env.db, project.id);

    // Active A ([m1, m2, m3]); retained B ([m1, m2]); retained C ([m1]).
    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql', 'm2.sql', 'm3.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'void' }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql', 'm2.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'void' }),
      })
      .where(eq(deployments.id, depB.id));
    const depC = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'void' }),
      })
      .where(eq(deployments.id, depC.id));

    // Deferred ROUTING.put spy — holds the FIRST put for project.slug
    // (this is rollback A's in-lock external write, which now runs
    // AFTER the pg flip). Subsequent calls pass through normally.
    let releaseA: () => void = () => {};
    const aHold = new Promise<void>((r) => {
      releaseA = r;
    });
    let holdFired: (() => void) | undefined;
    const aReachedPut = new Promise<void>((r) => {
      holdFired = r;
    });
    let aHoldFired = false;
    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    vi.spyOn(env.ROUTING, 'put').mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (key: string, value: any, options?: any) => {
        if (!aHoldFired && key === project.slug) {
          aHoldFired = true;
          holdFired?.();
          await aHold;
        }
        return originalPut(key, value, options);
      },
    );

    // Kick rollback A to B. It takes the row lock, re-reads, commits the
    // pg flip (active=B), then hits ROUTING.put(slug) and pauses inside
    // the spy while still holding the lock.
    //
    // Both rollbacks in this scenario carry non-empty diffs (A→B drops m3;
    // B→C drops m2) so the destructive guard would reject them without an
    // opt-in. The invariant here (a second rollback after the first) is
    // orthogonal, so echo each rollback's exact diff via `allowDestructive`.
    const rollbackAPromise = app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id, allowDestructive: ['m3.sql'] }),
      }),
      env,
    );
    await aReachedPut;

    // B is held at the waypoint between its pre-lock reads and its row-lock
    // acquisition, so it can only run once A's rollback — including the
    // post-commit lease cleanup — has finished. The wrapper is installed after
    // A's transaction started, so the first transaction it sees is B's.
    //
    // Without the hold the driver decides the order: PGlite queues statements,
    // so B's in-lock read runs after A's cleanup, while a pooled Postgres grants
    // the queued row lock at A's commit, so B resumes before that cleanup, reads
    // A's rollback lease and answers 409 `deploy in progress`. That fence is
    // real, but it is driver order rather than the sequence under test.
    //
    // This test therefore does not exercise row-lock contention between
    // rollbacks: on Postgres a rollback that wins the lock at the other's
    // commit still sees its rollback lease and answers 409, which is intended.
    // The row lock itself is covered by the `/apply` contention tests in this
    // file.
    const realDb = env.db;
    const realTransaction = realDb.transaction.bind(realDb);
    let releaseB: () => void = () => {};
    const bHold = new Promise<void>((r) => {
      releaseB = r;
    });
    let bHoldFired = false;
    const wrappedDb: Db = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (async (fn: any) => {
            if (!bHoldFired) {
              bHoldFired = true;
              await bHold;
            }
            return realTransaction(fn);
          }) as unknown as typeof realDb.transaction;
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;
    setTestDb(wrappedDb);

    // Kick rollback B to C. It does its pre-lock reads, then waits at the
    // waypoint until A's rollback has fully completed.
    const rollbackBPromise = app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depC.id, allowDestructive: ['m2.sql'] }),
      }),
      env,
    );

    // Release A. It commits the tx (pg active=B, ROUTING=B, etc) and clears its
    // rollback lease, then B acquires the lock and flips pg active=C, ROUTING=C.
    releaseA();
    const resA = await rollbackAPromise;
    expect(resA.status).toBe(200);
    releaseB();
    const resB = await rollbackBPromise;
    setTestDb(realDb);
    expect(resB.status).toBe(200);

    const bodyA = (await resA.json()) as {
      ok: boolean;
      deploymentId: string;
      migrationDiff: Array<string>;
    };
    const bodyB = (await resB.json()) as {
      ok: boolean;
      deploymentId: string;
      migrationDiff: Array<string>;
    };
    // A: current was A[m1,m2,m3], target B[m1,m2] → diff=[m3]
    expect(bodyA.deploymentId).toBe(depB.id);
    expect(bodyA.migrationDiff).toEqual(['m3.sql']);
    // B: current was B[m1,m2] (post-A's-commit), target C[m1] → diff=[m2]
    expect(bodyB.deploymentId).toBe(depC.id);
    expect(bodyB.migrationDiff).toEqual(['m2.sql']);

    // Final consistency: pg says active=C AND ROUTING.workerName matches C.
    // The pg flip happens FIRST inside the lock and external writes follow,
    // so running B after A guarantees pg and ROUTING converge on the same
    // terminal state.
    const finalPg = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(finalPg[0]!.active_deployment_id).toBe(depC.id);

    const finalRouting = (await env.ROUTING.get(project.slug, 'json')) as {
      workerName: string;
      version: string;
    };
    // `version` in the routing json holds the deployment id.
    expect(finalRouting.version).toBe(depC.id);
    expect(finalRouting.workerName).toBe(`user-r13f1-rb-rb-${depC.id}`);
  });

  it('rollback target.applied_migrations is re-read inside the row lock so /rename cannot stale the diff', async () => {
    // Rollback re-reads `target` inside the row-locked tx. Any concurrent
    // /rename that successfully commits must have landed BEFORE rollback's
    // lock acquisition (both take the same per-project row lock). This test
    // simulates an out-of-band write that lands between rollback's pre-lock
    // target read and rollback's lock acquisition — the window a buggy
    // /rename could exploit if the lock were ever relaxed.
    //
    // Mechanism: wrap testDb so `db.transaction(fn)` pauses before
    // delegating to the real transaction. Between /rollback's pre-lock
    // reads and its lock acquisition, we directly UPDATE the deployments
    // table to rewrite BOTH the active and the target's applied_migrations
    // (the same transformation /rename would apply). Release the hold, the
    // tx runs, and the in-lock re-read sees the mutated state.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r13f2-rb-rename');
    await insertD1Resource(env.db, project.id);

    // Active A=[m1,m2,m3]; retained target B=[m1,m2].
    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql', 'm2.sql', 'm3.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'void' }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql', 'm2.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'void' }),
      })
      .where(eq(deployments.id, depB.id));

    // Wrap env.db.transaction so we can pause before delegating to
    // the real implementation. This is the waypoint between
    // /rollback's pre-lock reads (target, project pre-check) and its
    // row-lock acquisition inside the tx callback.
    const realDb = env.db;
    const realTransaction = realDb.transaction.bind(realDb);
    let beforeTxResolver: (() => void) | undefined;
    let beforeTxReached: (() => void) | undefined;
    const beforeTxReachedPromise = new Promise<void>((r) => {
      beforeTxReached = r;
    });
    let beforeTxHoldFired = false;
    const wrappedDb: Db = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (async (fn: any) => {
            if (!beforeTxHoldFired) {
              beforeTxHoldFired = true;
              beforeTxReached?.();
              await new Promise<void>((r) => {
                beforeTxResolver = r;
              });
            }
            return realTransaction(fn);
          }) as unknown as typeof realDb.transaction;
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;
    setTestDb(wrappedDb);

    try {
      // Kick /rollback to B. It does the pre-lock reads, enters the
      // wrapped `transaction`, and pauses BEFORE calling the real
      // transaction (i.e., before the row lock is acquired).
      //
      // Post-rename, currentActive=[m1x, m2x, m3] and target=[m1x, m2x],
      // so the diff is [m3] — non-empty. This test's invariant (target
      // re-read inside the lock) is orthogonal to destructive rejection,
      // so echo the expected diff via `allowDestructive`.
      const rollbackPromise = app.fetch(
        authedReq(`/projects/${project.id}/rollback`, user.jwt, {
          method: 'POST',
          body: JSON.stringify({ deploymentId: depB.id, allowDestructive: ['m3.sql'] }),
        }),
        env,
      );
      await beforeTxReachedPromise;

      // Simulate a /rename that landed between the pre-lock target
      // read and the row-lock acquisition. Rewrite BOTH A and B as
      // /rename's renameAppliedMigrationsForProject would do:
      //   A: [m1, m2, m3] → [m1x, m2x, m3]
      //   B: [m1, m2]     → [m1x, m2x]
      //
      // We write through `realDb` (bypassing the proxy) so the
      // UPDATEs commit immediately — they don't go through the
      // transaction wrapper.
      await realDb
        .update(deployments)
        .set({ applied_migrations: JSON.stringify(['m1x.sql', 'm2x.sql', 'm3.sql']) })
        .where(eq(deployments.id, depA.id));
      await realDb
        .update(deployments)
        .set({ applied_migrations: JSON.stringify(['m1x.sql', 'm2x.sql']) })
        .where(eq(deployments.id, depB.id));

      // Release /rollback. It enters its real tx, takes the row lock,
      // re-reads target, computes diff, flips pg.
      beforeTxResolver?.();
      const rollbackRes = await rollbackPromise;
      expect(rollbackRes.status).toBe(200);
      const body = (await rollbackRes.json()) as {
        ok: boolean;
        deploymentId: string;
        migrationDiff: Array<string>;
      };
      expect(body.ok).toBe(true);
      expect(body.deploymentId).toBe(depB.id);
      // The in-lock re-read of target sees [m1x, m2x] and currentActive
      // is [m1x, m2x, m3], so the diff is [m3]. If target were captured
      // pre-lock as [m1, m2], the diff against the in-lock currentActive
      // [m1x, m2x, m3] would bogusly report the renamed names as missing
      // from target.
      expect(body.migrationDiff).toEqual(['m3.sql']);
    } finally {
      setTestDb(realDb);
    }
  });

  it('compensates external state when the rollback transaction rejects after its callback', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rollback-commit-failure');
    await insertD1Resource(env.db, project.id);
    const current = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'void' }),
      })
      .where(eq(deployments.id, current.id));
    const target = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'void' }),
      })
      .where(eq(deployments.id, target.id));
    const previousRouting = JSON.stringify({
      workerName: `user-${project.slug}-${current.id}`,
      version: current.id,
    });
    await env.ROUTING.put(project.slug, previousRouting);

    const realDb = env.db;
    const realTransaction = realDb.transaction.bind(realDb);
    let transactionCount = 0;
    const lateHostname = 'late-rollback-domain.example.com';
    const commitRejection = new Error('injected commit rejection');
    const wrappedDb: Db = new Proxy(realDb, {
      get(targetDb, prop, receiver) {
        if (prop === 'transaction') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (async (fn: any) => {
            transactionCount++;
            const rejectsCutover = transactionCount === 2;
            try {
              return await realTransaction(async (tx) => {
                const result = await fn(tx);
                if (rejectsCutover) {
                  // The cutover callback completed and wrote external state,
                  // but PostgreSQL rejects before committing its project flip.
                  throw commitRejection;
                }
                return result;
              });
            } catch (error) {
              if (error === commitRejection) {
                // Model domain activation winning the gap between the failed
                // rollback tx releasing the project lock and outer
                // compensation reacquiring it. It copies target routing that
                // the rollback wrote externally even though PostgreSQL stayed
                // on current.
                await realTransaction(async (tx) => {
                  await tx.insert(domains).values({
                    id: 'dom_late_rollback_compensation',
                    project_id: project.id,
                    hostname: lateHostname,
                    cf_hostname_id: 'ch-late-rollback-compensation',
                    status: 'active',
                  });
                  const temporaryTargetRouting = await env.ROUTING.get(project.slug);
                  expect(temporaryTargetRouting).toContain(target.id);
                  await env.ROUTING.put(`domain:${lateHostname}`, temporaryTargetRouting!);
                });
              }
              throw error;
            }
          }) as unknown as typeof realDb.transaction;
        }
        return Reflect.get(targetDb, prop, receiver);
      },
    }) as Db;
    setTestDb(wrappedDb);

    try {
      const response = await app.fetch(
        authedReq(`/projects/${project.id}/rollback`, user.jwt, {
          method: 'POST',
          body: JSON.stringify({ deploymentId: target.id }),
        }),
        env,
      );
      expect(response.status).toBe(500);
      expect((await env.ROUTING.get(project.slug))!).toBe(previousRouting);
      expect(await env.ROUTING.get(`domain:${lateHostname}`)).toBe(previousRouting);
      const restored = await env.db
        .select({ activeDeploymentId: projects.active_deployment_id })
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(restored[0]?.activeDeploymentId).toBe(current.id);
      const leases = await env.db
        .select({ id: deployments.id })
        .from(deployments)
        .where(eq(deployments.source, 'rollback-lease'));
      expect(leases).toHaveLength(0);
    } finally {
      setTestDb(realDb);
    }
  });

  it('preserves the rollback lease when the outer compensation transaction fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rollback-compensation-tx-failure');
    await insertD1Resource(env.db, project.id);
    const current = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ retained: true, manifest: JSON.stringify({ version: 4, type: 'void' }) })
      .where(eq(deployments.id, current.id));
    const target = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({ retained: true, manifest: JSON.stringify({ version: 4, type: 'void' }) })
      .where(eq(deployments.id, target.id));
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: `user-${project.slug}-${current.id}`, version: current.id }),
    );

    const realDb = env.db;
    const realTransaction = realDb.transaction.bind(realDb);
    let transactionCount = 0;
    const wrappedDb: Db = new Proxy(realDb, {
      get(targetDb, prop, receiver) {
        if (prop === 'transaction') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (async (fn: any) => {
            transactionCount++;
            if (transactionCount === 3) {
              // Lease creation is #1, rollback cutover is #2, and the guarded
              // outer compensation lock is #3.
              throw new Error('injected compensation transaction failure');
            }
            return realTransaction(async (tx) => {
              const result = await fn(tx);
              if (transactionCount === 2) {
                throw new Error('injected rollback commit rejection');
              }
              return result;
            });
          }) as unknown as typeof realDb.transaction;
        }
        return Reflect.get(targetDb, prop, receiver);
      },
    }) as Db;
    setTestDb(wrappedDb);

    try {
      const response = await app.fetch(
        authedReq(`/projects/${project.id}/rollback`, user.jwt, {
          method: 'POST',
          body: JSON.stringify({ deploymentId: target.id }),
        }),
        env,
      );
      expect(response.status).toBe(500);
    } finally {
      setTestDb(realDb);
    }

    const [lease] = await env.db
      .select({ id: deployments.id, manifest: deployments.manifest })
      .from(deployments)
      .where(eq(deployments.source, 'rollback-lease'));
    expect(lease).toBeDefined();
    expect(JSON.parse(lease!.manifest!)).toMatchObject({
      targetDeploymentId: target.id,
      state: 'retryable',
    });
    const [storedProject] = await env.db
      .select({ activeDeploymentId: projects.active_deployment_id })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(storedProject?.activeDeploymentId).toBe(current.id);
  });

  it('preserves a rollback whose COMMIT succeeded when its acknowledgement is lost', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rollback-lost-commit-ack');
    await insertD1Resource(env.db, project.id);
    const current = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ retained: true, manifest: JSON.stringify({ version: 4, type: 'void' }) })
      .where(eq(deployments.id, current.id));
    const target = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({ retained: true, manifest: JSON.stringify({ version: 4, type: 'void' }) })
      .where(eq(deployments.id, target.id));
    await env.db
      .update(projects)
      .set({ active_deployment_id: current.id })
      .where(eq(projects.id, project.id));
    const previousRouting = JSON.stringify({
      workerName: `user-${project.slug}-${current.id}`,
      version: current.id,
    });
    await env.ROUTING.put(project.slug, previousRouting);

    const realDb = env.db;
    const realTransaction = realDb.transaction.bind(realDb);
    let transactionCount = 0;
    const wrappedDb: Db = new Proxy(realDb, {
      get(targetDb, prop, receiver) {
        if (prop === 'transaction') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (async (fn: any) => {
            transactionCount++;
            const result = await realTransaction(fn);
            if (transactionCount === 2) {
              throw new Error('database connection lost after COMMIT');
            }
            return result;
          }) as unknown as typeof realDb.transaction;
        }
        return Reflect.get(targetDb, prop, receiver);
      },
    }) as Db;
    setTestDb(wrappedDb);

    try {
      const response = await app.fetch(
        authedReq(`/projects/${project.id}/rollback`, user.jwt, {
          method: 'POST',
          body: JSON.stringify({ deploymentId: target.id }),
        }),
        env,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, deploymentId: target.id });

      const routing = await env.ROUTING.get(project.slug);
      expect(routing).toContain(target.id);
      const [updatedProject] = await env.db
        .select({ activeDeploymentId: projects.active_deployment_id })
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(updatedProject?.activeDeploymentId).toBe(target.id);
      const leases = await env.db
        .select({ id: deployments.id })
        .from(deployments)
        .where(eq(deployments.source, 'rollback-lease'));
      expect(leases).toHaveLength(0);
    } finally {
      setTestDb(realDb);
    }
  });

  it('keeps an adopted rollback lease when its retry fails before a durable commit', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rollback-adopted-lease-failure');
    await insertD1Resource(env.db, project.id);
    const current = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ retained: true, manifest: JSON.stringify({ version: 4, type: 'void' }) })
      .where(eq(deployments.id, current.id));
    const target = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({ retained: true, manifest: JSON.stringify({ version: 4, type: 'void' }) })
      .where(eq(deployments.id, target.id));

    // Model the result of an earlier rollback whose COMMIT outcome was
    // unreadable: PostgreSQL still points at `current`, external routing may
    // already point at `target`, and a retryable lease fences that divergence.
    const lease = await createTestDeployment(env.db, project.id, 'pending', 'rollback-lease');
    await env.db
      .update(deployments)
      .set({
        manifest: JSON.stringify({
          version: 1,
          targetDeploymentId: target.id,
          state: 'retryable',
          ownerId: 'abandoned-owner',
        }),
      })
      .where(eq(deployments.id, lease.id));
    const divergentRouting = JSON.stringify({
      workerName: `user-${project.slug}-${target.id}`,
      version: target.id,
    });
    await env.ROUTING.put(project.slug, divergentRouting);

    // The same-target retry adopts the lease, then fails on its first
    // external write. Its compensation snapshot is already the divergent
    // target route, so releasing the adopted lease here would make the split
    // brain permanent and allow unrelated operations through.
    const putSpy = vi
      .spyOn(env.ROUTING, 'put')
      .mockRejectedValueOnce(new Error('injected KV failure'));
    const response = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: target.id }),
      }),
      env,
    );
    expect(response.status).toBe(500);
    expect(await env.ROUTING.get(project.slug)).toBe(divergentRouting);
    putSpy.mockRestore();

    const [preservedLease] = await env.db
      .select({ id: deployments.id, manifest: deployments.manifest })
      .from(deployments)
      .where(eq(deployments.id, lease.id));
    expect(preservedLease?.id).toBe(lease.id);
    expect(JSON.parse(preservedLease!.manifest!)).toMatchObject({
      targetDeploymentId: target.id,
      state: 'retryable',
    });

    // A different rollback target must still observe the fence rather than
    // making either side of the unresolved split brain authoritative.
    const blocked = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: current.id }),
      }),
      env,
    );
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: `deploy in progress: ${lease.id}` });

    // The abandoned request's `finally` is owner-scoped and cannot delete the
    // fence after this retry atomically adopted it.
    expect(await deleteRollbackLease(env.db, lease.id, 'abandoned-owner')).toBe(false);
    expect(
      await env.db.select().from(deployments).where(eq(deployments.id, lease.id)),
    ).toHaveLength(1);
  });

  it('rollback deletes stale queue KV routes that only the previous active deployment bound', async () => {
    // Rollback diffs `currentActive.manifest.queues` against
    // `target.manifest.queues` by queue name and deletes any queue KV route
    // that A bound but B does not. Otherwise `queue:<stale>` would still
    // point at A's evicted worker and the dispatch relay would forward
    // messages to it — a data-plane correctness bug. The diff runs inside
    // the locked tx after the pg flip, so a concurrent deploy or rollback
    // cannot race the sweep.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r14f1-queue-sweep');
    await insertD1Resource(env.db, project.id);

    // Seed resources for all three queues (q1, q2, q3). q1 only A
    // binds, q2 both A and B bind, q3 only B binds. Without resource
    // rows, rollback's PUT loop for B skips queues that lack a
    // matching resource — we want B to actually write its routes.
    await env.db.insert(resources).values([
      {
        id: `res_${project.id}_q1`,
        project_id: project.id,
        type: 'queue',
        cf_id: '11111111111111111111111111111111',
        binding_name: 'q1',
      },
      {
        id: `res_${project.id}_q2`,
        project_id: project.id,
        type: 'queue',
        cf_id: '22222222222222222222222222222222',
        binding_name: 'q2',
      },
      {
        id: `res_${project.id}_q3`,
        project_id: project.id,
        type: 'queue',
        cf_id: '33333333333333333333333333333333',
        binding_name: 'q3',
      },
    ]);

    // Active A binds q1, q2. Target B binds q2, q3.
    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'void',
          queues: [
            { name: 'q1', bindingName: 'Q1' },
            { name: 'q2', bindingName: 'Q2' },
          ],
        }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'void',
          queues: [
            { name: 'q2', bindingName: 'Q2' },
            { name: 'q3', bindingName: 'Q3' },
          ],
        }),
      })
      .where(eq(deployments.id, depB.id));

    // Compute the actual KV key shape the way production does:
    // `queue:${projectId-lowercased-and-hyphenated}-${queueBinding}`.
    // See `getProjectQueueName` in packages/api/src/naming.ts.
    const queueKey = (name: string): string => {
      const normalized = `${project.id}-${name}`.toLowerCase().replaceAll('_', '-');
      return `queue:${normalized}`;
    };

    // Pre-seed KV with A's queue routes (what a real live deploy of A
    // would have left). q1 and q2 point at A's worker.
    const workerA = `user-r14f1-queue-sweep-${depA.id}`;
    const workerB = `user-r14f1-queue-sweep-${depB.id}`;
    await env.ROUTING.put(
      queueKey('q1'),
      JSON.stringify({ workerName: workerA, projectId: project.id, queueName: 'q1' }),
    );
    await env.ROUTING.put(
      queueKey('q2'),
      JSON.stringify({ workerName: workerA, projectId: project.id, queueName: 'q2' }),
    );

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id }),
      }),
      env,
    );
    expect(rollbackRes.status).toBe(200);

    // q2 — still bound by B: KV entry rewritten to point at B's worker.
    const q2Entry = (await env.ROUTING.get(queueKey('q2'), 'json')) as {
      workerName: string;
      projectId: string;
      queueName: string;
    } | null;
    expect(q2Entry).not.toBeNull();
    expect(q2Entry!.workerName).toBe(workerB);
    expect(q2Entry!.queueName).toBe('q2');

    // q3 — newly bound by B: KV entry created pointing at B's worker.
    const q3Entry = (await env.ROUTING.get(queueKey('q3'), 'json')) as {
      workerName: string;
      projectId: string;
      queueName: string;
    } | null;
    expect(q3Entry).not.toBeNull();
    expect(q3Entry!.workerName).toBe(workerB);
    expect(q3Entry!.queueName).toBe('q3');

    // q1 — only A bound it. The sweep MUST delete this stale entry so
    // messages arriving on q1 do not get relayed to A's evicted worker.
    const q1Entry = await env.ROUTING.get(queueKey('q1'));
    expect(q1Entry).toBeNull();
  });

  it('rollback cron reconciliation is driven by the pg manifest, not stale ROUTING KV', async () => {
    // The clear-vs-sync decision uses `currentActive.manifest.schedules`
    // in pg, the authoritative record of what A registered. KV's
    // `hasCrons` flag can lie (if an earlier deploy flipped pg but
    // crashed before rewriting KV). A manifest-driven reconciliation
    // must ignore KV's flag and still clear the DO when pg says the
    // outgoing active had schedules.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r14f2-cron-manifest');
    await insertD1Resource(env.db, project.id);

    // Active A registered a cron. Target B has no schedules.
    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'void',
          schedules: [{ name: 'a-cron', cron: '*/5 * * * *' }],
        }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'void' }),
      })
      .where(eq(deployments.id, depB.id));

    // Pre-seed KV slug entry with `hasCrons: false` — a "stale KV" state.
    // Any real deploy would have
    // written `hasCrons: true` (matching pg), but a partial failure
    // could leave KV inconsistent. A manifest-driven reconciliation
    // must ignore this and still clear the DO.
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({
        workerName: `user-${project.slug}-${depA.id}`,
        version: depA.id,
        hasCrons: false,
      }),
    );

    // Intercept the CRON_SCHEDULER DO fetch so we can observe which
    // path (sync vs clear) rollback took.
    const doCalls: Array<{ url: string; method: string; body: string | null }> = [];
    const originalGet = env.CRON_SCHEDULER.get.bind(env.CRON_SCHEDULER);
    vi.spyOn(env.CRON_SCHEDULER, 'get').mockImplementation((id) => {
      const stub = originalGet(id);
      return {
        ...stub,
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          doCalls.push({
            url: url.pathname,
            method: req.method,
            body: req.body ? await req.text() : null,
          });
          return new Response('{}', { status: 200 });
        },
      } as unknown as DurableObjectStub;
    });

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id }),
      }),
      env,
    );
    expect(rollbackRes.status).toBe(200);

    // Rollback snapshots the scheduler for compensation, then sees
    // `currentActive.manifest.schedules` non-empty and the target's
    // manifest with no schedules, so it calls `/clear` regardless of
    // the stale KV `hasCrons: false`.
    expect(doCalls.map((call) => call.url)).toEqual(['/snapshot', '/clear']);
    expect(doCalls[1]!.method).toBe('POST');
  });

  it('rollback queue sweep unions manifests from activated deployments and deletes historical orphans', async () => {
    // Rollback's queue sweep candidate set is the union of queue names
    // across all deployments that have ever been live
    // (`deployed_at IS NOT NULL`). Simple current-vs-target manifest diff
    // would miss queue routes left behind by even older deployments whose
    // manifests are no longer referenced by either side. Enumerating the
    // pg `resources` table would race a mid-provisioning deploy (resources
    // rows are written before the deployment reaches live). The
    // deployed_at union catches historical orphans without falling for any
    // in-flight deploy.
    //
    // Scenario: retained-but-previously-live C bound q1, currentActive A
    // bound q2, rollback A→B with B binding q3. The sweep must delete q1's
    // orphan route even though neither A nor B mentions it.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r15f1-queue-orphan');
    await insertD1Resource(env.db, project.id);
    await env.db.insert(resources).values({
      id: `res_${project.id}_q3`,
      project_id: project.id,
      type: 'queue',
      cf_id: '33333333333333333333333333333333',
      binding_name: 'q3',
    });

    // Queue names come from deployment manifests, not the resources
    // table. q1 must be attached to a deployment that was once `live`
    // (deploy C) so the manifest-union sweep can discover it.
    const depC = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'void',
          queues: [{ name: 'q1', bindingName: 'Q1' }],
        }),
      })
      .where(eq(deployments.id, depC.id));

    // currentActive A's manifest only lists q2 — q1 is an orphan from
    // older deploy C (C was live at some point, so its manifest shows
    // up in the union; that's what the sweep uses to catch q1).
    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'void',
          queues: [{ name: 'q2', bindingName: 'Q2' }],
        }),
      })
      .where(eq(deployments.id, depA.id));
    // Target B binds q3.
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'void',
          queues: [{ name: 'q3', bindingName: 'Q3' }],
        }),
      })
      .where(eq(deployments.id, depB.id));

    const queueKey = (name: string): string => {
      const normalized = `${project.id}-${name}`.toLowerCase().replaceAll('_', '-');
      return `queue:${normalized}`;
    };

    // Pre-seed KV with q1 (from historical deploy C) and q2 (from A).
    // Both currently point at workers that are NOT B — q1 at C's
    // worker (long-evicted), q2 at A's worker (about to be evicted).
    const workerC = `user-r15f1-queue-orphan-${depC.id}`;
    const workerA = `user-r15f1-queue-orphan-${depA.id}`;
    const workerB = `user-r15f1-queue-orphan-${depB.id}`;
    await env.ROUTING.put(
      queueKey('q1'),
      JSON.stringify({ workerName: workerC, projectId: project.id, queueName: 'q1' }),
    );
    await env.ROUTING.put(
      queueKey('q2'),
      JSON.stringify({ workerName: workerA, projectId: project.id, queueName: 'q2' }),
    );

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id }),
      }),
      env,
    );
    expect(rollbackRes.status).toBe(200);

    // q3 — newly bound by B: KV entry created pointing at B's worker.
    const q3Entry = (await env.ROUTING.get(queueKey('q3'), 'json')) as {
      workerName: string;
      projectId: string;
      queueName: string;
    } | null;
    expect(q3Entry).not.toBeNull();
    expect(q3Entry!.workerName).toBe(workerB);

    // q2 — bound by currentActive A but not target B. Deleted.
    const q2Entry = await env.ROUTING.get(queueKey('q2'));
    expect(q2Entry).toBeNull();

    // q1 — orphan from a historical deploy (C). Neither A's nor B's
    // manifest mentions it, but C's manifest joins the union via
    // `deployed_at IS NOT NULL`, so q1's KV route is reclaimed.
    // Load-bearing assertion for the manifest-union sweep.
    const q1Entry = await env.ROUTING.get(queueKey('q1'));
    expect(q1Entry).toBeNull();
  });

  it('rollback rejects while a queue deployment is in flight', async () => {
    // Rollback must not race an in-flight deployment. Rejecting before
    // any cutover write protects both the current active routes and the
    // in-flight deployment's pre-staged queue route.
    //
    // Scenario: rollback A→B with an in-flight D sitting in status
    // `uploading` that has pre-staged q4 into resources + KV. Assert
    // q4's KV route survives.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r16f2-inflight');
    await insertD1Resource(env.db, project.id);

    // currentActive A binds q1. Target B binds q5.
    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'void',
          queues: [{ name: 'q1', bindingName: 'Q1' }],
        }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'void',
          queues: [{ name: 'q5', bindingName: 'Q5' }],
        }),
      })
      .where(eq(deployments.id, depB.id));

    // In-flight D: status uploading/migrating, never reached live.
    // `createTestDeployment` only stamps `deployed_at` for status
    // 'live', so D has `deployed_at = null` — the sweep excludes it
    // from the candidate set even though its manifest lists q4 and its
    // resources row exists.
    const depD = await createTestDeployment(env.db, project.id, 'uploading');
    await env.db
      .update(deployments)
      .set({
        manifest: JSON.stringify({
          version: 4,
          type: 'void',
          queues: [{ name: 'q4', bindingName: 'Q4' }],
        }),
      })
      .where(eq(deployments.id, depD.id));
    // D pre-staged q4 into the resources table the way provisioning
    // does before the cutover. A resources-table sweep would see this
    // row and incorrectly pull q4 into the delete set.
    await env.db.insert(resources).values({
      id: `res_${project.id}_q4`,
      project_id: project.id,
      type: 'queue',
      cf_id: 'cf-q4',
      binding_name: 'q4',
    });

    const queueKey = (name: string): string => {
      const normalized = `${project.id}-${name}`.toLowerCase().replaceAll('_', '-');
      return `queue:${normalized}`;
    };

    // Pre-seed KV: q1 from A, q4 from in-flight D.
    const workerA = `user-r16f2-inflight-${depA.id}`;
    const workerD = `user-r16f2-inflight-${depD.id}`;
    await env.ROUTING.put(
      queueKey('q1'),
      JSON.stringify({ workerName: workerA, projectId: project.id, queueName: 'q1' }),
    );
    await env.ROUTING.put(
      queueKey('q4'),
      JSON.stringify({ workerName: workerD, projectId: project.id, queueName: 'q4' }),
    );

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id }),
      }),
      env,
    );
    expect(rollbackRes.status).toBe(409);

    // No rollback writes occur: A remains routed, B is not staged by
    // rollback, and D's own pre-staged route remains intact.
    const q1Entry = await env.ROUTING.get(queueKey('q1'));
    expect(q1Entry).not.toBeNull();

    // q5 — target B's queue. The rejected rollback never writes it.
    const q5Entry = await env.ROUTING.get(queueKey('q5'));
    expect(q5Entry).toBeNull();

    // q4 — owned by in-flight D. The active-deploy guard leaves it intact.
    const q4Entry = await env.ROUTING.get(queueKey('q4'));
    expect(q4Entry).not.toBeNull();
  });

  it('rollback queue sweep reclaims KV routes from terminal-failed deployments', async () => {
    // The sweep's candidate set unions `getActivatedDeployments` with
    // `getTerminalFailedDeployments` (status in failed/canceled with
    // `deployed_at = null`) — defense in depth to reclaim queue KV routes
    // left behind by a deploy that wrote routes at step 2b (queue_setup)
    // and failed later without its eager cleanup firing. The deploy-side
    // cleanup is still the primary reclaim path.
    //
    // Scenario: currentActive A binds q1, target B binds q2, terminal-
    // failed C (never reached live) bound q3 and pre-seeded `queue:<q3>`
    // in KV. Rollback A→B must reclaim q3's KV route via the union.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r17f1-terminal-failed');
    await insertD1Resource(env.db, project.id);
    await env.db.insert(resources).values({
      id: `res_${project.id}_q2`,
      project_id: project.id,
      type: 'queue',
      cf_id: '22222222222222222222222222222222',
      binding_name: 'q2',
    });

    // currentActive A binds q1.
    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'void',
          queues: [{ name: 'q1', bindingName: 'Q1' }],
        }),
      })
      .where(eq(deployments.id, depA.id));

    // Target B binds q2.
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'void',
          queues: [{ name: 'q2', bindingName: 'Q2' }],
        }),
      })
      .where(eq(deployments.id, depB.id));

    // Terminal-failed deploy C: status=failed, `deployed_at=null`,
    // manifest lists q3. This simulates a deploy that wrote its queue
    // KV routes at step 2b and then failed at a later step without its
    // eager cleanup running.
    const depC = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        manifest: JSON.stringify({
          version: 4,
          type: 'void',
          queues: [{ name: 'q3', bindingName: 'Q3' }],
        }),
      })
      .where(eq(deployments.id, depC.id));

    const queueKey = (name: string): string => {
      const normalized = `${project.id}-${name}`.toLowerCase().replaceAll('_', '-');
      return `queue:${normalized}`;
    };

    // Pre-seed KV: q1 from A, q3 from terminal-failed C. q2 will be
    // written by rollback's cutover.
    const workerA = `user-r17f1-terminal-failed-${depA.id}`;
    const workerC = `user-r17f1-terminal-failed-${depC.id}`;
    await env.ROUTING.put(
      queueKey('q1'),
      JSON.stringify({ workerName: workerA, projectId: project.id, queueName: 'q1' }),
    );
    await env.ROUTING.put(
      queueKey('q3'),
      JSON.stringify({ workerName: workerC, projectId: project.id, queueName: 'q3' }),
    );

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id }),
      }),
      env,
    );
    expect(rollbackRes.status).toBe(200);

    // q1 — A's queue. Expected to be swept (A was activated, not in target).
    expect(await env.ROUTING.get(queueKey('q1'))).toBeNull();

    // q2 — B's queue. Rollback's cutover rewrites this.
    expect(await env.ROUTING.get(queueKey('q2'))).not.toBeNull();

    // q3 — orphan from terminal-failed C. C joins the union via
    // `getTerminalFailedDeployments` and q3's KV route is reclaimed.
    // Load-bearing assertion.
    expect(await env.ROUTING.get(queueKey('q3'))).toBeNull();
  });

  it('rollback remains blocked by in-flight deploys when terminal failures exist', async () => {
    // Terminal-failed deployment history must not weaken the active-deploy
    // guard. The request is rejected before changing A's or D's routes.
    //
    // Scenario: currentActive A binds q1, target B binds q2, in-flight D
    // (status=uploading, `deployed_at=null`) binds q4 and has pre-seeded
    // its KV route. Rollback A→B must NOT touch q4.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r17f1-inflight-negative');
    await insertD1Resource(env.db, project.id);

    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'void',
          queues: [{ name: 'q1', bindingName: 'Q1' }],
        }),
      })
      .where(eq(deployments.id, depA.id));

    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'void',
          queues: [{ name: 'q2', bindingName: 'Q2' }],
        }),
      })
      .where(eq(deployments.id, depB.id));

    // In-flight D: status=uploading, `deployed_at=null`. Not in the
    // terminal-failed set (status filter), not in the activated set
    // (deployed_at filter). Manifest lists q4.
    const depD = await createTestDeployment(env.db, project.id, 'uploading');
    await env.db
      .update(deployments)
      .set({
        manifest: JSON.stringify({
          version: 4,
          type: 'void',
          queues: [{ name: 'q4', bindingName: 'Q4' }],
        }),
      })
      .where(eq(deployments.id, depD.id));

    const queueKey = (name: string): string => {
      const normalized = `${project.id}-${name}`.toLowerCase().replaceAll('_', '-');
      return `queue:${normalized}`;
    };

    const workerA = `user-r17f1-inflight-negative-${depA.id}`;
    const workerD = `user-r17f1-inflight-negative-${depD.id}`;
    await env.ROUTING.put(
      queueKey('q1'),
      JSON.stringify({ workerName: workerA, projectId: project.id, queueName: 'q1' }),
    );
    await env.ROUTING.put(
      queueKey('q4'),
      JSON.stringify({ workerName: workerD, projectId: project.id, queueName: 'q4' }),
    );

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id }),
      }),
      env,
    );
    expect(rollbackRes.status).toBe(409);

    // q1 remains on A because the rollback never starts its cutover.
    expect(await env.ROUTING.get(queueKey('q1'))).not.toBeNull();

    // q4 — in-flight D's queue. Neither activated nor terminal-failed,
    // so excluded from the sweep candidate set. MUST survive.
    expect(await env.ROUTING.get(queueKey('q4'))).not.toBeNull();
  });

  it('rollback leaves deployment-scoped ISR caches untouched', async () => {
    // ISR keys include the deployment id, so switching routing to the rollback
    // target automatically switches cache namespaces. The replaced deployment's
    // warmed HTML can remain in KV because dispatch cannot select it while a
    // different deployment id is active.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r15f2-isr-purge');
    await insertD1Resource(env.db, project.id);

    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'void' }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'void' }),
      })
      .where(eq(deployments.id, depB.id));

    // Pre-seed an ISR entry representing a page warmed by the currently-active
    // deployment. Rollback does not delete it.
    const isrKey = `${project.id}/isr/v2/${depA.id}/page1`;
    await env.ISR_CACHE.put(isrKey, 'previous-deployment-html');

    const isrDeleteSpy = vi.spyOn(env.ISR_CACHE, 'delete');

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id }),
      }),
      env,
    );
    expect(rollbackRes.status).toBe(200);

    expect(isrDeleteSpy).not.toHaveBeenCalledWith(isrKey);

    const afterIsr = await env.ISR_CACHE.get(isrKey);
    expect(afterIsr).toBe('previous-deployment-html');
  });

  it('rollback unconditionally clears cron DO when target has no schedules', async () => {
    // When target has no schedules, rollback calls `/clear` on the
    // CronScheduler DO unconditionally. `/clear` is idempotent (deletes
    // all storage and returns ok) so it is a cheap no-op against an
    // already-empty DO, but it heals a DO carrying ghost schedules from
    // a partial prior cutover that the last-committed active's manifest
    // no longer mentions.
    //
    // Scenario: both currentActive A and target B have empty `schedules`
    // — `/clear` must still fire.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r15f3-cron-clear');
    await insertD1Resource(env.db, project.id);

    // Both A and B have manifests without any `schedules` field.
    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'void' }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'void' }),
      })
      .where(eq(deployments.id, depB.id));

    // Intercept CRON_SCHEDULER DO fetches to observe which calls
    // (sync / clear / neither) rollback actually made.
    const doCalls: Array<{ url: string; method: string }> = [];
    const originalGet = env.CRON_SCHEDULER.get.bind(env.CRON_SCHEDULER);
    vi.spyOn(env.CRON_SCHEDULER, 'get').mockImplementation((id) => {
      const stub = originalGet(id);
      return {
        ...stub,
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          doCalls.push({ url: url.pathname, method: req.method });
          return new Response('{}', { status: 200 });
        },
      } as unknown as DurableObjectStub;
    });

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id }),
      }),
      env,
    );
    expect(rollbackRes.status).toBe(200);

    // Load-bearing: after taking a compensation snapshot, `/clear` fires
    // even though neither manifest lists schedules — idempotent against
    // an already-empty DO and healing stale schedules from a partial cutover.
    expect(doCalls.map((call) => call.url)).toEqual(['/snapshot', '/clear']);
    expect(doCalls[1]!.method).toBe('POST');
  });

  it('rollback destructive diff is rejected server-side without explicit override', async () => {
    // Rolling back when the current active deployment has migrations the
    // target does NOT include is destructive: the target's worker code
    // expects the old schema but the live D1 has been evolved past that
    // point. When `diff.length > 0` and the caller did not echo the exact
    // server-computed diff via `allowDestructive`, reject with 400 BEFORE
    // flipping pg or writing any external state. Matches the
    // `void:allow-destructive` opt-in required by /migrations/apply.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f1-destructive');
    await insertD1Resource(env.db, project.id);

    // Active A=[m1, m2]; retained target B=[m1]. Rolling back A→B
    // drops m2 from the target's known migrations while D1 still has
    // both rows — a destructive rollback.
    //
    // A binds one queue (`work-queue`) that B does NOT. If rollback got
    // past the destructive guard and reached its external-write phase,
    // `getActivatedDeployments` would find depA (live, deployed_at set
    // by the helper) and the queue-sweep loop would `ROUTING.delete`
    // the `queue:<projectId>:work-queue` KV key that B's empty queue
    // set does not own. That makes the `routingDeleteSpy` assertion
    // below MEANINGFUL — without a queue binding difference between
    // A and B, `ROUTING.delete` would never fire in this scenario
    // regardless of the guard, and the zero-call assertion would be
    // a false-positive safe.
    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql', 'm2.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'void',
          queues: [{ name: 'work-queue' }],
        }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'void' }),
      })
      .where(eq(deployments.id, depB.id));

    // Spy on every external write surface the rollback handler touches
    // AFTER the destructive guard. The pg-state assertions below already
    // pin "the flip didn't commit", but pg state alone does not catch a
    // future refactor that accidentally moves the guard BELOW the
    // ROUTING.put / CRON_SCHEDULER.fetch calls (split-brain: pg
    // unchanged, KV/DO already pointed at the rollback target). The
    // entire purpose of the guard is to prevent that partial-cutover
    // state, so the test must prove the external-write invariant
    // directly. Each spy must record ZERO calls when the guard rejects.
    const routingPutSpy = vi.spyOn(env.ROUTING, 'put');
    const routingDeleteSpy = vi.spyOn(env.ROUTING, 'delete');
    // Cron sync/clear in /rollback always begins with
    // `CRON_SCHEDULER.idFromName(projectId)` before `.get(id).fetch(…)`,
    // so a zero-call assertion on `idFromName` proves no DO traffic was
    // emitted — without needing to wrap the DO stub returned by `.get()`.
    const cronIdFromNameSpy = vi.spyOn(env.CRON_SCHEDULER, 'idFromName');

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id }),
      }),
      env,
    );

    // 1. Handler rejects with 400.
    expect(rollbackRes.status).toBe(400);
    const body = (await rollbackRes.json()) as {
      error?: string;
      destructiveMigrations?: Array<string>;
    };
    // 2. Error message names the destructive migration(s) and tells the
    //    caller how to override.
    expect(body.error).toBeTruthy();
    expect(body.error).toMatch(/m2\.sql/);
    expect(body.error).toMatch(/allowDestructive/);
    // 3. Structured `destructiveMigrations` echoes the server-computed
    //    diff verbatim so programmatic callers (CLI retry, dashboard)
    //    don't have to parse the human message.
    expect(body.destructiveMigrations).toEqual(['m2.sql']);

    // 3. project.active_deployment_id must NOT have flipped to B.
    const proj = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(proj[0]!.active_deployment_id).toBe(depA.id);

    // 4. Neither deployment's applied_migrations was mutated.
    const rowA = await env.db.select().from(deployments).where(eq(deployments.id, depA.id));
    const rowB = await env.db.select().from(deployments).where(eq(deployments.id, depB.id));
    expect(JSON.parse(rowA[0]!.applied_migrations!)).toEqual(['m1.sql', 'm2.sql']);
    expect(JSON.parse(rowB[0]!.applied_migrations!)).toEqual(['m1.sql']);

    // 5. NO external write surface was touched. This is the load-bearing
    //    invariant the guard exists to enforce: the rejection path must
    //    leave KV (slug + domain + queue routes) and the cron DO
    //    untouched, so the pg + KV + DO trio cannot drift into a
    //    split-brain state. If a future refactor moves the guard below
    //    `setActiveDeployment` / `ROUTING.put` / cron sync, these
    //    assertions fail.
    expect(routingPutSpy).not.toHaveBeenCalled();
    expect(routingDeleteSpy).not.toHaveBeenCalled();
    expect(cronIdFromNameSpy).not.toHaveBeenCalled();
  });

  it('rollback destructive diff is allowed when caller echoes the diff via allowDestructive', async () => {
    // Override path: callers who understand the destructive consequence
    // can force the rollback through by echoing the exact set of
    // migrations the server-computed diff contains via `allowDestructive`.
    // Cutover proceeds and `migrationDiff` lists those migrations.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f1-override');
    await insertD1Resource(env.db, project.id);

    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql', 'm2.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'void' }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'void' }),
      })
      .where(eq(deployments.id, depB.id));

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id, allowDestructive: ['m2.sql'] }),
      }),
      env,
    );
    expect(rollbackRes.status).toBe(200);
    const body = (await rollbackRes.json()) as {
      ok: boolean;
      deploymentId: string;
      migrationDiff: Array<string>;
    };
    expect(body.ok).toBe(true);
    expect(body.deploymentId).toBe(depB.id);
    expect(body.migrationDiff).toEqual(['m2.sql']);

    // Flip DID happen — pg now points at B.
    const proj = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(proj[0]!.active_deployment_id).toBe(depB.id);
  });

  it('rollback destructive diff rejects allowDestructive snapshot mismatch', async () => {
    // `allowDestructive` is not a blanket boolean — it is an ECHO of the
    // exact set of migrations the caller believes the server-computed
    // diff contains. The server accepts the rollback only when the
    // caller's set is SET-EQUAL to its own computed diff (same size, same
    // elements). A partial or mismatched set must be rejected with 400,
    // and the rejection must leave every external write surface untouched.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f1-mismatch');
    await insertD1Resource(env.db, project.id);

    // Active A=[m1, m2, m3]; retained target B=[m1]. Server-computed
    // diff = [m2, m3]. Caller will confirm only [m2] — a strict
    // subset — which must be rejected.
    //
    // A binds one queue (`work-queue`) that B does NOT, mirroring the
    // no-override reject-path test. This makes the `routingDeleteSpy`
    // zero-call assertion meaningful: if a future refactor moved the
    // guard below the queue-sweep loop, this queue-binding difference
    // would cause `ROUTING.delete` to fire.
    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql', 'm2.sql', 'm3.sql']),
        retained: true,
        manifest: JSON.stringify({
          version: 4,
          type: 'void',
          queues: [{ name: 'work-queue' }],
        }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify(['m1.sql']),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'void' }),
      })
      .where(eq(deployments.id, depB.id));

    // Spies on the external-write surfaces the rollback handler touches
    // AFTER the destructive guard. Zero calls on all three proves the
    // rejection landed before any KV/DO traffic was emitted.
    const routingPutSpy = vi.spyOn(env.ROUTING, 'put');
    const routingDeleteSpy = vi.spyOn(env.ROUTING, 'delete');
    const cronIdFromNameSpy = vi.spyOn(env.CRON_SCHEDULER, 'idFromName');

    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        // Caller confirms only m2, but the actual server-computed diff
        // is [m2, m3]. Set-inequality must trigger the guard.
        body: JSON.stringify({ deploymentId: depB.id, allowDestructive: ['m2.sql'] }),
      }),
      env,
    );

    // 1. Handler rejects with 400.
    expect(rollbackRes.status).toBe(400);
    const body = (await rollbackRes.json()) as {
      error?: string;
      destructiveMigrations?: Array<string>;
    };
    // 2. Error message names the full server-computed diff (both m2 and
    //    m3) and tells the caller how to override.
    expect(body.error).toBeTruthy();
    expect(body.error).toMatch(/m2\.sql/);
    expect(body.error).toMatch(/m3\.sql/);
    expect(body.error).toMatch(/allowDestructive/);
    // 3. Structured `destructiveMigrations` is the authoritative diff
    //    the caller must echo on retry.
    expect(body.destructiveMigrations).toEqual(['m2.sql', 'm3.sql']);

    // 4. project.active_deployment_id must NOT have flipped to B.
    const proj = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(proj[0]!.active_deployment_id).toBe(depA.id);

    // 5. Neither deployment's applied_migrations was mutated.
    const rowA = await env.db.select().from(deployments).where(eq(deployments.id, depA.id));
    const rowB = await env.db.select().from(deployments).where(eq(deployments.id, depB.id));
    expect(JSON.parse(rowA[0]!.applied_migrations!)).toEqual(['m1.sql', 'm2.sql', 'm3.sql']);
    expect(JSON.parse(rowB[0]!.applied_migrations!)).toEqual(['m1.sql']);

    // 6. NO external write surface was touched.
    expect(routingPutSpy).not.toHaveBeenCalled();
    expect(routingDeleteSpy).not.toHaveBeenCalled();
    expect(cronIdFromNameSpy).not.toHaveBeenCalled();
  });

  it('rollback destructive rejection is JSON-safe for exotic migration names', async () => {
    // Migration names are arbitrary non-empty strings (see
    // /rename, which accepts any non-empty string). A rejection payload
    // that hand-builds the retry hint via string concatenation breaks
    // for names containing quotes / backslashes / newlines — the
    // suggested `allowDestructive: [...]` literal becomes invalid JSON
    // and the caller cannot copy-paste the server's own suggestion.
    // The server must (a) format the prose hint via JSON.stringify so
    // exotic characters are escaped, and (b) expose the diff
    // structurally as `destructiveMigrations` so programmatic callers
    // never depend on string parsing in the first place.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'r25f1-exotic');
    await insertD1Resource(env.db, project.id);

    // A migration name containing every character class that naive
    // string concatenation would mis-quote: double quote, backslash,
    // newline. This is a valid rename target today.
    const exoticName = `weird"name\\with\nnewline.sql`;
    const safeName = 'm_safe.sql';

    const depA = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify([safeName, exoticName]),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'void' }),
      })
      .where(eq(deployments.id, depA.id));
    const depB = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({
        applied_migrations: JSON.stringify([safeName]),
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'void' }),
      })
      .where(eq(deployments.id, depB.id));

    // No override → guaranteed rejection.
    const rollbackRes = await app.fetch(
      authedReq(`/projects/${project.id}/rollback`, user.jwt, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: depB.id }),
      }),
      env,
    );

    expect(rollbackRes.status).toBe(400);
    const body = (await rollbackRes.json()) as {
      error?: string;
      destructiveMigrations?: Array<string>;
    };

    // The structured diff must round-trip the exotic name byte-for-byte.
    // This is the load-bearing contract: a programmatic caller echoes
    // `destructiveMigrations` back as `allowDestructive`, so any lossy
    // quoting here would break the retry handshake entirely.
    expect(body.destructiveMigrations).toEqual([exoticName]);

    // The human hint in `error` must be valid JSON when parsed — i.e.
    // a refactor to manual concatenation would break this assertion.
    // Extract the suggested `allowDestructive: [...]` literal and parse
    // it; the parsed array must equal the structured diff.
    expect(body.error).toBeTruthy();
    const match = body.error!.match(/allowDestructive:\s*(\[[^\]]*\])/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]) as Array<string>;
    expect(parsed).toEqual([exoticName]);
  });
});
