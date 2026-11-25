import {
  defaultSecurityPolicy,
  SECURITY_POLICY_SETTINGS_KEY,
} from '@void/platform/security-policy';
import { eq, sql } from 'drizzle-orm';
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
import { deleteProjectAssets } from '../../src/assets.ts';
import { getPlatformCapabilities } from '../../src/capabilities.ts';
import { getDeploymentOperation, processDeploymentBatch } from '../../src/deployment-execution.ts';
import type { ApiEnv } from '../../src/env.ts';
import app from '../../src/index.ts';
import { setPlatformSetting } from '../../src/platform-settings.ts';
import {
  deploymentOperations,
  deployments,
  platformSettings,
  projects,
  projectZeroTrust,
  securityPublicRequests,
  securityScans,
  users,
} from '../../src/schema.ts';
import {
  enqueueSecurityScanForLiveDeployment,
  enqueueSecurityScanInTx,
  finishSecurityScanEnqueue,
  SECURITY_SCAN_COPY_MAX_BYTES,
  securityScanInputPrefix,
} from '../../src/security/enqueue.ts';
import { changeSecurityPolicy } from '../../src/security/policy.ts';
import type { SecurityProjectPolicyOverride } from '../../src/security/project-policy.ts';
import { claimSecurityScan } from '../../src/security/queue.ts';
import { projectSecuritySettings } from '../../src/security/schema.ts';
import { blobWorkerModule } from '../../src/worker-upload.ts';
import {
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  mockCfApi,
  setupEnv,
  teardownEnv,
  withTestTransaction,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import { setTestDb } from './setup.ts';

let env: TestEnv;
let onEnv: TestEnv;
let pokes: number;

function schedulerNamespace() {
  return {
    idFromName: (name: string) => ({ toString: () => name }),
    get: () => ({
      fetch: async (input: string | Request) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.pathname === '/poke') {
          pokes++;
        }
        return Response.json({ ok: true });
      },
    }),
  } as unknown as TestEnv['SECURITY_SCAN_SCHEDULER'];
}

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  pokes = 0;
  onEnv = {
    ...env,
    PLATFORM_CAPABILITIES: JSON.stringify({
      ...getPlatformCapabilities(env),
      securityAudits: true,
    }),
    SECURITY_SCAN_SCHEDULER: schedulerNamespace(),
  };
  mockCfApi();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function savePolicy(mode: 'disabled' | 'public' | 'all', publicGate = false) {
  await setPlatformSetting(env.db, SECURITY_POLICY_SETTINGS_KEY, {
    ...defaultSecurityPolicy(),
    mode,
    publicGate,
    revision: 1,
  });
}

/** Installation Zero Trust on (not public-only), and the project settled protected. */
async function protect(projectId: string, status: 'ready' | 'reconciling' = 'ready') {
  await env.db
    .insert(platformSettings)
    .values({
      key: 'zeroTrust.configuration',
      value: {
        version: 1,
        revision: 1,
        enabled: true,
        protectNewProjects: true,
        accountId: env.CF_ACCOUNT_ID,
        teamDomain: 'https://company.cloudflareaccess.com',
        identityProviderIds: ['idp-1'],
        policyIds: ['policy-1'],
        credential: { ciphertext: 'unused', iv: 'unused', keyVersion: 'v1' },
        wildcardApplicationName: 'void-test-projects',
        wildcardApplication: {
          id: 'access-wildcard',
          name: 'void-test-projects',
          audience: 'access-audience',
          destinations: ['*.void.app'],
        },
        operation: null,
        lastError: null,
        updatedAt: new Date().toISOString(),
      },
    })
    .onConflictDoNothing();
  await env.db.insert(projectZeroTrust).values({
    project_id: projectId,
    desired_protected: true,
    effective_protected: true,
    status,
  });
}

async function setup(slug?: string) {
  const user = await createTestUser(env.db, `owner-${slug ?? 'x'}-${crypto.randomUUID()}`);
  const project = await createTestProject(env.db, user.id, slug);
  return { user, project };
}

/** The enqueue as `commitCutoverLive` runs it, in its own transaction. */
async function enqueue(
  projectId: string,
  deploymentId: string,
  bindings: TestEnv = onEnv,
  trigger: 'deploy' | 'recovery' = 'deploy',
) {
  return env.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    return enqueueSecurityScanInTx(tx, bindings, { projectId, deploymentId, trigger });
  });
}

async function scans(projectId: string) {
  return env.db
    .select()
    .from(securityScans)
    .where(eq(securityScans.project_id, projectId))
    .orderBy(securityScans.created_at, securityScans.id);
}

async function scan(id: string) {
  const [row] = await env.db.select().from(securityScans).where(eq(securityScans.id, id));
  return row;
}

