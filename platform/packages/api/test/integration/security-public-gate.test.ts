import {
  defaultSecurityPolicy,
  SECURITY_POLICY_SETTINGS_KEY,
} from '@void/platform/security-policy';
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
import { getPlatformCapabilities } from '../../src/capabilities.ts';
import type { ApiEnv } from '../../src/env.ts';
import { setPlatformSetting } from '../../src/platform-settings.ts';
import {
  deploymentOperations,
  projectZeroTrust,
  securityFindings,
  securityProjectEvents,
  securityPublicRequests,
  securityScanBypasses,
  securityScans,
} from '../../src/schema.ts';
import { securityScanHoldsInput, securityScanInputPrefix } from '../../src/security/enqueue.ts';
import { SecurityApiError } from '../../src/security/errors.ts';
import {
  bypassPublicRequest,
  reconcilePendingPublicRequests,
  recheckPublicRequest,
} from '../../src/security/public-gate-flow.ts';
import { projectSecuritySettings } from '../../src/security/schema.ts';
import {
  configurePlatformZeroTrust,
  disablePlatformZeroTrust,
} from '../../src/zero-trust/installation.ts';
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

function bindings(): ApiEnv['Bindings'] {
  return {
    ...env,
    SITE_DOMAIN: 'apps.example.com',
    PLATFORM_INSTALLATION_ID: 'installation-test',
    PLATFORM_CAPABILITIES: JSON.stringify({
      ...getPlatformCapabilities(env),
      securityAudits: true,
    }),
    SECURITY_SCAN_SCHEDULER: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    },
  } as unknown as ApiEnv['Bindings'];
}

const input = {
  apiToken: 'access-management-token',
  identityProviderIds: ['idp-1'],
  policyIds: ['policy-1'],
  protectNewProjects: true,
  existingProjects: 'public' as const,
};

function accessApi() {
  const applications = new Map<string, Record<string, unknown>>();
  let nextApplication = 1;
  const fetcher = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
    const url = new URL(request.toString());
    const path = url.pathname.split('/access/')[1] ?? '';
    if (path === 'organizations') {
      return Response.json({
        success: true,
        result: { auth_domain: 'company.cloudflareaccess.com' },
      });
    }
    if (path === 'identity_providers/idp-1') {
      return Response.json({ success: true, result: { id: 'idp-1', name: 'Company SSO' } });
    }
    if (path === 'policies/policy-1') {
      return Response.json({
        success: true,
        result: {
          id: 'policy-1',
          decision: 'allow',
          include: [{ email_domain: { domain: 'example.com' } }],
        },
      });
    }
    if (path === 'apps' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const id = `app-${nextApplication++}`;
      const application = { ...body, id, aud: `aud-${id}` };
      applications.set(id, application);
      return Response.json({ success: true, result: application });
    }
    if (path === 'apps') {
      return Response.json({ success: true, result: [...applications.values()] });
    }
    const match = path.match(/^apps\/([^/]+)$/);
    if (match && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const previous = applications.get(match[1]);
      const application = { ...body, id: match[1], aud: previous?.aud ?? `aud-${match[1]}` };
      applications.set(match[1], application);
      return Response.json({ success: true, result: application });
    }
    if (match && init?.method === 'DELETE') {
      applications.delete(match[1]);
      return Response.json({ success: true, result: { id: match[1] } });
    }
    if (match) {
      const application = applications.get(match[1]);
      return application
        ? Response.json({ success: true, result: application })
        : Response.json({ success: false, errors: [{ message: 'not found' }] }, { status: 404 });
    }
    throw new Error(`unexpected Cloudflare request: ${url}`);
  });
  return { applications, fetcher };
}

