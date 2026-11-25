import { eq } from 'drizzle-orm';
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
import { securityFindings, securityScanBypasses, securityScans } from '../../src/schema.ts';
import { securityScanInputPrefix } from '../../src/security/enqueue.ts';
import { SecurityApiError } from '../../src/security/errors.ts';
import { ingestSecurityScanResult } from '../../src/security/ingest.ts';
import { resolveSecurityFinding } from '../../src/security/project-findings.ts';
import { bypassPublicRequest, recheckPublicRequest } from '../../src/security/public-gate-flow.ts';
import { clearTables, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import {
  insertRunningScan,
  insertSecurityScan,
  scanResult,
  schedulerStub,
} from './security-fixtures.ts';
import {
  askPublic as ask,
  gateOwner,
  setupGate,
  succeededScan,
  urgentFinding,
  ztRow,
} from './security-gate-fixtures.ts';
import type { GateSetup as Setup } from './security-gate-fixtures.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const setup = () => setupGate(env);

function endedScan(s: Setup, id: string, values: Partial<typeof securityScans.$inferInsert>) {
  return insertSecurityScan(env, s.project.id, s.deployment.id, {
    id,
    trigger: 'gate',
    status: 'failed',
    ...values,
  });
}

/** Keeps the deployment's input for a later gate scan, as a skipped deploy scan does. */
async function keepInput(s: Setup) {
  const key = securityScanInputPrefix(s.project.id, s.deployment.id);
  await env.STATIC_ASSETS_R2.put(`${key}modules.json`, '{"version":1,"modules":[]}');
  return key;
}

async function gateScans(s: Setup) {
  return env.db.select().from(securityScans).where(eq(securityScans.project_id, s.project.id));
}

describe('public gate (I6)', () => {
  it('holds a request with no scan, then goes public once a scan passes', async () => {
    const s = await setup();
    const asked = await ask(s);
    expect(asked.held).toBe(true);
    expect(asked.publicRequest?.state).toBe('needs_deploy');
    expect((await ztRow(s)).desired_protected).toBe(true);

    await succeededScan(s);
    const rechecked = await recheckPublicRequest(s.platform, env.db, s.project.id);
    expect(rechecked?.state).toBe('passed');
    expect((await ztRow(s)).desired_protected).toBe(false);
  });

  it('keeps the project protected while an urgent finding is open', async () => {
    const s = await setup();
    await succeededScan(s);
    await urgentFinding(s);
    expect((await ask(s)).publicRequest?.state).toBe('held_findings');
    expect((await ztRow(s)).desired_protected).toBe(true);
  });

  it('bypasses with a reason and records it; protecting again cancels a request', async () => {
    const s = await setup();
    await ask(s);
    expect((await ask(s, true)).publicRequest?.state).toBe('canceled');
    expect((await ztRow(s)).desired_protected).toBe(true);

    await ask(s);
    const bypass = (reason: string) =>
      bypassPublicRequest(s.platform, env.db, {
        projectId: s.project.id,
        reason,
        actor: gateOwner(s),
      });
    await expect(bypass('  ')).rejects.toBeInstanceOf(SecurityApiError);
    expect((await bypass('launch day')).publicRequest?.state).toBe('bypassed');
    expect((await ztRow(s)).desired_protected).toBe(false);
    expect(await env.db.select().from(securityScanBypasses)).toMatchObject([
      { project_id: s.project.id, reason: 'launch day' },
    ]);
  });

  it('a failed scan is no pass: asking again queues one new gate scan (I10)', async () => {
    const s = await setup();
    const key = await keepInput(s);
    await endedScan(s, 'ss_bad', { failure_cause: 'project', status_reason: 'bad_output' });
    expect((await ask(s)).publicRequest).toMatchObject({
      state: 'held_no_result',
      gate_scan_id: 'ss_bad',
    });
    expect((await ask(s)).publicRequest).toMatchObject({ state: 'waiting_scan' });
    expect((await gateScans(s)).filter((scan) => scan.status === 'queued')).toMatchObject([
      { trigger: 'gate', input_r2_key: key },
    ]);
    expect((await ztRow(s)).desired_protected).toBe(true);
  });

  it('a scan that left files unread is no pass (I10)', async () => {
    const s = await setup();
    await keepInput(s);
    await endedScan(s, 'ss_unread', {
      status: 'succeeded',
      coverage: 'partial',
      coverage_notes: ['dropped-binary 1 files'],
    });
    expect((await ask(s)).publicRequest).toMatchObject({
      state: 'held_no_result',
      held_reason: 'unread_files',
    });
    expect((await ztRow(s)).desired_protected).toBe(true);
  });

  it('a finding marked fixed holds until a newer deploy passes; a rescan of the same one never unlocks', async () => {
    const s = await setup();
    await succeededScan(s);
    await urgentFinding(s, 1);
    expect((await ask(s)).publicRequest?.state).toBe('held_findings');

    const [row] = await env.db
      .select({ revision: securityFindings.revision })
      .from(securityFindings);
    await resolveSecurityFinding(env.db, {
      projectId: s.project.id,
      ref: 'F-1',
      userId: s.user.id,
      comment: 'patched',
      expectedRevision: row.revision,
      resolution: 'fixed',
    });
    expect(await recheckPublicRequest(s.platform, env.db, s.project.id)).toMatchObject({
      state: 'needs_deploy',
      held_reason: 'unproven_fix',
    });

    // A clean rescan of the deployment admitted before the resolve proves nothing.
    const cf = '@cf/zai-org/glm-5.3';
    await insertRunningScan(env, 'ss_rescan', s.project.id, s.deployment.id, {
      model_requested: cf,
      model_used: cf,
      model_calls: 3,
    });
    const ingestEnv = {
      ...s.platform,
      SECURITY_SCAN_SCHEDULER: schedulerStub({ forgetModelCalls: async () => 0 }),
    } as unknown as Parameters<typeof ingestSecurityScanResult>[0];
    const stored = await ingestSecurityScanResult(
      ingestEnv,
      env.db,
      'ss_rescan',
      1,
      scanResult('ss_rescan', [], { model: cf }),
    );
    expect(stored).toMatchObject({ ok: true });
    expect((await recheckPublicRequest(s.platform, env.db, s.project.id))?.state).toBe(
      'needs_deploy',
    );
    expect((await ztRow(s)).desired_protected).toBe(true);
  });
});
