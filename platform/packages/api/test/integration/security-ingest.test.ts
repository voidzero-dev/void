import { asc, eq } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import {
  deployments,
  securityFindingEvents,
  securityFindings,
  securityNotifications,
  securityScans,
} from '../../src/schema.ts';
import { ingestSecurityScanResult } from '../../src/security/ingest.ts';
import { prepareSecurityScanInput } from '../../src/security/input/prepare.ts';
import { readSecurityPolicyLenient } from '../../src/security/policy.ts';
import { reapExpiredSecurityScans } from '../../src/security/queue.ts';
import { runSecurityScanQueue, securityScanQueueStore } from '../../src/security/scheduler.ts';
import type { SchedulerStorage } from '../../src/security/scheduler.ts';
import {
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import {
  findingRecord,
  insertRunningScan,
  saveSecurityPolicy,
  scanResult,
  securityBindings,
} from './security-fixtures.ts';
import { appModules, stageDeploymentInput } from './security-input-fixtures.ts';

let env: TestEnv;
let onEnv: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  onEnv = securityBindings(env, {
    scheduler: {
      fetch: async () => Response.json({ ok: true }),
      forgetModelCalls: async () => 0,
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const CF = '@cf/zai-org/glm-5.3';

async function setup() {
  const user = await createTestUser(env.db, `owner-${crypto.randomUUID()}`);
  return createTestProject(env.db, user.id);
}

/** A live deployment admitted at `admittedAt` (default: now). */
async function deploy(projectId: string, admittedAt?: string) {
  const deployment = await createTestDeployment(env.db, projectId, 'live', undefined, undefined, {
    commit: 'abc123',
  });
  await env.db
    .update(deployments)
    .set({
      manifest: JSON.stringify({ type: 'void', workerMain: 'index.js' }),
      ...(admittedAt ? { created_at: admittedAt.replace('T', ' ').replace('Z', '') } : {}),
    })
    .where(eq(deployments.id, deployment.id));
  return deployment;
}

function runningScan(
  id: string,
  projectId: string,
  deploymentId: string,
  overrides: Partial<typeof securityScans.$inferInsert> = {},
) {
  return insertRunningScan(env, id, projectId, deploymentId, {
    model_requested: CF,
    model_used: CF,
    model_calls: 3,
    ...overrides,
  });
}

async function scan(id: string) {
  const [row] = await env.db.select().from(securityScans).where(eq(securityScans.id, id));
  return row;
}

async function findingsOf(projectId: string) {
  return env.db
    .select()
    .from(securityFindings)
    .where(eq(securityFindings.project_id, projectId))
    .orderBy(asc(securityFindings.number));
}

async function eventsOf(findingId: string) {
  return (
    await env.db
      .select({ action: securityFindingEvents.action })
      .from(securityFindingEvents)
      .where(eq(securityFindingEvents.finding_id, findingId))
      .orderBy(asc(securityFindingEvents.created_at))
  ).map((event) => event.action);
}

function ingest(scanId: string, report: ReturnType<typeof scanResult>, attempt = 1) {
  return ingestSecurityScanResult(onEnv, env.db, scanId, attempt, report);
}

describe('scan result ingest', () => {
  it('drives a queued scan through claim, input and result to stored findings', async () => {
    await saveSecurityPolicy(env);
    const project = await setup();
    const deployment = await deploy(project.id);
    const prefix = await stageDeploymentInput(
      env,
      project.id,
      deployment.id,
      appModules('const q = db.prepare(`... ${id}`);'),
    );
    await env.db.insert(securityScans).values({
      id: 'scan_exit',
      project_id: project.id,
      deployment_id: deployment.id,
      status: 'queued',
      trigger: 'deploy',
      input_prefix: prefix,
      first_queued_at: new Date().toISOString(),
      queued_at: new Date().toISOString(),
    });
    const storage = new Map<string, unknown>();
    const starts: Array<string> = [];
    await runSecurityScanQueue({
      now: () => Date.now(),
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => void storage.set(key, value),
        delete: async (key: string) => storage.delete(key),
        list: async () => new Map(),
        getAlarm: async () => null,
        setAlarm: async () => {},
      } as unknown as SchedulerStorage,
      readPolicy: () => readSecurityPolicyLenient(env.db),
      store: securityScanQueueStore(env.db),
      controller: {
        start: async (request) => {
          starts.push(request.scanId);
          return { ok: true };
        },
        cancel: async () => {},
      },
    });
    expect(starts).toEqual(['scan_exit']);
    expect(await scan('scan_exit')).toMatchObject({ status: 'running' });

    expect(await prepareSecurityScanInput(onEnv, env.db, 'scan_exit', 1)).not.toBeNull();
    const report = scanResult('scan_exit', [findingRecord()]);
    expect(await ingest('scan_exit', report)).toMatchObject({
      ok: true,
      kind: 'stored',
      status: 'succeeded',
    });
    const [row] = await findingsOf(project.id);
    expect(row).toMatchObject({ number: 1, verdict: 'confirmed', severity: 'high', state: 'open' });
    expect(await scan('scan_exit')).toMatchObject({ status: 'succeeded', reserved_nano_usd: 0 });
    expect(await env.db.select().from(securityNotifications)).toMatchObject([
      { kind: 'findings', scan_ids: ['scan_exit'] },
    ]);
    // A second delivery of the same result is fenced off (I4).
    expect(await ingest('scan_exit', report)).toEqual({ ok: false });
  });

  it('refuses a write from a reaped or older attempt (I4)', async () => {
    const project = await setup();
    const deployment = await deploy(project.id);
    await runningScan('scan_late', project.id, deployment.id, {
      lease_until: new Date(Date.now() - 1000).toISOString(),
    });
    // Past the lease, even before the reaper runs.
    expect(await ingest('scan_late', scanResult('scan_late', [findingRecord()]))).toEqual({
      ok: false,
    });
    await reapExpiredSecurityScans(env.db, Date.now());
    expect(await ingest('scan_late', scanResult('scan_late', [findingRecord()]))).toEqual({
      ok: false,
    });
    expect(await scan('scan_late')).toMatchObject({ status: 'timed_out' });
    expect(await findingsOf(project.id)).toEqual([]);
    await runningScan('scan_two', project.id, deployment.id, { attempt: 2 });
    expect(await ingest('scan_two', scanResult('scan_two', [findingRecord()]), 1)).toEqual({
      ok: false,
    });
  });

  it('a scan never closes a finding or changes a human choice (I5)', async () => {
    const project = await setup();
    const deployment = await deploy(project.id, '2026-11-18T13:00:00.000Z');
    const other = { fingerprint: 'ssrf', category: 'ssrf', file: 'src/fetch.ts' };
    await runningScan('scan_1', project.id, deployment.id);
    await ingest('scan_1', scanResult('scan_1', [findingRecord(), findingRecord(other)]));
    const [sqli, ssrf] = await findingsOf(project.id);
    await env.db
      .update(securityFindings)
      .set({
        state: 'resolved',
        resolution: 'false_positive',
        resolved_at: '2026-11-18T12:00:00.000Z',
        resolved_severity: 'high',
        resolved_sink_hash: sqli.sink_content_hash,
      })
      .where(eq(securityFindings.id, sqli.id));
    await env.db
      .update(securityFindings)
      .set({ severity_override: 'low' })
      .where(eq(securityFindings.id, ssrf.id));

    // A later scan reports both, the second one as critical; and then one that finds nothing.
    await runningScan('scan_2', project.id, deployment.id);
    const raised = await ingest(
      'scan_2',
      scanResult('scan_2', [findingRecord(), findingRecord({ ...other, severity: 'critical' })]),
    );
    expect(raised).toMatchObject({ ok: true, news: [], reopened: [] });
    await runningScan('scan_3', project.id, deployment.id);
    await ingest('scan_3', scanResult('scan_3', []));

    const [fp, kept] = await findingsOf(project.id);
    expect(fp).toMatchObject({ state: 'resolved', resolution: 'false_positive' });
    expect(await eventsOf(fp.id)).toEqual(['created', 'seen_again']);
    expect(kept).toMatchObject({ state: 'open', severity: 'critical', severity_override: 'low' });
  });

  it('a stale scan cannot reopen a fixed finding; a scan of a newer deploy reopens it', async () => {
    const project = await setup();
    const first = await deploy(project.id, '2026-11-18T13:00:00.000Z');
    await runningScan('scan_1', project.id, first.id);
    await ingest('scan_1', scanResult('scan_1', [findingRecord()]));
    const [created] = await findingsOf(project.id);
    await env.db
      .update(securityFindings)
      .set({
        state: 'resolved',
        resolution: 'fixed',
        resolved_at: '2026-11-18T14:05:00.000Z',
        resolved_severity: 'high',
        resolved_sink_hash: created.sink_content_hash,
      })
      .where(eq(securityFindings.id, created.id));
    const older = await deploy(project.id, '2026-11-18T14:00:00.000Z');
    await runningScan('scan_stale', project.id, older.id);
    await ingest('scan_stale', scanResult('scan_stale', [findingRecord()]));
    expect((await findingsOf(project.id))[0]).toMatchObject({ state: 'resolved' });

    const newer = await deploy(project.id, '2026-11-18T14:10:00.000Z');
    await runningScan('scan_new', project.id, newer.id);
    await ingest('scan_new', scanResult('scan_new', [findingRecord()]));
    const [row] = await findingsOf(project.id);
    expect(row).toMatchObject({ state: 'open', resolution: null, reopen_count: 1 });
    expect(await eventsOf(row.id)).toEqual(['created', 'seen_again_stale', 'reopened']);
  });

  it('refused, timed out, failed and incomplete scans are never clean (I10)', async () => {
    const project = await setup();
    const cases = [
      [{ status: 'refused', refusal_category: 'cyber' }, 'refused', null],
      [{ status: 'failed', reason: 'bad_output', error_class: 'shape' }, 'failed', 'bad_output'],
      [{ status: 'timed_out', reason: 'wall_clock' }, 'timed_out', 'wall_clock'],
    ] as const;
    for (const [index, [overrides, status, reason]] of cases.entries()) {
      const deployment = await deploy(project.id);
      const id = `scan_fail_${index}`;
      await runningScan(id, project.id, deployment.id);
      await ingest(id, scanResult(id, [findingRecord()], overrides));
      expect(await scan(id)).toMatchObject({ status, status_reason: reason });
    }
    expect(await findingsOf(project.id)).toEqual([]);

    // An incomplete scan keeps only its validated confirmed records.
    const deployment = await deploy(project.id);
    await runningScan('scan_inc', project.id, deployment.id);
    const lead = findingRecord({
      fingerprint: 'lead',
      verdict: 'needs_validation',
      severity: null,
    });
    expect(
      await ingest(
        'scan_inc',
        scanResult('scan_inc', [findingRecord(), lead], {
          status: 'incomplete',
          reason: 'token_cap',
        }),
      ),
    ).toMatchObject({ ok: true, status: 'incomplete' });
    expect((await findingsOf(project.id)).map((row) => row.verdict)).toEqual(['confirmed']);
    expect(await scan('scan_inc')).toMatchObject({ status: 'incomplete', ledger_summary: null });
  });
});