async function savePolicy(publicGate: boolean) {
  await setPlatformSetting(env.db, SECURITY_POLICY_SETTINGS_KEY, {
    ...defaultSecurityPolicy(),
    mode: 'all',
    publicGate,
    revision: 1,
  });
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** A protected project with a live deployment, the gate on. */
async function setup() {
  vi.stubGlobal('fetch', accessApi().fetcher);
  const platform = bindings();
  await configurePlatformZeroTrust(platform, env.db, input);
  await savePolicy(true);
  const user = await createTestUser(env.db, `gate-${crypto.randomUUID()}`);
  const project = await createTestProject(env.db, user.id);
  const deployment = await createTestDeployment(env.db, project.id, 'live');
  await env.ROUTING.put(
    project.slug,
    JSON.stringify({
      projectId: project.id,
      userId: user.id,
      workerName: `user-${project.slug}-${deployment.id}`,
      version: deployment.id,
    }),
  );
  await setProjectZeroTrustProtection(platform, env.db, project.id, true);
  return { platform, user, project, deployment };
}

function ask(s: Setup, protectedAfter = false) {
  return setProjectZeroTrustProtection(s.platform, env.db, s.project.id, protectedAfter, {
    actorUserId: s.user.id,
  });
}

async function ztRow(projectId: string) {
  const [row] = await env.db
    .select()
    .from(projectZeroTrust)
    .where(eq(projectZeroTrust.project_id, projectId));
  return row;
}

async function succeededScan(s: Setup, id = 'ss_ok') {
  await env.db.insert(securityScans).values({
    id,
    project_id: s.project.id,
    deployment_id: s.deployment.id,
    status: 'succeeded',
    trigger: 'deploy',
    finished_at: new Date().toISOString(),
  } as typeof securityScans.$inferInsert);
}

async function urgentFinding(s: Setup, number = 1) {
  await env.db.insert(securityFindings).values({
    id: `sf_${number}`,
    project_id: s.project.id,
    number,
    fingerprint_key: `fp-${number}`,
    verdict: 'confirmed',
    severity: 'high',
    title: 'SQL injection',
    category: 'injection',
    first_scan_id: 'ss_ok',
    last_seen_scan_id: 'ss_ok',
  } as typeof securityFindings.$inferInsert);
}

const owner = (s: Setup) => ({ kind: 'user' as const, userId: s.user.id, role: 'owner' });

async function endedScan(s: Setup, id: string, values: Partial<typeof securityScans.$inferInsert>) {
  await env.db.insert(securityScans).values({
    id,
    project_id: s.project.id,
    deployment_id: s.deployment.id,
    trigger: 'gate',
    finished_at: new Date().toISOString(),
    status: 'failed',
    ...values,
  } as typeof securityScans.$inferInsert);
}

async function gateScans(s: Setup) {
  return env.db.select().from(securityScans).where(eq(securityScans.project_id, s.project.id));
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
    expect((await ztRow(s.project.id)).desired_protected).toBe(true);

    await succeededScan(s);
    const rechecked = await recheckPublicRequest(s.platform, env.db, s.project.id);
    expect(rechecked?.state).toBe('passed');
    // A pass holds nothing: the reason of the last hold goes with it.
    expect(rechecked?.held_reason).toBeNull();
    expect((await ztRow(s.project.id)).desired_protected).toBe(false);
  });

  it('keeps the project protected while an urgent finding is open', async () => {
    const s = await setup();
    await succeededScan(s);
    await urgentFinding(s);
    const asked = await ask(s);
    expect(asked.publicRequest?.state).toBe('held_findings');
    expect((await ztRow(s.project.id)).desired_protected).toBe(true);
  });

  it('refuses a bypass while an urgent finding is open and records nothing', async () => {
    const s = await setup();
    await succeededScan(s);
    await urgentFinding(s);
    await ask(s);
    await expect(
      bypassPublicRequest(s.platform, env.db, {
        projectId: s.project.id,
        reason: 'launch day',
        actor: owner(s),
      }),
    ).rejects.toBeInstanceOf(SecurityApiError);
    expect(await env.db.select().from(securityScanBypasses)).toHaveLength(0);
    expect((await ztRow(s.project.id)).desired_protected).toBe(true);
  });

  it('bypasses the scan with a reason and writes the bypass row', async () => {
    const s = await setup();
    await ask(s);
    await expect(
      bypassPublicRequest(s.platform, env.db, {
        projectId: s.project.id,
        reason: '  ',
        actor: owner(s),
      }),
    ).rejects.toBeInstanceOf(SecurityApiError);
    const result = await bypassPublicRequest(s.platform, env.db, {
      projectId: s.project.id,
      reason: 'launch day',
      actor: owner(s),
    });
    expect(result.publicRequest?.state).toBe('bypassed');
    expect((await ztRow(s.project.id)).desired_protected).toBe(false);
    const [bypass] = await env.db.select().from(securityScanBypasses);
    expect(bypass).toMatchObject({ project_id: s.project.id, reason: 'launch day' });
  });

  it('the project rule never still scans before it goes public (M34, D46)', async () => {
    const s = await setup();
    await env.db
      .insert(projectSecuritySettings)
      .values({ project_id: s.project.id, policy_override: 'never' });
    // The deploy was skipped by the rule; its modules were kept for a later gate scan.
    const key = `security-scans/${s.project.id}/${s.deployment.id}/`;
    await env.STATIC_ASSETS_R2.put(`${key}modules.json`, '{"version":1,"modules":[]}');
    await env.db.insert(securityScans).values({
      id: 'ss_rule',
      project_id: s.project.id,
      deployment_id: s.deployment.id,
      status: 'skipped',
      status_reason: 'project_policy',
      trigger: 'deploy',
      input_r2_key: key,
      finished_at: new Date().toISOString(),
    } as typeof securityScans.$inferInsert);
    const asked = await ask(s);
    expect(asked.held).toBe(true);
    expect(asked.publicRequest?.state).toBe('waiting_scan');
    const gate = await env.db.select().from(securityScans).where(eq(securityScans.trigger, 'gate'));
    expect(gate).toMatchObject([
      { deployment_id: s.deployment.id, status: 'queued', input_r2_key: key },
    ]);
    expect((await ztRow(s.project.id)).desired_protected).toBe(true);
  });

  it('asking again on held_no_result queues one new gate scan of the kept input (edge #79)', async () => {
    const s = await setup();
    const key = securityScanInputPrefix(s.project.id, s.deployment.id);
    await env.STATIC_ASSETS_R2.put(`${key}modules.json`, '{"version":1,"modules":[]}');
    await endedScan(s, 'ss_bad', { failure_cause: 'project', status_reason: 'bad_output' });
    const first = await ask(s);
    expect(first.publicRequest).toMatchObject({ state: 'held_no_result', gate_scan_id: 'ss_bad' });
    expect(await gateScans(s)).toHaveLength(1);

    const again = await ask(s);
    expect(again.publicRequest).toMatchObject({
      state: 'waiting_scan',
      held_reason: 'scan_queued',
    });
    const queued = (await gateScans(s)).filter((scan) => scan.status === 'queued');
    expect(queued).toMatchObject([{ trigger: 'gate', input_r2_key: key }]);
    expect(again.publicRequest?.gate_scan_id).toBe(queued[0].id);
    expect((await ztRow(s.project.id)).desired_protected).toBe(true);
  });

  it('asks for a deploy when a scan with no result left no code to scan again (#54)', async () => {
    const s = await setup();
    await endedScan(s, 'ss_budget', {
      status: 'skipped',
      status_reason: 'budget',
      trigger: 'deploy',
    });
    for (let round = 0; round < 2; round++) {
      const asked = await ask(s);
      expect(asked.publicRequest).toMatchObject({ state: 'needs_deploy', held_reason: 'no_input' });
    }
    expect(await gateScans(s)).toHaveLength(1);
  });

  it('lists an unproven fixed claim as a blocker of a request with no result', async () => {
    const s = await setup();
    await endedScan(s, 'ss_bad', { failure_cause: 'project', status_reason: 'bad_output' });
    await env.STATIC_ASSETS_R2.put(
      `${securityScanInputPrefix(s.project.id, s.deployment.id)}modules.json`,
      '{"version":1,"modules":[]}',
    );
    await urgentFinding(s, 6);
    await env.db
      .update(securityFindings)
      .set({
        state: 'resolved',
        resolution: 'fixed',
        resolved_severity: 'high',
        resolved_at: new Date().toISOString(),
      })
      .where(eq(securityFindings.number, 6));
    const asked = await ask(s);
    expect(asked.publicRequest).toMatchObject({
      state: 'held_no_result',
      blockers: 1,
      blocker_ids: ['F-6'],
    });
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
    const queued = (await gateScans(s)).filter((scan) => scan.status === 'queued');
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

  it('protecting again cancels the open request and keeps the project protected', async () => {
    const s = await setup();
    await ask(s);
    const again = await ask(s, true);
    expect(again.publicRequest?.state).toBe('canceled');
    expect((await ztRow(s.project.id)).desired_protected).toBe(true);
    const open = await env.db
      .select()
      .from(securityPublicRequests)
      .where(eq(securityPublicRequests.state, 'waiting_scan'));
    expect(open).toHaveLength(0);
  });

  it('refuses to disable installation Zero Trust while the gate is on', async () => {
    const s = await setup();
    await expect(disablePlatformZeroTrust(s.platform, env.db)).rejects.toMatchObject({
      code: 'security public gate on',
    });
  });

  it('the hourly backstop judges every open request and rotates the order', async () => {
    const s = await setup();
    await ask(s);
    const [before] = await env.db.select().from(securityPublicRequests);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(await reconcilePendingPublicRequests(s.platform, env.db)).toBe(1);
    const [held] = await env.db.select().from(securityPublicRequests);
    expect(held.state).toBe(before.state);
    expect(new Date(held.updated_at).getTime()).toBeGreaterThan(
      new Date(before.updated_at).getTime(),
    );
    // A hold needs no routing budget; a pass with no budget left stays queued for the next run.
    await succeededScan(s);
    expect(await reconcilePendingPublicRequests(s.platform, env.db, 20, { remaining: 0 })).toBe(1);
    expect((await ztRow(s.project.id)).effective_protected).toBe(true);
  });

  it('writes the canceled event when the gate was turned off under an open request', async () => {
    const s = await setup();
    await ask(s);
    await savePolicy(false);
    const rechecked = await recheckPublicRequest(s.platform, env.db, s.project.id);
    expect(rechecked?.state).toBe('canceled');
    const events = await env.db.select().from(securityProjectEvents);
    expect(events.filter((event) => event.action === 'public_canceled')).toHaveLength(1);
    expect((await ztRow(s.project.id)).desired_protected).toBe(true);
  });
});
