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
import { deleteProjectCascade } from '../../src/db.ts';
import { emailSharedRecipients } from '../../src/email/connection-schema.ts';
import {
  ensureSharedEmailConnection,
  resolveEmailDomain,
  runEmailOperation,
} from '../../src/email/connection-service.ts';
import {
  getSharedEmailRecipientReadiness,
  reconcileSharedEmailRecipient,
  reconcileSharedEmailRecipients,
  removeSharedEmailRecipients,
} from '../../src/email/shared-recipient-service.ts';
import type { ApiEnv } from '../../src/env.ts';
import app from '../../src/index.ts';
import { deployments, operatorEvents, projects, resources } from '../../src/schema.ts';
import { callsByTag, stubCustomerCf } from './email-domain-cf-stub.ts';
import {
  clearTables,
  createTestProject,
  createTestUser,
  createOperatorToken,
  createTestDeployment,
  setupEnv,
  skipOrphanSweepDelay,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

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
  vi.unstubAllGlobals();
});

function bindings(): ApiEnv['Bindings'] {
  return {
    ...env,
    HYPERDRIVE: {
      ...env.HYPERDRIVE,
      host: 'localhost',
      ip: '127.0.0.1',
      port: 5432,
      user: 'test',
      password: 'inert-test-password',
      database: 'test',
      connect() {
        throw new Error('Tests use the injected database');
      },
    },
    CRON_FIRES_QUEUE: {
      send: vi.fn(),
      sendBatch: vi.fn(),
      metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
    },
    PLATFORM_INSTALLATION_ID: 'installation-shared-test',
    EMAIL_GATEWAY_ORIGIN: 'https://email-gateway.example.test',
    EMAIL_SENDER_DOMAIN: 'mail.example.com',
    EMAIL_SHARED_ACCOUNT_ID: env.CF_ACCOUNT_ID,
    EMAIL_SHARED_ZONE_ID: 'shared-zone',
    EMAIL_SHARED_INGRESS_NAME: 'native-gateway',
  } as ApiEnv['Bindings'];
}
async function setup(config: NonNullable<Parameters<typeof stubCustomerCf>[0]> = {}) {
  const provider = stubCustomerCf({
    zones: {
      'example.com': { id: 'shared-zone', name: 'example.com', accountId: env.CF_ACCOUNT_ID },
    },
    mx: { 'mail.example.com': ['route1.mx.cloudflare.net'] },
    ...config,
  });
  const operation = await ensureSharedEmailConnection(env.db, bindings());
  await runEmailOperation(env.db, bindings(), operation!);
  expect((await resolveEmailDomain(env.db, 'mail.example.com'))?.route.inbound_status).toBe(
    'ready',
  );
  const user = await createTestUser(env.db);
  const project = await createTestProject(env.db, user.id, 'shared-project');
  await deployEmailHandlers(project.id);
  return { provider, user, project };
}
async function deployEmailHandlers(projectId: string) {
  const deployment = await createTestDeployment(env.db, projectId);
  await env.db
    .update(deployments)
    .set({ manifest: JSON.stringify({ version: 3, bindings: {}, emailProtocolVersion: 1 }) })
    .where(eq(deployments.id, deployment.id));
  return deployment;
}
async function ledger() {
  return (await env.db.select().from(emailSharedRecipients))[0]!;
}