describe('enqueue in the go-live transaction', () => {
  it('writes the row in the same transaction; a rollback leaves none', async () => {
    await savePolicy('all');
    const { project } = await setup();
    const deployment = await createTestDeployment(env.db, project.id);
    await expect(
      env.db.transaction(async (tx) => {
        const row = await enqueueSecurityScanInTx(tx, onEnv, {
          projectId: project.id,
          deploymentId: deployment.id,
          trigger: 'deploy',
        });
        expect(row).toMatchObject({ status: 'pending_input', trigger: 'deploy' });
        throw new Error('cutover failed after the enqueue');
      }),
    ).rejects.toThrow('cutover failed after the enqueue');
    expect(await scans(project.id)).toEqual([]);

    const row = await enqueue(project.id, deployment.id);
    expect(await scans(project.id)).toMatchObject([
      {
        id: row!.scanId,
        deployment_id: deployment.id,
        status: 'pending_input',
        trigger: 'deploy',
        policy_mode_at_enqueue: 'all',
        public_at_enqueue: true,
        input_prefix: null,
      },
    ]);
    expect((await scan(row!.scanId)).first_queued_at).not.toBeNull();
  });

  it('a failed write inside the savepoint leaves no row and the deploy commits (D45)', async () => {
    await savePolicy('all');
    const { project } = await setup();
    const deployment = await createTestDeployment(env.db, project.id, 'pending');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await env.db.execute(sql`
      CREATE OR REPLACE FUNCTION test_refuse_security_scan() RETURNS trigger AS $refuse$
      BEGIN RAISE EXCEPTION 'scan insert refused'; END $refuse$ LANGUAGE plpgsql`);
    await env.db.execute(sql`
      CREATE TRIGGER test_refuse_security_scan BEFORE INSERT ON security_scans
      FOR EACH ROW EXECUTE FUNCTION test_refuse_security_scan()`);
    try {
      const row = await env.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM projects WHERE id = ${project.id} FOR UPDATE`);
        const enqueued = await enqueueSecurityScanInTx(tx, onEnv, {
          projectId: project.id,
          deploymentId: deployment.id,
          trigger: 'deploy',
        });
        // The transaction is not aborted: the go-live write after it still runs.
        await tx
          .update(deployments)
          .set({ status: 'live' })
          .where(eq(deployments.id, deployment.id));
        return enqueued;
      });
      expect(row).toBeNull();
    } finally {
      await env.db.execute(sql`DROP TRIGGER test_refuse_security_scan ON security_scans`);
      await env.db.execute(sql`DROP FUNCTION test_refuse_security_scan()`);
    }
    expect(
      await env.db.select().from(deployments).where(eq(deployments.id, deployment.id)),
    ).toMatchObject([{ status: 'live' }]);
    expect(await scans(project.id)).toEqual([]);
    expect(logged).toHaveBeenCalledWith(
      '[security-scan] enqueue failed; the deploy goes on without a scan row',
      expect.objectContaining({ deploymentId: deployment.id }),
    );
  });

  it.each([
    ['capability off', 'off'],
    ['policy Off', 'policy'],
    ['preview project', 'preview'],
    ['owner suspended', 'suspended'],
    ['project being deleted', 'deleting'],
  ] as const)('writes no row: %s', async (_name, kind) => {
    await savePolicy(kind === 'policy' ? 'disabled' : 'all');
    const { user, project } = await setup(
      kind === 'preview' ? `preview-${crypto.randomUUID().slice(0, 8)}` : undefined,
    );
    const deployment = await createTestDeployment(env.db, project.id);
    if (kind === 'suspended') {
      await env.db.update(users).set({ suspended_reason: 'admin' }).where(eq(users.id, user.id));
    }
    if (kind === 'deleting') {
      await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
    }
    expect(await enqueue(project.id, deployment.id, kind === 'off' ? env : onEnv)).toBeNull();
    expect(await scans(project.id)).toEqual([]);
  });

  it('a protected project under public gets a skipped:protected row', async () => {
    await savePolicy('public');
    const { project } = await setup();
    await protect(project.id);
    const deployment = await createTestDeployment(env.db, project.id);
    const row = await enqueue(project.id, deployment.id);
    expect(row).toMatchObject({ status: 'skipped' });
    expect(await scans(project.id)).toMatchObject([
      {
        status: 'skipped',
        status_reason: 'protected',
        trigger: 'deploy',
        public_at_enqueue: false,
        first_queued_at: null,
      },
    ]);
    expect((await scan(row!.scanId)).finished_at).not.toBeNull();
    // Compensation gets it back until its modules are copied.
    expect(await enqueue(project.id, deployment.id)).toEqual(row);
    await finishSecurityScanEnqueue(onEnv, env.db, row, [
      blobWorkerModule('index.js', new Blob(['export default {}'])),
    ]);
    expect(await enqueue(project.id, deployment.id)).toBeNull();
  });

  it('a skipped:protected row supersedes the waiting scan of the old deployment', async () => {
    await savePolicy('public');
    const { project } = await setup();
    const old = await createTestDeployment(env.db, project.id);
    const waiting = await enqueue(project.id, old.id);
    await protect(project.id);
    const deployment = await createTestDeployment(env.db, project.id);
    const skipped = await enqueue(project.id, deployment.id);
    expect(skipped).toMatchObject({ status: 'skipped' });
    expect(await scan(waiting!.scanId)).toMatchObject({
      status: 'superseded',
      superseded_by_scan_id: skipped!.scanId,
    });
    expect((await scan(skipped!.scanId)).first_queued_at).toBeNull();
  });

  it('scans a protected project under all, and a reconciling one under public (edge #16)', async () => {
    await savePolicy('all');
    const first = await setup();
    await protect(first.project.id);
    const one = await createTestDeployment(env.db, first.project.id);
    expect(await enqueue(first.project.id, one.id)).toMatchObject({ status: 'pending_input' });
    expect(await scans(first.project.id)).toMatchObject([{ public_at_enqueue: false }]);

    await savePolicy('public');
    const second = await setup();
    await protect(second.project.id, 'reconciling');
    const two = await createTestDeployment(env.db, second.project.id);
    expect(await enqueue(second.project.id, two.id)).toMatchObject({ status: 'pending_input' });
    expect(await scans(second.project.id)).toMatchObject([{ public_at_enqueue: true }]);
  });

  it('bad Zero Trust data reads as public', async () => {
    await savePolicy('public');
    const { project } = await setup();
    await protect(project.id);
    await env.db
      .update(platformSettings)
      .set({ value: { version: 'broken' } })
      .where(eq(platformSettings.key, 'zeroTrust.configuration'));
    const deployment = await createTestDeployment(env.db, project.id);
    expect(await enqueue(project.id, deployment.id)).toMatchObject({ status: 'pending_input' });
  });

  it('an open public request makes the deploy its gate scan, also under public', async () => {
    await savePolicy('public', true);
    const { project } = await setup();
    await protect(project.id);
    const deployment = await createTestDeployment(env.db, project.id);
    await env.db.insert(securityPublicRequests).values({
      id: 'spr_open',
      project_id: project.id,
      state: 'needs_deploy',
      requested_via: 'project',
      target_deployment_id: deployment.id,
    });
    expect(await enqueue(project.id, deployment.id)).toMatchObject({
      status: 'pending_input',
      trigger: 'gate',
    });
    expect(await scans(project.id)).toMatchObject([
      { status: 'pending_input', trigger: 'gate', public_request_id: 'spr_open' },
    ]);
  });

  it('coalesces waiting scans and keeps the oldest first_queued_at (edges #2, #37)', async () => {
    await savePolicy('all');
    const { project } = await setup();
    const one = await createTestDeployment(env.db, project.id);
    const two = await createTestDeployment(env.db, project.id);
    const three = await createTestDeployment(env.db, project.id);
    const running = await createTestDeployment(env.db, project.id);
    await env.db.insert(securityScans).values({
      id: 'scan_running',
      project_id: project.id,
      deployment_id: running.id,
      status: 'running',
      trigger: 'deploy',
      attempt: 1,
      lease_until: sql`now() + interval '1 hour'`,
    });
    const first = await enqueue(project.id, one.id);
    await env.db
      .update(securityScans)
      .set({ first_queued_at: '2026-11-18T00:00:00.000Z', status: 'queued' })
      .where(eq(securityScans.id, first!.scanId));
    const second = await enqueue(project.id, two.id);
    const third = await enqueue(project.id, three.id);

    expect(await scan(first!.scanId)).toMatchObject({
      status: 'superseded',
      superseded_by_scan_id: second!.scanId,
    });
    expect(await scan(second!.scanId)).toMatchObject({
      status: 'superseded',
      superseded_by_scan_id: third!.scanId,
    });
    const newest = await scan(third!.scanId);
    expect(newest.status).toBe('pending_input');
    expect(Date.parse(newest.first_queued_at!)).toBe(Date.parse('2026-11-18T00:00:00.000Z'));
    expect((await scan('scan_running')).status).toBe('running');
  });

  it('a second call for the same deployment returns the waiting row, never a new one', async () => {
    await savePolicy('all');
    const { project } = await setup();
    const deployment = await createTestDeployment(env.db, project.id);
    const first = await enqueue(project.id, deployment.id);
    expect(await enqueue(project.id, deployment.id)).toEqual(first);
    await finishSecurityScanEnqueue(onEnv, env.db, first);
    expect(await enqueue(project.id, deployment.id)).toBeNull();
    expect(await scans(project.id)).toHaveLength(1);
  });

  it('compensation enqueues only for the live active deployment', async () => {
    await savePolicy('all');
    const { project } = await setup();
    const stale = await createTestDeployment(env.db, project.id);
    const live = await createTestDeployment(env.db, project.id);
    await env.db
      .update(projects)
      .set({ active_deployment_id: live.id })
      .where(eq(projects.id, project.id));
    expect(
      await enqueueSecurityScanForLiveDeployment(env.db, onEnv, {
        projectId: project.id,
        deploymentId: stale.id,
      }),
    ).toBeNull();
    expect(
      await enqueueSecurityScanForLiveDeployment(env.db, onEnv, {
        projectId: project.id,
        deploymentId: live.id,
      }),
    ).toMatchObject({ status: 'pending_input', trigger: 'deploy', deploymentId: live.id });
  });
});

describe('project scan rule (M34)', () => {
  const CF = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';

  async function setRule(projectId: string, override: SecurityProjectPolicyOverride) {
    await env.db
      .insert(projectSecuritySettings)
      .values({ project_id: projectId, policy_override: override })
      .onConflictDoUpdate({
        target: projectSecuritySettings.project_id,
        set: { policy_override: override },
      });
  }

  async function claim(scanId: string) {
    return claimSecurityScan(env.db, {
      scanId,
      attempt: 0,
      model: { requested: CF, used: CF, engine: 'void_loop' },
      limits: { timeoutMinutes: 20 },
      now: Date.now(),
    });
  }

  async function queued(
    projectId: string,
    deploymentId: string,
    trigger: 'deploy' | 'gate' | 'fallback',
    publicRequestId: string | null = null,
  ) {
    const id = `scan_${crypto.randomUUID().slice(0, 8)}`;
    await env.db.insert(securityScans).values({
      id,
      project_id: projectId,
      deployment_id: deploymentId,
      status: 'queued',
      trigger,
      public_request_id: publicRequestId,
      policy_mode_at_enqueue: 'public',
      public_at_enqueue: false,
      first_queued_at: sql`now()`,
      queued_at: sql`now()`,
    });
    return id;
  }

  it('never: a deploy gets skipped:project_policy, replaces the waiting scan and keeps its modules', async () => {
    await savePolicy('all');
    const { project } = await setup();
    const old = await createTestDeployment(env.db, project.id);
    const waiting = await enqueue(project.id, old.id);
    await setRule(project.id, 'never');
    const deployment = await createTestDeployment(env.db, project.id);
    const row = await enqueue(project.id, deployment.id);
    expect(row).toMatchObject({ status: 'skipped', trigger: 'deploy' });
    expect(await scan(row!.scanId)).toMatchObject({
      status: 'skipped',
      status_reason: 'project_policy',
      first_queued_at: null,
    });
    expect(await scan(waiting!.scanId)).toMatchObject({
      status: 'superseded',
      superseded_by_scan_id: row!.scanId,
    });
    // Like skipped:protected: compensation gets it back until its modules are copied, so a
    // later gate scan can still read the code.
    expect(await enqueue(project.id, deployment.id)).toEqual(row);
    await finishSecurityScanEnqueue(onEnv, env.db, row, [
      blobWorkerModule('index.js', new Blob(['export default {}'])),
    ]);
    expect((await scan(row!.scanId)).input_r2_key).toBe(
      securityScanInputPrefix(project.id, deployment.id),
    );
    expect(await enqueue(project.id, deployment.id)).toBeNull();
    expect(pokes).toBe(0);
  });

  it('never still writes the gate scan of an open public request (D46)', async () => {
    await savePolicy('public', true);
    const { project } = await setup();
    await protect(project.id);
    await setRule(project.id, 'never');
    const deployment = await createTestDeployment(env.db, project.id);
    await env.db.insert(securityPublicRequests).values({
      id: 'spr_never',
      project_id: project.id,
      state: 'needs_deploy',
      requested_via: 'project',
      target_deployment_id: deployment.id,
    });
    expect(await enqueue(project.id, deployment.id)).toMatchObject({
      status: 'pending_input',
      trigger: 'gate',
    });
    expect(await scans(project.id)).toMatchObject([
      { status: 'pending_input', trigger: 'gate', public_request_id: 'spr_never' },
    ]);
  });

  it('always scans a protected project under public; Off still scans nothing', async () => {
    await savePolicy('public');
    const { project } = await setup();
    await protect(project.id);
    await setRule(project.id, 'always');
    const deployment = await createTestDeployment(env.db, project.id);
    expect(await enqueue(project.id, deployment.id)).toMatchObject({ status: 'pending_input' });
    expect(await scans(project.id)).toMatchObject([
      { status: 'pending_input', status_reason: null, public_at_enqueue: false },
    ]);

    await savePolicy('disabled');
    const next = await createTestDeployment(env.db, project.id);
    expect(await enqueue(project.id, next.id)).toBeNull();

    // inherit is the plain policy again.
    await savePolicy('public');
    await setRule(project.id, 'inherit');
    const third = await createTestDeployment(env.db, project.id);
    expect(await enqueue(project.id, third.id)).toMatchObject({ status: 'skipped' });
    expect((await scans(project.id)).at(-1)).toMatchObject({ status_reason: 'protected' });
  });

  it('the claim reads the rule again: never skips a waiting scan, a gate scan still runs', async () => {
    await savePolicy('all', true);
    const { project } = await setup();
    const deployment = await createTestDeployment(env.db, project.id);
    const deploy = await queued(project.id, deployment.id, 'deploy');
    await setRule(project.id, 'never');
    await expect(claim(deploy)).resolves.toEqual({
      kind: 'ended',
      status: 'skipped',
      reason: 'project_policy',
    });
    expect(await scan(deploy)).toMatchObject({
      status: 'skipped',
      status_reason: 'project_policy',
    });

    const gate = await queued(project.id, deployment.id, 'gate');
    await expect(claim(gate)).resolves.toMatchObject({ kind: 'claimed', attempt: 1 });
  });

  it('the claim under never runs a fallback of a public request, and skips any other', async () => {
    await savePolicy('all', true);
    const { project } = await setup();
    const deployment = await createTestDeployment(env.db, project.id);
    await setRule(project.id, 'never');
    const plain = await queued(project.id, deployment.id, 'fallback');
    await expect(claim(plain)).resolves.toEqual({
      kind: 'ended',
      status: 'skipped',
      reason: 'project_policy',
    });
    expect(await scan(plain)).toMatchObject({
      status: 'skipped',
      status_reason: 'project_policy',
    });
    const forRequest = await queued(project.id, deployment.id, 'fallback', 'spr_open');
    await expect(claim(forRequest)).resolves.toMatchObject({ kind: 'claimed' });
  });

  it('the claim of a protected project under public runs with always', async () => {
    await savePolicy('public');
    const { project } = await setup();
    await protect(project.id);
    const deployment = await createTestDeployment(env.db, project.id);
    const skipped = await queued(project.id, deployment.id, 'deploy');
    await expect(claim(skipped)).resolves.toMatchObject({ reason: 'protected' });
    await setRule(project.id, 'always');
    const runs = await queued(project.id, deployment.id, 'deploy');
    await expect(claim(runs)).resolves.toMatchObject({ kind: 'claimed' });
  });
});

describe('after the commit', () => {
  it('moves the row to queued and pokes the scheduler', async () => {
    await savePolicy('all');
    const { project } = await setup();
    const deployment = await createTestDeployment(env.db, project.id);
    const row = await enqueue(project.id, deployment.id);
    await finishSecurityScanEnqueue(onEnv, env.db, row);
    const queued = await scan(row!.scanId);
    expect(queued.status).toBe('queued');
    expect(queued.queued_at).not.toBeNull();
    expect(pokes).toBe(1);
  });

  it('policy Off between the commit and the input copy leaves the row canceled', async () => {
    await savePolicy('all');
    const admin = await createTestUser(env.db, 'security-admin');
    const { project } = await setup();
    const deployment = await createTestDeployment(env.db, project.id);
    const row = await enqueue(project.id, deployment.id);
    const off = await changeSecurityPolicy(
      env.db,
      { mode: 'disabled', expectedRevision: 1 },
      { userId: admin.id, preview: false },
    );
    expect(off).toMatchObject({ ok: true, canceledScans: 1 });
    await finishSecurityScanEnqueue(onEnv, env.db, row, [
      blobWorkerModule('index.js', new Blob(['export default {}'])),
    ]);
    expect(await scan(row!.scanId)).toMatchObject({
      status: 'canceled',
      status_reason: 'policy_off',
      input_r2_key: null,
    });
    expect(pokes).toBe(0);
    // No row reads the copy, so it is gone.
    const listed = await env.STATIC_ASSETS_R2.list({
      prefix: securityScanInputPrefix(project.id, deployment.id),
    });
    expect(listed.objects).toEqual([]);
  });

  it('a row superseded before its copy lands keeps no copy', async () => {
    await savePolicy('all');
    const { project } = await setup();
    const deployment = await createTestDeployment(env.db, project.id);
    const newer = await createTestDeployment(env.db, project.id);
    const row = await enqueue(project.id, deployment.id);
    await enqueue(project.id, newer.id);
    await finishSecurityScanEnqueue(onEnv, env.db, row, [
      blobWorkerModule('index.js', new Blob(['export default {}'])),
    ]);
    expect(await scan(row!.scanId)).toMatchObject({ status: 'superseded', input_r2_key: null });
    const listed = await env.STATIC_ASSETS_R2.list({
      prefix: securityScanInputPrefix(project.id, deployment.id),
    });
    expect(listed.objects).toEqual([]);
  });

  it('copies inline modules when nothing holds them', async () => {
    await savePolicy('all');
    const { project } = await setup();
    const deployment = await createTestDeployment(env.db, project.id);
    const row = await enqueue(project.id, deployment.id);
    await finishSecurityScanEnqueue(onEnv, env.db, row, [
      blobWorkerModule('index.js', new Blob(['export default {}'], { type: 'application/js' })),
      blobWorkerModule('index.js.map', new Blob(['{"version":3}'])),
    ]);
    const prefix = securityScanInputPrefix(project.id, deployment.id);
    expect(await scan(row!.scanId)).toMatchObject({ status: 'queued', input_r2_key: prefix });
    expect(await (await env.STATIC_ASSETS_R2.get(`${prefix}modules/0`))!.text()).toBe(
      'export default {}',
    );
    expect(await (await env.STATIC_ASSETS_R2.get(`${prefix}modules.json`))!.json()).toEqual({
      version: 1,
      modules: [
        { name: 'index.js', type: 'application/js', size: 17, key: `${prefix}modules/0` },
        { name: 'index.js.map', type: '', size: 13, key: `${prefix}modules/1` },
      ],
    });
  });

  it('a copy over 50 MB marks the scan failed (input_missing), not the deploy', async () => {
    await savePolicy('all');
    const { project } = await setup();
    const deployment = await createTestDeployment(env.db, project.id);
    const row = await enqueue(project.id, deployment.id);
    const huge = {
      name: 'index.js',
      type: 'application/javascript+module',
      size: SECURITY_SCAN_COPY_MAX_BYTES + 1,
      open: async () => {
        throw new Error('must not be read');
      },
    };
    await finishSecurityScanEnqueue(onEnv, env.db, row, [huge]);
    expect(await scan(row!.scanId)).toMatchObject({
      status: 'failed',
      status_reason: 'input_missing',
      failure_cause: 'project',
    });
    expect(pokes).toBe(0);
  });

  it('a failed module read marks the scan failed (input_missing)', async () => {
    await savePolicy('all');
    const { project } = await setup();
    const deployment = await createTestDeployment(env.db, project.id);
    const row = await enqueue(project.id, deployment.id);
    await finishSecurityScanEnqueue(onEnv, env.db, row, [
      {
        name: 'index.js',
        type: 'application/javascript+module',
        size: 3,
        open: async () => {
          throw new Error('storage unavailable');
        },
      },
    ]);
    expect(await scan(row!.scanId)).toMatchObject({ status: 'failed' });
    const listed = await env.STATIC_ASSETS_R2.list({
      prefix: securityScanInputPrefix(project.id, deployment.id),
    });
    expect(listed.objects).toEqual([]);
  });

  it('a skipped:protected row keeps a copy of its modules for a later catch-up', async () => {
    await savePolicy('public');
    const { project } = await setup();
    await protect(project.id);
    const deployment = await createTestDeployment(env.db, project.id);
    const row = await enqueue(project.id, deployment.id);
    await finishSecurityScanEnqueue(onEnv, env.db, row, [
      blobWorkerModule('index.js', new Blob(['export default {}'])),
    ]);
    expect(await scan(row!.scanId)).toMatchObject({
      status: 'skipped',
      input_r2_key: securityScanInputPrefix(project.id, deployment.id),
    });
    expect(pokes).toBe(0);
  });

  it('a project delete removes its security-scans objects', async () => {
    const { project } = await setup();
    await env.STATIC_ASSETS_R2.put(`security-scans/${project.id}/dpl_x/modules/0`, 'code');
    await env.STATIC_ASSETS_R2.put(`security-scans/other/dpl_x/modules/0`, 'code');
    await deleteProjectAssets(env.STATIC_ASSETS_R2, project.id);
    expect(
      (await env.STATIC_ASSETS_R2.list({ prefix: `security-scans/${project.id}/` })).objects,
    ).toEqual([]);
    expect(
      (await env.STATIC_ASSETS_R2.list({ prefix: 'security-scans/other/' })).objects,
    ).toHaveLength(1);
  });
});

describe('real deploys', () => {
  const hash = 'a'.repeat(32);
  const bytes = new TextEncoder().encode('<h1>scan me</h1>');

  function spaPayload() {
    return {
      manifest: {
        version: 3,
        assetManifestVersion: 2,
        bindings: {},
        type: 'spa',
        assetConfig: { not_found_handling: 'single-page-application' },
      },
      assetManifest: {
        '/index.html': { blake3: hash, md5: 'b'.repeat(32), size: bytes.byteLength },
      },
      source: 'manual',
      commit: null,
      preflight: null,
    };
  }

  async function post(
    bindings: ApiEnv['Bindings'],
    projectId: string,
    jwt: string,
    key: string,
    body: unknown = spaPayload(),
  ) {
    const response = await app.fetch(
      new Request(`https://api.test/projects/${projectId}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'content-type': 'application/json',
          'x-void-deploy-idempotency-key': key,
        },
        body: JSON.stringify(body),
      }),
      bindings,
    );
    return response;
  }

  async function runQueued(bindings: ApiEnv['Bindings'], id: string) {
    const ack = vi.fn();
    const retry = vi.fn();
    await processDeploymentBatch(
      {
        queue: 'void-deployments',
        messages: [{ body: { deploymentId: id }, ack, retry }],
      } as unknown as MessageBatch<unknown>,
      bindings,
    );
    return { ack, retry };
  }

  it('a queued deploy holds its staged input until the scan leaves the queue', async () => {
    await savePolicy('all');
    const { user, project } = await setup();
    await env.STATIC_ASSETS_R2.put(`assets/${project.id}/${hash}`, bytes.buffer);
    const queuedEnv = {
      ...onEnv,
      DEPLOYMENTS_QUEUE: { send: vi.fn(async () => {}) },
    } as unknown as ApiEnv['Bindings'];
    const key = crypto.randomUUID();
    const admitted = await post(queuedEnv, project.id, user.jwt, key);
    await admitted.body?.cancel();
    const id = admitted.headers.get('x-void-deployment-id')!;
    expect(await runQueued(queuedEnv, id)).toMatchObject({});
    expect(await env.db.select().from(deployments)).toMatchObject([{ id, status: 'live' }]);
    const operation = await getDeploymentOperation(env.db, id);
    const [row] = await scans(project.id);
    expect(row).toMatchObject({
      deployment_id: id,
      status: 'queued',
      trigger: 'deploy',
      input_prefix: operation.input_prefix,
    });
    expect(pokes).toBe(1);
    // Held: the operation ended but kept its input.
    expect(operation).toMatchObject({ status: 'terminal', inputs_deleted: false });
    expect(
      (await env.STATIC_ASSETS_R2.list({ prefix: operation.input_prefix })).objects.length,
    ).toBeGreaterThan(0);

    // An idempotent replay of the same deploy makes no new deployment and no new row.
    const replay = await post(queuedEnv, project.id, user.jwt, key);
    await replay.body?.cancel();
    expect(replay.headers.get('x-void-deployment-id')).toBe(id);
    expect(await scans(project.id)).toHaveLength(1);
  });

  it('a recovered cutover promoted inside the next admission gets a recovery scan (edge #41)', async () => {
    await savePolicy('all');
    const { user, project } = await setup();
    const protectedDeployment = await createTestDeployment(env.db, project.id, 'pending');
    await env.db
      .update(deployments)
      .set({
        status: 'cutover',
        manifest: JSON.stringify({ version: 3, type: 'static', bindings: {} }),
        asset_hashes: JSON.stringify({}),
      })
      .where(eq(deployments.id, protectedDeployment.id));
    const marker = JSON.stringify({ projectId: project.id, ownerId: 'gone', buildId: null });
    await env.ROUTING.put(`cutover-intent:${protectedDeployment.id}`, marker);
    await env.ROUTING.put(`cutover-ready:${protectedDeployment.id}`, marker);

    const response = await post(
      onEnv as unknown as ApiEnv['Bindings'],
      project.id,
      user.jwt,
      crypto.randomUUID(),
    );
    await response.text();
    expect(
      await env.db.select().from(deployments).where(eq(deployments.id, protectedDeployment.id)),
    ).toMatchObject([{ status: 'live' }]);
    const recovered = (await scans(project.id)).find(
      (row) => row.deployment_id === protectedDeployment.id,
    );
    expect(recovered).toMatchObject({ trigger: 'recovery' });
    expect(['queued', 'superseded']).toContain(recovered!.status);
    expect(pokes).toBeGreaterThan(0);
  });

  const workerSource = "export default { fetch() { return new Response('ok'); } }";

  /** An inline Worker deploy: the modules travel in the request, nothing stages them. */
  function workerPayload() {
    return {
      manifest: { version: 3, assetManifestVersion: 2, bindings: {} },
      assetManifest: {},
      workerFiles: { 'index.js': btoa(workerSource) },
      source: null,
      commit: null,
      preflight: null,
    };
  }

  /**
   * Fails one `db.transaction` once the project's deployment is live: `afterCommit`
   * throws right after the go-live commit (a lost COMMIT acknowledgement);
   * `nextStep` throws on the next transaction (a later publish step).
   */
  function failAfterGoLive(projectId: string, mode: 'afterCommit' | 'nextStep') {
    const realDb = env.db;
    const realTransaction = realDb.transaction.bind(realDb);
    let live = false;
    let injected = false;
    const liveNow = async () => {
      const [row] = await realDb
        .select({ status: deployments.status })
        .from(projects)
        .innerJoin(deployments, eq(deployments.id, projects.active_deployment_id))
        .where(eq(projects.id, projectId));
      return row?.status === 'live';
    };
    const wrapped = withTestTransaction(realDb, async (fn, config) => {
      if (mode === 'nextStep' && live && !injected) {
        injected = true;
        throw new Error('retention cleanup failed');
      }
      const result = await realTransaction(fn, config);
      if (!live && (await liveNow())) {
        live = true;
        if (mode === 'afterCommit') {
          injected = true;
          throw new Error('database connection lost after COMMIT');
        }
      }
      return result;
    });
    setTestDb(wrapped);
    return { injected: () => injected, restore: () => setTestDb(realDb) };
  }

  async function expectCopiedWorkerScan(projectId: string, deploymentId: string) {
    const prefix = securityScanInputPrefix(projectId, deploymentId);
    expect(await scans(projectId)).toMatchObject([
      { deployment_id: deploymentId, status: 'queued', input_prefix: null, input_r2_key: prefix },
    ]);
    expect(await (await env.STATIC_ASSETS_R2.get(`${prefix}modules/0`))!.text()).toBe(workerSource);
    expect(await (await env.STATIC_ASSETS_R2.get(`${prefix}modules.json`))!.json()).toMatchObject({
      version: 1,
      modules: [{ name: 'index.js', key: `${prefix}modules/0` }],
    });
    expect(pokes).toBe(1);
  }

  it('an inline Worker deploy copies its modules after done', async () => {
    await savePolicy('all');
    const { user, project } = await setup();
    const response = await post(
      onEnv as unknown as ApiEnv['Bindings'],
      project.id,
      user.jwt,
      crypto.randomUUID(),
      workerPayload(),
    );
    expect(await response.text()).toContain('"event":"done"');
    const [deployment] = await env.db.select().from(deployments);
    expect(deployment).toMatchObject({ status: 'live' });
    await expectCopiedWorkerScan(project.id, deployment.id);
  });

  it.each([
    ['the go-live commit acknowledgement is lost', 'afterCommit'],
    ['a step after the go-live commit fails', 'nextStep'],
  ] as const)('an inline Worker scan still gets its modules when %s', async (_name, mode) => {
    await savePolicy('all');
    const { user, project } = await setup();
    const fault = failAfterGoLive(project.id, mode);
    try {
      const response = await post(
        onEnv as unknown as ApiEnv['Bindings'],
        project.id,
        user.jwt,
        crypto.randomUUID(),
        workerPayload(),
      );
      expect(await response.text()).toContain('"event":"done"');
      expect(fault.injected()).toBe(true);
    } finally {
      fault.restore();
    }
    const [deployment] = await env.db.select().from(deployments);
    expect(deployment).toMatchObject({ status: 'live' });
    await expectCopiedWorkerScan(project.id, deployment.id);
  });

  it('nothing changes with the capability off', async () => {
    await savePolicy('all');
    const { user, project } = await setup();
    await env.STATIC_ASSETS_R2.put(`assets/${project.id}/${hash}`, bytes.buffer);
    const queuedEnv = {
      ...env,
      SECURITY_SCAN_SCHEDULER: schedulerNamespace(),
      DEPLOYMENTS_QUEUE: { send: vi.fn(async () => {}) },
    } as unknown as ApiEnv['Bindings'];
    const admitted = await post(queuedEnv, project.id, user.jwt, crypto.randomUUID());
    await admitted.body?.cancel();
    const id = admitted.headers.get('x-void-deployment-id')!;
    await runQueued(queuedEnv, id);
    expect(await getDeploymentOperation(env.db, id)).toMatchObject({ inputs_deleted: true });
    expect(await scans(project.id)).toEqual([]);
    expect(pokes).toBe(0);
    expect(await env.db.select().from(deploymentOperations)).toHaveLength(1);
  });
});
