import type { SecurityPolicy } from '@void/platform/security-policy';
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
import { getDeploymentOperation, processDeploymentBatch } from '../../src/deployment-execution.ts';
import type { ApiEnv } from '../../src/env.ts';
import app from '../../src/index.ts';
import { deployments, securityScans } from '../../src/schema.ts';
import {
  enqueueSecurityScanInTx,
  finishSecurityScanEnqueue,
  SECURITY_SCAN_COPY_MAX_BYTES,
  securityScanInputPrefix,
} from '../../src/security/enqueue.ts';
import { blobWorkerModule } from '../../src/worker-upload.ts';
import {
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  mockCfApi,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import { saveSecurityPolicy, securityBindings, seedProtectedProject } from './security-fixtures.ts';

let env: TestEnv;
let onEnv: TestEnv;
let pokes: number;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  pokes = 0;
  onEnv = securityBindings(env, {
    scheduler: {
      fetch: async (input: string | Request) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.pathname === '/poke') {
          pokes++;
        }
        return Response.json({ ok: true });
      },
    },
  });
  mockCfApi();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function savePolicy(mode: SecurityPolicy['mode'], publicGate = false) {
  return saveSecurityPolicy(env, { mode, publicGate });
}

async function setup() {
  const user = await createTestUser(env.db, `owner-${crypto.randomUUID()}`);
  const project = await createTestProject(env.db, user.id);
  return { user, project };
}

/** The enqueue as `commitCutoverLive` runs it, in its own transaction. */
async function enqueue(projectId: string, deploymentId: string, bindings: TestEnv = onEnv) {
  return env.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    return enqueueSecurityScanInTx(tx, bindings, { projectId, deploymentId, trigger: 'deploy' });
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

describe('enqueue in the go-live transaction (I1)', () => {
  it('writes the row in the tx only; a failed write never stops the deploy', async () => {
    await savePolicy('all');
    const { project } = await setup();
    const deployment = await createTestDeployment(env.db, project.id, 'pending');
    // A rollback of the go-live tx leaves no row.
    await expect(
      env.db.transaction(async (tx) => {
        await enqueueSecurityScanInTx(tx, onEnv, {
          projectId: project.id,
          deploymentId: deployment.id,
          trigger: 'deploy',
        });
        throw new Error('cutover failed after the enqueue');
      }),
    ).rejects.toThrow('cutover failed after the enqueue');
    expect(await scans(project.id)).toEqual([]);

    // A refused insert leaves no row, and the go-live write after it still commits.
    vi.spyOn(console, 'error').mockImplementation(() => {});
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

    // The plain write: one waiting row, which the commit moves to queued with one poke.
    const row = await enqueue(project.id, deployment.id);
    expect(await scans(project.id)).toMatchObject([
      {
        id: row!.scanId,
        status: 'pending_input',
        trigger: 'deploy',
        policy_mode_at_enqueue: 'all',
      },
    ]);
    await finishSecurityScanEnqueue(onEnv, env.db, row);
    expect(await scan(row!.scanId)).toMatchObject({ status: 'queued' });
    expect(pokes).toBe(1);
  });

  it.each([
    ['capability off', 'off'],
    ['policy Off', 'policy'],
  ] as const)('writes no row: %s', async (_name, kind) => {
    await savePolicy(kind === 'policy' ? 'disabled' : 'all');
    const { project } = await setup();
    const deployment = await createTestDeployment(env.db, project.id);
    expect(await enqueue(project.id, deployment.id, kind === 'off' ? env : onEnv)).toBeNull();
    expect(await scans(project.id)).toEqual([]);
  });

  it('skips a protected project under public, and coalesces waiting scans', async () => {
    await savePolicy('public');
    const { project } = await setup();
    const one = await createTestDeployment(env.db, project.id);
    const two = await createTestDeployment(env.db, project.id);
    const first = await enqueue(project.id, one.id);
    const second = await enqueue(project.id, two.id);
    expect(await scan(first!.scanId)).toMatchObject({
      status: 'superseded',
      superseded_by_scan_id: second!.scanId,
    });
    await seedProtectedProject(env, project.id);
    const three = await createTestDeployment(env.db, project.id);
    const skipped = await enqueue(project.id, three.id);
    expect(await scan(skipped!.scanId)).toMatchObject({
      status: 'skipped',
      status_reason: 'protected',
    });
    expect(await scan(second!.scanId)).toMatchObject({ status: 'superseded' });
  });

  it('a copy over 50 MB fails the scan (input_missing), not the deploy', async () => {
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
    });
    expect(pokes).toBe(0);

    // A normal copy lands in R2 under the scan prefix.
    const next = await createTestDeployment(env.db, project.id);
    const copied = await enqueue(project.id, next.id);
    await finishSecurityScanEnqueue(onEnv, env.db, copied, [
      blobWorkerModule('index.js', new Blob(['export default {}'])),
    ]);
    const prefix = securityScanInputPrefix(project.id, next.id);
    expect(await scan(copied!.scanId)).toMatchObject({ status: 'queued', input_r2_key: prefix });
    expect(await (await env.STATIC_ASSETS_R2.get(`${prefix}modules/0`))!.text()).toBe(
      'export default {}',
    );
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

  async function deployQueued(base: TestEnv) {
    const { user, project } = await setup();
    await env.STATIC_ASSETS_R2.put(`assets/${project.id}/${hash}`, bytes.buffer);
    const bindings = {
      ...base,
      SECURITY_SCAN_SCHEDULER: onEnv.SECURITY_SCAN_SCHEDULER,
      DEPLOYMENTS_QUEUE: { send: vi.fn(async () => {}) },
    } as unknown as ApiEnv['Bindings'];
    const admitted = await app.fetch(
      new Request(`https://api.test/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'content-type': 'application/json',
          'x-void-deploy-idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify(spaPayload()),
      }),
      bindings,
    );
    await admitted.body?.cancel();
    const id = admitted.headers.get('x-void-deployment-id')!;
    await processDeploymentBatch(
      {
        queue: 'void-deployments',
        messages: [{ body: { deploymentId: id }, ack: vi.fn(), retry: vi.fn() }],
      } as unknown as MessageBatch<unknown>,
      bindings,
    );
    expect(await env.db.select().from(deployments)).toMatchObject([{ id, status: 'live' }]);
    return { project, id, operation: await getDeploymentOperation(env.db, id) };
  }

  it('a queued deploy goes live, queues its scan and holds its staged input', async () => {
    await savePolicy('all');
    const { project, id, operation } = await deployQueued(onEnv);
    expect(await scans(project.id)).toMatchObject([
      { deployment_id: id, status: 'queued', input_prefix: operation.input_prefix },
    ]);
    expect(pokes).toBe(1);
    expect(operation).toMatchObject({ status: 'terminal', inputs_deleted: false });
  });

  it('nothing changes with the capability off (I13)', async () => {
    await savePolicy('all');
    const { project, operation } = await deployQueued(env);
    expect(operation).toMatchObject({ inputs_deleted: true });
    expect(await scans(project.id)).toEqual([]);
    expect(pokes).toBe(0);
  });
});