describe('shared inbound allocation', () => {
  it('creates a project without allocating an inbound provider rule', async () => {
    const { user, provider } = await setup();
    const response = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'created-project' }),
      }),
      bindings(),
    );
    expect(response.status).toBe(201);
    expect(await env.db.select().from(emailSharedRecipients)).toHaveLength(0);
    expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(0);
  });

  it('allocates no inbound rule for static or send-only live apps, or inactive email builds', async () => {
    const { project, provider } = await setup();
    const [active] = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    for (const manifest of [
      { version: 3, type: 'static', bindings: {} },
      // Outbound SDK use does not emit the inbound protocol declaration.
      { version: 3, type: 'void', bindings: {}, workerMain: 'worker.js' },
    ]) {
      await env.db
        .update(deployments)
        .set({ manifest: JSON.stringify(manifest) })
        .where(eq(deployments.id, active!.id));
      await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
      await reconcileSharedEmailRecipients(env.db, bindings());
    }
    const inactive = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({ manifest: JSON.stringify({ version: 3, bindings: {}, emailProtocolVersion: 1 }) })
      .where(eq(deployments.id, inactive.id));
    await reconcileSharedEmailRecipients(env.db, bindings());
    await env.db
      .update(projects)
      .set({ active_deployment_id: inactive.id })
      .where(eq(projects.id, project.id));
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    await env.db
      .update(projects)
      .set({ active_deployment_id: null })
      .where(eq(projects.id, project.id));
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    expect(await env.db.select().from(emailSharedRecipients)).toHaveLength(0);
    expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(0);
  });

  it('reaches a receiving app in a bounded repair batch behind non-email projects', async () => {
    const { user, project, provider } = await setup();
    // These sort ahead of the receiving app and must not consume the repair limit.
    for (let index = 0; index < 12; index++) {
      const id = `proj_a_static_${index}`;
      await env.db
        .insert(projects)
        .values({ id, user_id: user.id, slug: `static-project-${index}` });
      await createTestDeployment(env.db, id);
    }
    await reconcileSharedEmailRecipients(env.db, bindings(), 1);
    expect(await env.db.select().from(emailSharedRecipients)).toMatchObject([
      { project_id: project.id, status: 'ready' },
    ]);
    expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(1);
  });

  it('provisions the validated incoming receiving app before its first activation', async () => {
    const { project, provider } = await setup();
    await env.db
      .update(projects)
      .set({ active_deployment_id: null })
      .where(eq(projects.id, project.id));
    await env.db.delete(deployments).where(eq(deployments.project_id, project.id));
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id, {
      emailProtocolVersion: 1,
    });
    expect(await getSharedEmailRecipientReadiness(env.db, bindings(), project.id)).toMatchObject({
      status: 'ready',
    });
    expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(1);
  });

  it('uses the incoming handler declaration during real first-deploy admission', async () => {
    const { project, user, provider } = await setup({
      failOn: { literalRuleCreate: { status: 409, message: 'routing rule capacity limit' } },
      failBeforeEffect: ['literalRuleCreate'],
    });
    await env.db
      .update(projects)
      .set({ active_deployment_id: null })
      .where(eq(projects.id, project.id));
    await env.db.delete(deployments).where(eq(deployments.project_id, project.id));
    const response = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifest: { version: 3, assetManifestVersion: 2, bindings: {}, emailProtocolVersion: 1 },
          assetManifest: {},
          hasWorker: true,
        }),
      }),
      bindings(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      event: 'error',
      message: expect.stringContaining('could not allocate an Email Routing rule'),
    });
    expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(1);
  });

  it('retains existing owned rules when handlers are removed and still cleans them up on deletion', async () => {
    const { project, provider } = await setup();
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    const before = await ledger();
    await env.db
      .update(deployments)
      .set({ manifest: JSON.stringify({ version: 3, bindings: {} }) })
      .where(eq(deployments.project_id, project.id));
    await reconcileSharedEmailRecipients(env.db, bindings());
    expect(await ledger()).toEqual(before);
    expect(callsByTag(provider.calls, 'literalRuleDelete')).toHaveLength(0);
    await removeSharedEmailRecipients(env.db, bindings(), project.id);
    expect(await ledger()).toMatchObject({ status: 'removed' });
    expect(callsByTag(provider.calls, 'literalRuleDelete')).toHaveLength(1);
  });
});

