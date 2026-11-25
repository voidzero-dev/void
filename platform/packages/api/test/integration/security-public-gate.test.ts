import { PLATFORM_DISABLED_KEY, PLATFORM_DISABLED_VALUE } from '@void/platform';
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
import {
  deploymentOperations,
  deployments,
  projects,
  securityProjectEvents,
  securityPublicRequests,
  securityScanBypasses,
  securityScans,
} from '../../src/schema.ts';
import {
  enqueueSecurityScanForLiveDeployment,
  securityScanHoldsInput,
  securityScanInputPrefix,
} from '../../src/security/enqueue.ts';
import { SecurityApiError } from '../../src/security/errors.ts';
import {
  bypassPublicRequest,
  reconcilePendingPublicRequests,
  recheckPublicRequest,
  recheckPublicRequestForScan,
} from '../../src/security/public-gate-flow.ts';
import { projectSecuritySettings } from '../../src/security/schema.ts';
import { setProjectZeroTrustProtection } from '../../src/zero-trust/project.ts';
import {
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import { insertSecurityScan } from './security-fixtures.ts';
import {
  askPublic as ask,
  gateOwner,
  gatePlatform,
  saveGatePolicy,
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
async function keepInput(s: Setup, key = securityScanInputPrefix(s.project.id, s.deployment.id)) {
  await env.STATIC_ASSETS_R2.put(`${key}modules.json`, '{"version":1,"modules":[]}');
  return key;
}

async function gateScans(s: Setup) {
  return env.db.select().from(securityScans).where(eq(securityScans.project_id, s.project.id));
}

async function queuedScans(s: Setup) {
  return (await gateScans(s)).filter((scan) => scan.status === 'queued');
}

function bypass(s: Setup, reason: string) {
  return bypassPublicRequest(s.platform, env.db, {
    projectId: s.project.id,
    reason,
    actor: gateOwner(s),
  });
}

/** The deploy's staged modules, as a terminal deployment operation keeps them. */
async function stagedInput(s: Setup) {
  const prefix = `deployment-inputs/${s.project.id}/${s.deployment.id}/`;
  await env.STATIC_ASSETS_R2.put(`${prefix}worker.js`, 'export default {};');
  await env.db.insert(deploymentOperations).values({
    id: s.deployment.id,
    project_id: s.project.id,
    actor_id: s.user.id,
    idempotency_key: s.deployment.id,
    input_digest: 'digest',
    input_prefix: prefix,
    payload: {
      body: {},
      modules: [{ name: 'worker.js', key: `${prefix}worker.js`, digest: 'd', type: 'esm' }],
    } as never,
    status: 'terminal',
  });
  return prefix;
}

describe('public gate', () => {
  it('holds a request with no scan or kept input, then goes public once a scan passes', async () => {
    const s = await setup();
    const asked = await ask(s);
    expect(asked.held).toBe(true);
    expect(asked.publicRequest?.state).toBe('needs_deploy');
    expect((await ztRow(s)).desired_protected).toBe(true);

    await succeededScan(s);
    const rechecked = await recheckPublicRequest(s.platform, env.db, s.project.id);
    expect(rechecked?.state).toBe('passed');
    // A pass holds nothing: the reason of the last hold goes with it.
    expect(rechecked?.held_reason).toBeNull();
    expect((await ztRow(s)).desired_protected).toBe(false);
  });

  it('keeps the project protected while an urgent finding is open', async () => {
    const s = await setup();
    await succeededScan(s);
    await urgentFinding(s);
    const asked = await ask(s);
    expect(asked.publicRequest?.state).toBe('held_findings');
    expect((await ztRow(s)).desired_protected).toBe(true);
  });

  it('bypasses the scan with a reason and writes the bypass row', async () => {
    const s = await setup();
    await ask(s);
    await expect(bypass(s, '  ')).rejects.toBeInstanceOf(SecurityApiError);
    const result = await bypass(s, 'launch day');
    expect(result.publicRequest?.state).toBe('bypassed');
    expect((await ztRow(s)).desired_protected).toBe(false);
    const [row] = await env.db.select().from(securityScanBypasses);
    expect(row).toMatchObject({ project_id: s.project.id, reason: 'launch day' });
  });

  it('the project rule never still scans before it goes public (M34, D46)', async () => {
    const s = await setup();
    await env.db
      .insert(projectSecuritySettings)
      .values({ project_id: s.project.id, policy_override: 'never' });
    // The deploy was skipped by the rule; its modules were kept for a later gate scan.
    const key = await keepInput(s, `security-scans/${s.project.id}/${s.deployment.id}/`);
    await endedScan(s, 'ss_rule', {
      status: 'skipped',
      status_reason: 'project_policy',
      trigger: 'deploy',
      input_r2_key: key,
    });
    const asked = await ask(s);
    expect(asked.held).toBe(true);
    expect(asked.publicRequest?.state).toBe('waiting_scan');
    const gate = await env.db.select().from(securityScans).where(eq(securityScans.trigger, 'gate'));
    expect(gate).toMatchObject([
      { deployment_id: s.deployment.id, status: 'queued', input_r2_key: key },
    ]);
    expect((await ztRow(s)).desired_protected).toBe(true);
  });

  it('asking again on held_no_result queues one new gate scan of the kept input (edge #79)', async () => {
    const s = await setup();
    const key = await keepInput(s);
    await endedScan(s, 'ss_bad', { failure_cause: 'project', status_reason: 'bad_output' });
    const first = await ask(s);
    expect(first.publicRequest).toMatchObject({ state: 'held_no_result', gate_scan_id: 'ss_bad' });
    expect(await gateScans(s)).toHaveLength(1);

    const again = await ask(s);
    expect(again.publicRequest).toMatchObject({
      state: 'waiting_scan',
      held_reason: 'scan_queued',
    });
    const queued = await queuedScans(s);
    expect(queued).toMatchObject([{ trigger: 'gate', input_r2_key: key }]);
    expect(again.publicRequest?.gate_scan_id).toBe(queued[0].id);
    expect((await ztRow(s)).desired_protected).toBe(true);
  });

  it('holds a scan that left project files unread, and asking again queues no scan', async () => {
    const s = await setup();
    await keepInput(s);
    await endedScan(s, 'ss_unread', {
      status: 'succeeded',
      coverage: 'partial',
      coverage_notes: ['dropped-binary 1 files'],
    });
    for (let round = 0; round < 2; round++) {
      const asked = await ask(s);
      expect(asked.publicRequest).toMatchObject({
        state: 'held_no_result',
        held_reason: 'unread_files',
        gate_scan_id: 'ss_unread',
      });
    }
    // The same code gives the same unread files: only a deploy or a bypass moves it on.
    expect(await gateScans(s)).toHaveLength(1);
    expect((await ztRow(s)).desired_protected).toBe(true);
  });

  it('keeps the staged input of a gate scan that ended before it copied it (§7.2)', async () => {
    const s = await setup();
    const prefix = await stagedInput(s);
    const asked = await ask(s);
    const requestId = asked.publicRequest!.id;
    // The gate scan was skipped at start (budget used up): it never copied the input.
    await endedScan(s, 'ss_skip', {
      status: 'skipped',
      status_reason: 'budget',
      public_request_id: requestId,
      input_prefix: prefix,
    });
    expect(await securityScanHoldsInput(env.db, prefix)).toBe(true);

    const again = await ask(s);
    expect(again.publicRequest?.state).toBe('waiting_scan');
    const queued = await queuedScans(s);
    expect(queued).toMatchObject([{ trigger: 'gate', input_prefix: prefix, input_r2_key: null }]);

    // Canceled too, before it copied: still held while the request is open.
    await env.db
      .update(securityScans)
      .set({ status: 'canceled', status_reason: 'operator_canceled' })
      .where(eq(securityScans.id, queued[0].id));
    expect(await securityScanHoldsInput(env.db, prefix)).toBe(true);
    // Protect closes the request: nothing holds the input any more.
    await ask(s, true);
    expect(await securityScanHoldsInput(env.db, prefix)).toBe(false);
  });

  it('keeps the input of a deploy scan the request took over, so asking again works', async () => {
    const s = await setup();
    const prefix = await stagedInput(s);
    // The deploy scan still waits when the owner asks: the request takes it over.
    await endedScan(s, 'ss_deploy', {
      trigger: 'deploy',
      status: 'queued',
      finished_at: null,
      input_prefix: prefix,
    });
    const asked = await ask(s);
    expect(asked.publicRequest?.state).toBe('waiting_scan');
    const [row] = await env.db
      .select({ gate: securityPublicRequests.gate_scan_id })
      .from(securityPublicRequests)
      .where(eq(securityPublicRequests.id, asked.publicRequest!.id));
    expect(row.gate).toBe('ss_deploy');

    // It ends before it copied the input (budget used up): the input stays held.
    await env.db
      .update(securityScans)
      .set({ status: 'skipped', status_reason: 'budget', finished_at: new Date().toISOString() })
      .where(eq(securityScans.id, 'ss_deploy'));
    expect(await securityScanHoldsInput(env.db, prefix)).toBe(true);
    const held = await recheckPublicRequest(s.platform, env.db, s.project.id);
    expect(held).toMatchObject({ state: 'held_no_result', held_reason: 'skipped_budget' });

    const again = await ask(s);
    expect(again.publicRequest?.state).toBe('waiting_scan');
    const queued = await queuedScans(s);
    expect(queued).toMatchObject([{ trigger: 'gate', input_prefix: prefix }]);
  });

  it('a scan that ends while the platform is disabled changes no Access', async () => {
    const s = await setup();
    const asked = await ask(s);
    expect(asked.publicRequest?.state).toBe('needs_deploy');
    await succeededScan(s);
    await env.ROUTING.put(PLATFORM_DISABLED_KEY, PLATFORM_DISABLED_VALUE);
    try {
      await recheckPublicRequestForScan(s.platform, env.db, 'ss_ok');
      const [row] = await env.db
        .select({ state: securityPublicRequests.state })
        .from(securityPublicRequests)
        .where(eq(securityPublicRequests.id, asked.publicRequest!.id));
      expect(row.state).toBe('needs_deploy');
      expect((await ztRow(s)).desired_protected).toBe(true);
    } finally {
      await env.ROUTING.delete(PLATFORM_DISABLED_KEY);
    }
    // Enabled again: the same re-check lets it go public.
    await recheckPublicRequestForScan(s.platform, env.db, 'ss_ok');
    expect((await ztRow(s)).desired_protected).toBe(false);
  });

  it('holds a first deploy that is still in cutover, then follows it live (§5.5)', async () => {
    const { platform } = await gatePlatform(env);
    const user = await createTestUser(env.db, `gate-${crypto.randomUUID()}`);
    const project = await createTestProject(env.db, user.id);
    await setProjectZeroTrustProtection(platform, env.db, project.id, true);
    const actor = { actorUserId: user.id };
    // Nothing deployed and nothing moving: going public needs no scan.
    expect(
      (await setProjectZeroTrustProtection(platform, env.db, project.id, false, actor)).held,
    ).toBe(false);

    // The first deploy wrote its routes but is not the live one yet.
    const deployment = await createTestDeployment(env.db, project.id, 'pending');
    await env.db
      .update(deployments)
      .set({ status: 'cutover' })
      .where(eq(deployments.id, deployment.id));
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({
        projectId: project.id,
        userId: user.id,
        workerName: `user-${project.slug}-${deployment.id}`,
        version: deployment.id,
      }),
    );
    // Protecting again republishes the cutover deployment's route behind Access.
    await setProjectZeroTrustProtection(platform, env.db, project.id, true);
    const asked = await setProjectZeroTrustProtection(platform, env.db, project.id, false, actor);
    expect(asked.held).toBe(true);
    expect(asked.publicRequest).toMatchObject({
      state: 'waiting_scan',
      held_reason: 'deployment_moving',
    });
    expect((await ztRow({ env, project })).desired_protected).toBe(true);
    const route = JSON.parse((await env.ROUTING.get(project.slug)) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(route.zeroTrust).toBeDefined();

    // The commit makes it live: the open request follows it and its scan is the gate scan.
    await env.db
      .update(deployments)
      .set({ status: 'live' })
      .where(eq(deployments.id, deployment.id));
    await env.db
      .update(projects)
      .set({ active_deployment_id: deployment.id })
      .where(eq(projects.id, project.id));
    await enqueueSecurityScanForLiveDeployment(env.db, platform, {
      projectId: project.id,
      deploymentId: deployment.id,
    });
    const [request] = await env.db.select().from(securityPublicRequests);
    expect(request.target_deployment_id).toBe(deployment.id);
    const scans = await env.db
      .select()
      .from(securityScans)
      .where(eq(securityScans.project_id, project.id));
    expect(scans.map((scan) => [scan.deployment_id, scan.trigger])).toEqual([
      [deployment.id, 'gate'],
    ]);
  });

  it('lets a request go public when the first deploy it waited for fails', async () => {
    const { platform } = await gatePlatform(env);
    const user = await createTestUser(env.db, `gate-${crypto.randomUUID()}`);
    const project = await createTestProject(env.db, user.id);
    await setProjectZeroTrustProtection(platform, env.db, project.id, true);
    const deployment = await createTestDeployment(env.db, project.id, 'pending');
    await env.db
      .update(deployments)
      .set({ status: 'cutover' })
      .where(eq(deployments.id, deployment.id));
    const actor = { actorUserId: user.id };
    const asked = await setProjectZeroTrustProtection(platform, env.db, project.id, false, actor);
    expect(asked.publicRequest).toMatchObject({ state: 'waiting_scan', target_deployment_id: '' });

    // The cutover fails and compensates: nothing is live and nothing is moving.
    await env.db
      .update(deployments)
      .set({ status: 'failed' })
      .where(eq(deployments.id, deployment.id));
    const rechecked = await recheckPublicRequest(platform, env.db, project.id);
    expect(rechecked).toMatchObject({ state: 'passed', gate_scan_id: null });
    expect((await ztRow({ env, project })).desired_protected).toBe(false);
  });

  it('protecting again cancels the open request and keeps the project protected', async () => {
    const s = await setup();
    await ask(s);
    const again = await ask(s, true);
    expect(again.publicRequest?.state).toBe('canceled');
    expect((await ztRow(s)).desired_protected).toBe(true);
    const open = await env.db
      .select()
      .from(securityPublicRequests)
      .where(eq(securityPublicRequests.state, 'waiting_scan'));
    expect(open).toHaveLength(0);
  });

  it('the hourly backstop judges every open request and rotates the order', async () => {
    const s = await setup();
    await ask(s);
    await env.db
      .update(securityPublicRequests)
      .set({ updated_at: new Date(Date.now() - 60_000).toISOString() });
    const [before] = await env.db.select().from(securityPublicRequests);
    expect(await reconcilePendingPublicRequests(s.platform, env.db)).toBe(1);
    const [held] = await env.db.select().from(securityPublicRequests);
    expect(held.state).toBe(before.state);
    expect(new Date(held.updated_at).getTime()).toBeGreaterThan(
      new Date(before.updated_at).getTime(),
    );
    // A hold needs no routing budget; a pass with no budget left stays queued for the next run.
    await succeededScan(s);
    expect(await reconcilePendingPublicRequests(s.platform, env.db, 20, { remaining: 0 })).toBe(1);
    expect((await ztRow(s)).effective_protected).toBe(true);
  });

  it('writes the canceled event when the gate was turned off under an open request', async () => {
    const s = await setup();
    await ask(s);
    await saveGatePolicy(env, false);
    const rechecked = await recheckPublicRequest(s.platform, env.db, s.project.id);
    expect(rechecked?.state).toBe('canceled');
    const events = await env.db.select().from(securityProjectEvents);
    expect(events.filter((event) => event.action === 'public_canceled')).toHaveLength(1);
    expect((await ztRow(s)).desired_protected).toBe(true);
  });
});
