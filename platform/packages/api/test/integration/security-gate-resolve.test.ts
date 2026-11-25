/**
 * Q13 end to end (PRD §12.4, spec §5.5): how resolving the last urgent finding moves an
 * open public request. `false_positive` and `accepted_risk` unlock at once; `fixed`
 * waits for a clean scan of a newer deploy, and a rescan of the same one never unlocks.
 * Real resolve, real ingest, real re-check and Zero Trust flip; only Cloudflare is fake.
 */
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
import { deployments, projects, securityFindings, securityScans } from '../../src/schema.ts';
import { ingestSecurityScanResult } from '../../src/security/ingest.ts';
import { resolveSecurityFinding } from '../../src/security/project-findings.ts';
import { recheckPublicRequest } from '../../src/security/public-gate-flow.ts';
import { clearTables, createTestDeployment, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import { insertRunningScan, scanResult, schedulerStub } from './security-fixtures.ts';
import {
  askPublic,
  setupGate,
  succeededScan,
  urgentFinding,
  ztRow,
} from './security-gate-fixtures.ts';
import type { GateSetup } from './security-gate-fixtures.ts';

const CF = '@cf/zai-org/glm-5.3';

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

function ingestEnv(s: GateSetup) {
  return {
    ...s.platform,
    SECURITY_SCAN_SCHEDULER: schedulerStub({ forgetModelCalls: async () => 0 }),
  } as unknown as Parameters<typeof ingestSecurityScanResult>[0];
}

async function resolve(
  s: GateSetup,
  number: number,
  resolution: 'fixed' | 'false_positive' | 'accepted_risk',
) {
  const [row] = await env.db
    .select({ revision: securityFindings.revision })
    .from(securityFindings)
    .where(eq(securityFindings.number, number));
  await resolveSecurityFinding(env.db, {
    projectId: s.project.id,
    ref: `F-${number}`,
    userId: s.user.id,
    comment: `resolved as ${resolution}`,
    expectedRevision: row.revision,
    resolution,
  });
  // What the resolve route does after the write.
  return recheckPublicRequest(s.platform, env.db, s.project.id);
}

/** A clean scan of `deploymentId`, stored through the real ingest. */
async function cleanScan(s: GateSetup, scanId: string, deploymentId: string) {
  await insertRunningScan(env, scanId, s.project.id, deploymentId, {
    model_requested: CF,
    model_used: CF,
    model_calls: 3,
  });
  const stored = await ingestSecurityScanResult(
    ingestEnv(s),
    env.db,
    scanId,
    1,
    scanResult(scanId, [], { model: CF }),
  );
  expect(stored).toMatchObject({ ok: true });
  return recheckPublicRequest(s.platform, env.db, s.project.id);
}

describe('resolving the last urgent finding of a held public request (Q13)', () => {
  it('false_positive and accepted_risk unlock at once, with no new scan', async () => {
    const s = await setupGate(env);
    await succeededScan(s);
    await urgentFinding(s, 1);
    await urgentFinding(s, 2);
    expect((await askPublic(s)).publicRequest?.state).toBe('held_findings');

    // One urgent finding is still open: still held.
    expect((await resolve(s, 1, 'false_positive'))?.state).toBe('held_findings');
    expect((await ztRow(s)).desired_protected).toBe(true);

    expect((await resolve(s, 2, 'accepted_risk'))?.state).toBe('passed');
    expect((await ztRow(s)).desired_protected).toBe(false);
    // Judged on the scan that was already there.
    expect(await env.db.select({ id: securityScans.id }).from(securityScans)).toEqual([
      { id: 'ss_ok' },
    ]);
  });

  it('fixed needs a deploy: a rescan of the same deployment never unlocks, a clean scan of a new one does', async () => {
    const s = await setupGate(env);
    await succeededScan(s);
    await urgentFinding(s, 1);
    expect((await askPublic(s)).publicRequest?.state).toBe('held_findings');

    const fixed = await resolve(s, 1, 'fixed');
    expect(fixed).toMatchObject({ state: 'needs_deploy', held_reason: 'unproven_fix' });
    expect((await ztRow(s)).desired_protected).toBe(true);

    // A clean rescan of the deployment admitted before the resolve proves nothing.
    expect((await cleanScan(s, 'ss_rescan', s.deployment.id))?.state).toBe('needs_deploy');
    expect((await ztRow(s)).desired_protected).toBe(true);
    const [claim] = await env.db
      .select({ checked: securityFindings.fix_checked_scan_id })
      .from(securityFindings);
    expect(claim.checked).toBeNull();

    // A new deploy, admitted after the resolve, goes live and is scanned clean.
    const next = await createTestDeployment(env.db, s.project.id, 'live');
    const later = new Date(Date.now() + 60_000).toISOString();
    await env.db
      .update(deployments)
      .set({ created_at: later.replace('T', ' ').replace('Z', '') })
      .where(eq(deployments.id, next.id));
    const [project] = await env.db
      .select({ active: projects.active_deployment_id })
      .from(projects)
      .where(eq(projects.id, s.project.id));
    expect(project.active).toBe(next.id);
    // The cutover publishes the new version to routing.
    await env.ROUTING.put(
      s.project.slug,
      JSON.stringify({
        projectId: s.project.id,
        userId: s.user.id,
        workerName: `user-${s.project.slug}-${next.id}`,
        version: next.id,
      }),
    );

    expect((await cleanScan(s, 'ss_new', next.id))?.state).toBe('passed');
    expect((await ztRow(s)).desired_protected).toBe(false);
    const rows = await env.db
      .select({ checked: securityFindings.fix_checked_scan_id })
      .from(securityFindings)
      .orderBy(asc(securityFindings.number));
    expect(rows).toEqual([{ checked: 'ss_new' }]);
  });
});