async function recoveryOperator() {
  const admin = await createTestUser(
    env.db,
    'recipient-admin',
    'github',
    undefined,
    'free',
    'admin',
  );
  return createOperatorToken(env.db, admin);
}
function operatorRequest(token: string, path: string, body?: Record<string, unknown>) {
  return app.fetch(
    new Request(`http://localhost/operator/v1/email/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    bindings(),
  );
}
async function ageCreation(id: string) {
  await env.db
    .update(emailSharedRecipients)
    .set({ create_started_at: sql`now() - interval '25 hours'` })
    .where(eq(emailSharedRecipients.id, id));
}

describe('operator shared recipient creation recovery', () => {
  it('discovers and resolves an inspected absent creation for a deleting project without replaying it', async () => {
    const { project, user, provider } = await setup({
      failOn: { literalRuleCreate: { status: 503, message: 'request did not reach provider' } },
      failBeforeEffect: ['literalRuleCreate'],
    });
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    const row = await ledger();
    await ageCreation(row.id);
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
    await expect(removeSharedEmailRecipients(env.db, bindings(), project.id)).rejects.toThrow(
      'unknown outcome',
    );
    const token = await recoveryOperator();
    const discovery = await operatorRequest(token, `shared-recipients?project=${project.slug}`);
    expect(await discovery.json()).toMatchObject({
      recipients: [
        { id: row.id, projectId: project.id, removing: true, createStartedAt: expect.any(String) },
      ],
    });
    expect((await operatorRequest(user.jwt, 'shared-recipients')).status).toBe(401);
    const body = {
      ended: true,
      outcome: 'not-applied',
      reason: 'Provider request audit confirms no creation occurred',
    };
    const before = await ledger();
    const planned = await operatorRequest(token, `shared-recipients/${row.id}/resolve`, {
      ...body,
      dryRun: true,
    });
    expect(planned.status).toBe(200);
    const plan = (await planned.json()) as { target: { recoveryFence: string } };
    expect(await ledger()).toEqual(before);
    expect(await env.db.select().from(operatorEvents)).toHaveLength(0);
    const resolved = await operatorRequest(token, `shared-recipients/${row.id}/resolve`, {
      ...body,
      recoveryFence: plan.target.recoveryFence,
    });
    expect(resolved.status).toBe(200);
    expect(await ledger()).toMatchObject({
      create_started_at: null,
      removing: true,
      status: 'blocked',
    });
    expect(
      (await env.db.select().from(projects).where(eq(projects.id, project.id)))[0]?.status,
    ).toBe('deleting');
    expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(1);
    expect(callsByTag(provider.calls, 'literalRuleDelete')).toHaveLength(0);
    const [audit] = await env.db.select().from(operatorEvents);
    expect(audit).toMatchObject({ status: 'success' });
    expect(JSON.parse(audit!.target)).toMatchObject({
      recipientId: row.id,
      outcome: 'not-applied',
      reason: body.reason,
      recoveryFence: plan.target.recoveryFence,
    });
    await removeSharedEmailRecipients(env.db, bindings(), project.id);
    await deleteProjectCascade(env.db, project.id);
    expect(await ledger()).toMatchObject({ status: 'removed' });
  });

  it('adopts only an exact owned applied rule and keeps it unready until reconciliation', async () => {
    const config = { failOn: { literalRuleCreate: { status: 503, message: 'lost response' } } };
    const { project, provider } = await setup(config);
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    const row = await ledger();
    await ageCreation(row.id);
    const rule = [...provider.routingRuleStates.get('shared-zone')!.values()][0]!;
    rule.enabled = false;
    const token = await recoveryOperator();
    const body = {
      ended: true,
      outcome: 'applied',
      reason: 'Provider audit and exact rule confirm original creation',
    };
    const planned = await operatorRequest(token, `shared-recipients/${row.id}/resolve`, {
      ...body,
      dryRun: true,
    });
    expect(planned.status).toBe(200);
    const plan = (await planned.json()) as {
      target: { recoveryFence: string; providerRuleId: string };
    };
    const result = await operatorRequest(token, `shared-recipients/${row.id}/resolve`, {
      ...body,
      recoveryFence: plan.target.recoveryFence,
    });
    expect(result.status).toBe(200);
    expect(await ledger()).toMatchObject({
      rule_id: plan.target.providerRuleId,
      create_started_at: null,
      status: 'pending',
    });
    expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(1);
    expect(callsByTag(provider.calls, 'literalRuleUpdate')).toHaveLength(0);
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    expect(await ledger()).toMatchObject({ status: 'ready', rule_id: plan.target.providerRuleId });
    expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(1);
    expect(callsByTag(provider.calls, 'literalRuleUpdate')).toHaveLength(1);
  });

  it('rejects recent attempts, missing attestation, stale previews, live leases, and changed provider ownership', async () => {
    const { project, provider } = await setup({
      failOn: { literalRuleCreate: { status: 503, message: 'lost response' } },
    });
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    const row = await ledger();
    const token = await recoveryOperator();
    const path = `shared-recipients/${row.id}/resolve`;
    const body = {
      ended: true,
      outcome: 'applied',
      reason: 'Provider audit completed',
      dryRun: true,
    };
    expect((await operatorRequest(token, path, { ...body, ended: false })).status).toBe(400);
    expect((await operatorRequest(token, path, body)).status).toBe(409);
    await ageCreation(row.id);
    const plan = (await (await operatorRequest(token, path, body)).json()) as {
      target: { recoveryFence: string };
    };
    await env.db
      .update(emailSharedRecipients)
      .set({ attempt: row.attempt + 1 })
      .where(eq(emailSharedRecipients.id, row.id));
    expect(
      (
        await operatorRequest(token, path, {
          ...body,
          dryRun: false,
          recoveryFence: plan.target.recoveryFence,
        })
      ).status,
    ).toBe(409);
    await env.db
      .update(emailSharedRecipients)
      .set({ status: 'reconciling', lease_started_at: sql`now()` })
      .where(eq(emailSharedRecipients.id, row.id));
    expect((await operatorRequest(token, path, body)).status).toBe(409);
    await env.db
      .update(emailSharedRecipients)
      .set({ status: 'unknown', lease_started_at: null })
      .where(eq(emailSharedRecipients.id, row.id));
    const rule = [...provider.routingRuleStates.get('shared-zone')!.values()][0]!;
    rule.actions = [{ type: 'worker', value: ['foreign-worker'] }];
    expect((await operatorRequest(token, path, body)).status).toBe(409);
    expect(await ledger()).toMatchObject({ create_started_at: expect.any(String), rule_id: null });
    expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(1);
  });
  it('refuses an absence preview when the original owned rule appears before apply', async () => {
    const { project, provider } = await setup({
      failOn: { literalRuleCreate: { status: 503, message: 'unknown outcome' } },
      failBeforeEffect: ['literalRuleCreate'],
    });
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    const row = await ledger();
    await ageCreation(row.id);
    const token = await recoveryOperator();
    const path = `shared-recipients/${row.id}/resolve`;
    const body = { ended: true, outcome: 'not-applied', reason: 'Provider audit completed' };
    const plan = (await (await operatorRequest(token, path, { ...body, dryRun: true })).json()) as {
      target: { recoveryFence: string };
    };
    provider.routingRuleStates.get('shared-zone')!.set('late-rule', {
      id: 'late-rule',
      name: row.rule_name,
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: row.recipient }],
      actions: [{ type: 'worker', value: ['native-gateway'] }],
    });
    expect(
      (await operatorRequest(token, path, { ...body, recoveryFence: plan.target.recoveryFence }))
        .status,
    ).toBe(409);
    expect(await ledger()).toMatchObject({ create_started_at: expect.any(String), rule_id: null });
    expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(1);
  });
});

function pauseProviderRead(
  provider: ReturnType<typeof stubCustomerCf>,
  matches: (url: string) => boolean,
) {
  const original = provider.fn.getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paused = false,
    selected = false;
  provider.fn.mockImplementation(async (...args) => {
    const response = await original(...args);
    if (!selected && (!args[1]?.method || args[1].method === 'GET') && matches(String(args[0]))) {
      selected = true;
      paused = true;
      await gate;
    }
    return response;
  });
  return {
    release,
    wait: () => vi.waitFor(() => expect(paused).toBe(true), { timeout: 1000, interval: 1 }),
  };
}
async function expireRecipientLease(id: string) {
  await env.db
    .update(emailSharedRecipients)
    .set({ lease_started_at: sql`now() - interval '16 minutes'` })
    .where(eq(emailSharedRecipients.id, id));
}

describe('managed shared subdomain recipients', () => {
  it('stops stale creation after cleanup has claimed the ledger and a replacement reuses the slug', async () => {
    const { project, user, provider } = await setup();
    const paused = pauseProviderRead(provider, (url) => url.includes('/email/routing/rules?page='));
    const stale = reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    await paused.wait();
    const old = await ledger();
    await expireRecipientLease(old.id);
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
    await removeSharedEmailRecipients(env.db, bindings(), project.id);
    await deleteProjectCascade(env.db, project.id);
    const replacement = await createTestProject(env.db, user.id, project.slug);
    await deployEmailHandlers(replacement.id);
    await reconcileSharedEmailRecipient(env.db, bindings(), replacement.id);
    paused.release();
    await stale;
    expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(1);
    expect(
      (
        await env.db
          .select()
          .from(emailSharedRecipients)
          .where(eq(emailSharedRecipients.id, old.id))
      )[0],
    ).toMatchObject({ status: 'removed', create_started_at: null });
    expect(
      await getSharedEmailRecipientReadiness(env.db, bindings(), replacement.id, true),
    ).toMatchObject({ status: 'ready' });
  });
  it('stops a stale re-enable from updating a replacement rule even if the provider recycles its ID', async () => {
    const { project, user, provider } = await setup();
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    const old = await ledger();
    provider.routingRuleStates.get('shared-zone')!.get(old.rule_id!)!.enabled = false;
    const paused = pauseProviderRead(provider, (url) => url.includes('/email/routing/rules?page='));
    const stale = reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    await paused.wait();
    await expireRecipientLease(old.id);
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
    await removeSharedEmailRecipients(env.db, bindings(), project.id);
    await deleteProjectCascade(env.db, project.id);
    const replacement = await createTestProject(env.db, user.id, project.slug);
    await deployEmailHandlers(replacement.id);
    await reconcileSharedEmailRecipient(env.db, bindings(), replacement.id);
    paused.release();
    await stale;
    expect(callsByTag(provider.calls, 'literalRuleUpdate')).toHaveLength(0);
    expect(
      await getSharedEmailRecipientReadiness(env.db, bindings(), replacement.id, true),
    ).toMatchObject({ status: 'ready' });
  });
  it('stops stale cleanup before DELETE after another cleanup and a replacement own the address', async () => {
    const { project, user, provider } = await setup();
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    const old = await ledger();
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
    const paused = pauseProviderRead(provider, (url) =>
      url.endsWith(`/email/routing/rules/${old.rule_id}`),
    );
    const stale = removeSharedEmailRecipients(env.db, bindings(), project.id);
    await paused.wait();
    await expireRecipientLease(old.id);
    await removeSharedEmailRecipients(env.db, bindings(), project.id);
    await deleteProjectCascade(env.db, project.id);
    const replacement = await createTestProject(env.db, user.id, project.slug);
    await deployEmailHandlers(replacement.id);
    await reconcileSharedEmailRecipient(env.db, bindings(), replacement.id);
    paused.release();
    await expect(stale).rejects.toThrow('superseded');
    expect(callsByTag(provider.calls, 'literalRuleDelete')).toHaveLength(1);
    expect(
      await getSharedEmailRecipientReadiness(env.db, bindings(), replacement.id, true),
    ).toMatchObject({ status: 'ready' });
  });
  it('fences the legacy database cascade and slug changes until exact recipient cleanup completes', async () => {
    const { project, user, provider } = await setup();
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    await env.db.insert(resources).values({
      id: 'legacy-cascade-resource',
      project_id: project.id,
      type: 'kv',
      binding_name: 'CACHE',
      cf_id: 'owned-kv',
    });
    // This is the cascade a previous Worker version runs, without the
    // provider cleanup hook. Its transaction must not release the slug.
    await expect(deleteProjectCascade(env.db, project.id)).rejects.toThrow();
    await expect(
      env.db.update(projects).set({ slug: 'reassigned-slug' }).where(eq(projects.id, project.id)),
    ).rejects.toThrow();
    expect(
      (await env.db.select().from(projects).where(eq(projects.id, project.id)))[0],
    ).toMatchObject({ slug: project.slug });
    expect(await ledger()).toMatchObject({ status: 'ready' });
    expect(
      await env.db.select().from(resources).where(eq(resources.project_id, project.id)),
    ).toHaveLength(1);
    expect(callsByTag(provider.calls, 'literalRuleDelete')).toHaveLength(0);
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
    await removeSharedEmailRecipients(env.db, bindings(), project.id);
    await deleteProjectCascade(env.db, project.id);
    expect(await ledger()).toMatchObject({ status: 'removed', project_id: project.id });
    const replacement = await createTestProject(env.db, user.id, project.slug);
    await deployEmailHandlers(replacement.id);
    expect(replacement.id).not.toBe(project.id);
  });
  it('reports verified project readiness and blocks it when provider plus addressing drifts', async () => {
    const { project, provider, user } = await setup();
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    const request = () =>
      app.fetch(
        new Request(`http://localhost/projects/${project.id}/email/settings`, {
          headers: { Authorization: `Bearer ${user.jwt}` },
        }),
        bindings(),
      );
    expect(await (await request()).json()).toMatchObject({
      sharedInbound: { recipient: 'shared-project@mail.example.com', status: 'ready' },
    });
    provider.routingSettingsStates.get('shared-zone')!.support_subaddress = false;
    expect(await (await request()).json()).toMatchObject({
      sharedInbound: { status: 'blocked', reason: expect.stringContaining('subaddress') },
    });
    expect(await ledger()).toMatchObject({ status: 'blocked' });
  });

  it('keeps a reusable slug reserved through the real teardown route after an uncertain recipient create', async () => {
    skipOrphanSweepDelay();
    const { project, user, provider } = await setup({
      failOn: { literalRuleCreate: { status: 503, message: 'unknown outcome' } },
      failBeforeEffect: ['literalRuleCreate'],
    });
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    const deleted = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      bindings(),
    );
    expect(deleted.status).not.toBe(200);
    expect(
      (await env.db.select().from(projects).where(eq(projects.id, project.id)))[0],
    ).toMatchObject({ slug: project.slug, status: 'deleting' });
    const reused = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: project.slug }),
      }),
      bindings(),
    );
    expect(reused.status).toBe(409);
    expect(callsByTag(provider.calls, 'literalRuleDelete')).toHaveLength(0);
  });
  it('verifies an exact owned recipient and plus addressing without changing foreign rules or catch-all', async () => {
    const { project, provider } = await setup({
      catchAllRule: { enabled: true, workerName: 'unrelated-apex' },
      routingRules: [
        {
          id: 'foreign',
          name: 'Existing support',
          enabled: true,
          addresses: ['support@mail.example.com'],
          workerName: 'support-worker',
        },
      ],
    });
    expect(await getSharedEmailRecipientReadiness(env.db, bindings(), project.id)).toMatchObject({
      status: 'pending',
    });
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    const row = await ledger();
    expect(row).toMatchObject({
      recipient: 'shared-project@mail.example.com',
      status: 'ready',
      rule_id: expect.any(String),
      create_started_at: null,
    });
    expect(await getSharedEmailRecipientReadiness(env.db, bindings(), project.id)).toMatchObject({
      status: 'ready',
    });
    expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(1);
    expect(callsByTag(provider.calls, 'literalRuleGet')).toHaveLength(1);
    expect(callsByTag(provider.calls, 'catchAll')).toHaveLength(0);
    expect(provider.routingRuleStates.get('shared-zone')?.get('foreign')).toMatchObject({
      name: 'Existing support',
      actions: [{ type: 'worker', value: ['support-worker'] }],
    });
    expect(callsByTag(provider.calls, 'subaddressing')[0]?.body).toEqual({
      support_subaddress: true,
    });
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(1);
  });

  it('blocks foreign base and plus addresses without taking over provider rules', async () => {
    const { project, provider } = await setup({
      routingRules: [
        {
          enabled: true,
          addresses: ['shared-project+vip@mail.example.com'],
          workerName: 'other-worker',
        },
      ],
    });
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    expect(await ledger()).toMatchObject({
      status: 'blocked',
      rule_id: null,
      reason: expect.stringContaining('unrelated'),
    });
    expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(0);
    expect(callsByTag(provider.calls, 'literalRuleUpdate')).toHaveLength(0);
  });

  it('recovers a lost create response from exact ownership without creating a duplicate', async () => {
    const config: NonNullable<Parameters<typeof stubCustomerCf>[0]> = {
      failOn: { literalRuleCreate: { status: 503, message: 'provider response lost' } },
    };
    const { project, provider } = await setup(config);
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    expect(await ledger()).toMatchObject({
      status: 'unknown',
      rule_id: null,
      create_started_at: expect.any(String),
    });
    delete config.failOn!.literalRuleCreate;
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    expect(await ledger()).toMatchObject({
      status: 'ready',
      rule_id: expect.any(String),
      create_started_at: null,
    });
    expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(1);
  });

  it('does not retry an ambiguous create whose exact rule is absent, or release its slug for reuse', async () => {
    const { project, provider } = await setup({
      failOn: { literalRuleCreate: { status: 503, message: 'unknown create' } },
      failBeforeEffect: ['literalRuleCreate'],
    });
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    expect(await ledger()).toMatchObject({ status: 'unknown' });
    expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(1);
    await expect(removeSharedEmailRecipients(env.db, bindings(), project.id)).rejects.toThrow(
      'unknown outcome',
    );
    expect(await env.db.select().from(projects).where(eq(projects.id, project.id))).toHaveLength(1);
  });

  it('fails readback and cleanup closed when the exact recorded rule changes action', async () => {
    const { project, provider } = await setup();
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    const row = await ledger();
    provider.routingRuleStates.get('shared-zone')!.get(row.rule_id!)!.actions = [
      { type: 'worker', value: ['foreign-worker'] },
    ];
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    expect(await ledger()).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('ownership'),
    });
    await expect(removeSharedEmailRecipients(env.db, bindings(), project.id)).rejects.toThrow(
      'ownership',
    );
    expect(callsByTag(provider.calls, 'literalRuleDelete')).toHaveLength(0);
  });

  it('removes only the exact owned rule before a new project can reuse the address', async () => {
    const { project, user, provider } = await setup({
      routingRules: [{ id: 'foreign', enabled: true, addresses: ['support@mail.example.com'] }],
    });
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    const old = await ledger();
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
    await removeSharedEmailRecipients(env.db, bindings(), project.id);
    expect(await ledger()).toMatchObject({ status: 'removed' });
    expect(provider.routingRuleStates.get('shared-zone')!.has('foreign')).toBe(true);
    await deleteProjectCascade(env.db, project.id);
    const replacement = await createTestProject(env.db, user.id, project.slug);
    await deployEmailHandlers(replacement.id);
    await reconcileSharedEmailRecipient(env.db, bindings(), replacement.id);
    const rows = await env.db.select().from(emailSharedRecipients);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.project_id === replacement.id)).toMatchObject({
      status: 'ready',
      rule_name: expect.not.stringMatching(old.rule_name),
    });
    const deletes = callsByTag(provider.calls, 'literalRuleDelete').length;
    await removeSharedEmailRecipients(env.db, bindings(), project.id);
    expect(callsByTag(provider.calls, 'literalRuleDelete')).toHaveLength(deletes);
  });

  it('preserves a disabled owned rule identity when enabling it again', async () => {
    const { project, provider } = await setup();
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    const row = await ledger();
    provider.routingRuleStates.get('shared-zone')!.get(row.rule_id!)!.enabled = false;
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    expect(await ledger()).toMatchObject({ status: 'ready', rule_id: row.rule_id });
    expect(callsByTag(provider.calls, 'literalRuleUpdate')).toHaveLength(1);
    expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(1);
  });

  it('reports the provider capacity limit before creating another literal rule', async () => {
    const { project, provider } = await setup({
      routingRules: Array.from({ length: 200 }, (_, index) => ({
        enabled: true,
        addresses: [`address-${index}@mail.example.com`],
      })),
    });
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    expect(await ledger()).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('200 routing-rule limit'),
    });
    expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(0);
  });

  it('does not overlap a live reconciliation or claim readiness from domain provisioning alone', async () => {
    const { project, provider } = await setup();
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const original = provider.fn.getMockImplementation()!;
    let pending = false;
    provider.fn.mockImplementation(async (...args) => {
      if (args[1]?.method === 'POST' && String(args[0]).endsWith('/email/routing/rules')) {
        pending = true;
        await blocked;
      }
      return original(...args);
    });
    const first = reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    await vi.waitFor(() => expect(pending).toBe(true), { timeout: 1000, interval: 1 });
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    await expect(removeSharedEmailRecipients(env.db, bindings(), project.id)).rejects.toThrow(
      'still running',
    );
    expect(
      (await getSharedEmailRecipientReadiness(env.db, bindings(), project.id))?.status,
    ).not.toBe('ready');
    unblock();
    await first;
    expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(1);
  });

  it('repairs missing project recipients before cycling through already ready rows', async () => {
    const { project, user } = await setup();
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    const second = await createTestProject(env.db, user.id, 'second-project');
    await deployEmailHandlers(second.id);
    await reconcileSharedEmailRecipients(env.db, bindings(), 1);
    expect(await getSharedEmailRecipientReadiness(env.db, bindings(), second.id)).toMatchObject({
      status: 'ready',
    });
  });
  it('pins the returned provider ID and refuses an identically named replacement', async () => {
    const { project, provider } = await setup();
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    const row = await ledger();
    const rules = provider.routingRuleStates.get('shared-zone')!;
    const rule = rules.get(row.rule_id!)!;
    rules.delete(row.rule_id!);
    rules.set('replacement-id', { ...rule, id: 'replacement-id' });
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    expect(await ledger()).toMatchObject({ status: 'blocked', rule_id: row.rule_id });
    await expect(removeSharedEmailRecipients(env.db, bindings(), project.id)).rejects.toThrow(
      'ownership',
    );
    expect(callsByTag(provider.calls, 'literalRuleDelete')).toHaveLength(0);
  });
  it('keeps deletion fenced when configured installation identity changes', async () => {
    const { project, provider } = await setup();
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    await expect(
      removeSharedEmailRecipients(
        env.db,
        { ...bindings(), EMAIL_SHARED_ZONE_ID: 'foreign-zone' } as ApiEnv['Bindings'],
        project.id,
      ),
    ).rejects.toThrow('identity');
    expect(callsByTag(provider.calls, 'literalRuleDelete')).toHaveLength(0);
    expect(await ledger()).toMatchObject({ status: 'ready' });
  });
  it('recovers a lost delete response only after exact absence readback', async () => {
    const config: NonNullable<Parameters<typeof stubCustomerCf>[0]> = { failOn: {} };
    const { project, provider } = await setup(config);
    await reconcileSharedEmailRecipient(env.db, bindings(), project.id);
    config.failOn!.literalRuleDelete = { status: 503, message: 'response lost' };
    await expect(removeSharedEmailRecipients(env.db, bindings(), project.id)).rejects.toThrow();
    expect(await ledger()).toMatchObject({ status: 'blocked', removing: true });
    delete config.failOn!.literalRuleDelete;
    await removeSharedEmailRecipients(env.db, bindings(), project.id);
    expect(await ledger()).toMatchObject({ status: 'removed' });
    expect(callsByTag(provider.calls, 'literalRuleDelete')).toHaveLength(1);
  });
  it('refuses custom subdomain catch-all setup before DNS, rule, or Worker writes', async () => {
    const { project, provider, user } = await setup();
    const { requestEmailDomainAdd } = await import('../../src/email/connection-service.ts');
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: project.id,
        domain: 'custom.example.com',
        actor: { kind: 'admin', userId: user.id },
      }),
    ).rejects.toThrow('zone apex');
    expect(callsByTag(provider.calls, 'scriptPut')).toHaveLength(0);
    expect(callsByTag(provider.calls, 'catchAll')).toHaveLength(0);
    expect(callsByTag(provider.calls, 'routingDns')).toHaveLength(1);
  });
});
