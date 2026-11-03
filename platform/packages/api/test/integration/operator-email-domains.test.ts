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
  emailCredentials,
  emailDomainRoutes,
  emailOperations,
  emailOperationSteps,
  emailZoneConnections,
} from '../../src/email/connection-schema.ts';
import {
  EMAIL_OPERATION_RECOVERY_MIN_AGE_MS,
  requestEmailDomainAdd,
  requestEmailDomainRemove,
  runEmailOperation,
} from '../../src/email/connection-service.ts';
import type { ApiEnv } from '../../src/env.ts';
import app from '../../src/index.ts';
import { operatorEvents, projects } from '../../src/schema.ts';
import { callsByTag, stubCustomerCf } from './email-domain-cf-stub.ts';
import {
  CF_ACCOUNT_ID,
  clearTables,
  createOperatorToken,
  createTestProject,
  createTestUser,
  setupEnv,
  skipOrphanSweepDelay,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv, operatorToken: string;
// Each custom mail hostname is the apex of its own test zone.
const zones = Object.fromEntries(
  [
    'email-gateway.example.test',
    'mail.example.com',
    'recovery.example.com',
    'blocked.example.com',
    'brand.example.com',
    'brand-race.example.com',
    'deleted-cleanup.example.com',
    'deleted-owner-cleanup.example.com',
    'replacement-cleanup.example.com',
    'guarded-replacement.example.com',
    'replacement-sibling.example.com',
    'teardown-first.example.com',
    'teardown-second.example.com',
    'stale-teardown.example.com',
    'unknown-cleanup.example.com',
  ].map((name) => [
    name,
    { id: 'zone-' + name.replaceAll('.', '-'), name, accountId: CF_ACCOUNT_ID },
  ]),
);

const OWNER_TOKEN = 'owner-scoped-token';
function bindings(): ApiEnv['Bindings'] {
  return {
    ...env,
    EMAIL_GATEWAY_ORIGIN: 'https://email-gateway.example.test',
  } as unknown as ApiEnv['Bindings'];
}
function request(path: string, body?: Record<string, unknown>, token = operatorToken) {
  return app.fetch(
    new Request(`http://localhost/operator/v1${path}`, {
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
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
  const admin = await createTestUser(env.db, 'operator-mail', 'github', undefined, 'free', 'admin');
  operatorToken = await createOperatorToken(env.db, admin);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('operator email domain management', () => {
  it('requires operator authentication and validates a project before provider calls', async () => {
    const stub = stubCustomerCf({ zones });
    expect((await request('/email/domains', undefined, 'invalid')).status).toBe(401);
    const bad = await request('/email/domains', { domain: 'mail.example.com', project: 'missing' });
    expect(bad.status).toBe(404);
    expect(stub.calls).toHaveLength(0);
  });

  it('previews without mutations and then manages one exact route with a platform token', async () => {
    const owner = await createTestUser(env.db, 'managed-owner'),
      project = await createTestProject(env.db, owner.id, 'managed-project');
    const stub = stubCustomerCf({ zones });
    const preview = await request('/email/domains', {
      domain: 'mail.example.com',
      project: project.slug,
      dryRun: true,
    });
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as { dryRun: boolean }).dryRun).toBe(true);
    expect(callsByTag(stub.calls, 'scriptPut')).toHaveLength(0);
    expect(await env.db.select().from(emailDomainRoutes)).toHaveLength(0);
    const add = await request('/email/domains', {
      domain: 'mail.example.com',
      project: project.slug,
    });
    expect(add.status).toBe(200);
    const payload = (await add.json()) as {
      domain: { operationId: string; readiness: { inbound: { status: string } } };
    };
    expect(payload.domain.operationId).toMatch(/^eop/);
    expect(payload.domain.readiness.inbound.status).toBe('ready');
    expect((await env.db.select().from(emailZoneConnections))[0]?.managed_by).toBe('admin');
    expect((await request('/email/domains/mail.example.com')).status).toBe(200);
    expect((await request('/email/domains/mail.example.com/rotate-secret', {})).status).toBe(200);
    expect(callsByTag(stub.calls, 'secretPut')).toHaveLength(2);
    expect((await request('/email/domains/mail.example.com/remove', {})).status).toBe(200);
    expect((await env.db.select().from(emailDomainRoutes))[0]?.desired_state).toBe('removed');
  });

  it('previews and refuses foreign MX conflicts with supported alternatives and no provider writes', async () => {
    const owner = await createTestUser(env.db, 'mx-preview-owner');
    const project = await createTestProject(env.db, owner.id, 'mx-preview-project');
    const stub = stubCustomerCf({ zones, mx: { 'mail.example.com': ['mx.other.test'] } });
    const response = await request('/email/domains', {
      domain: 'mail.example.com',
      project: project.slug,
      dryRun: true,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dryRun: true,
      effect:
        'mail.example.com already receives mail; setup will refuse it — use an unused domain apex or a platform shared email address instead.',
    });
    expect(stub.calls.map((call) => call.tag)).toEqual(['mxLookup']);
    const refused = await request('/email/domains', {
      domain: 'mail.example.com',
      project: project.slug,
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      message:
        'mail.example.com already has MX records; use an unused domain apex or a platform shared email address',
    });
    expect(stub.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(await env.db.select().from(emailDomainRoutes)).toHaveLength(0);
  });

  it('adds an outbound-only apex that keeps its Microsoft 365 MX', async () => {
    const owner = await createTestUser(env.db, 'outbound-owner');
    const project = await createTestProject(env.db, owner.id, 'outbound-project');
    const sendingSubdomains: Array<{ name: string; enabled: boolean }> = [];
    const failOn: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {
      onboardSending: { message: 'entitlement required', status: 403 },
    };
    const stub = stubCustomerCf({
      zones,
      sendingSubdomains,
      failOn,
      mx: { 'brand.example.com': ['brand-example.mail.protection.outlook.com'] },
    });
    const body = { domain: 'brand.example.com', project: project.slug, outboundOnly: true };
    expect((await request('/email/domains', { ...body, outboundOnly: 'yes' })).status).toBe(400);

    const preview = await request('/email/domains', { ...body, dryRun: true });
    expect(await preview.json()).toMatchObject({
      dryRun: true,
      target: { domain: 'brand.example.com', inboundMode: 'none' },
      effect: expect.stringContaining('MX records and inbound mail stay with its current'),
    });
    expect(stub.calls.filter((call) => call.method !== 'GET')).toEqual([]);

    // Without Email Sending the domain cannot send at all, so setup fails instead of degrading.
    const blocked = await request('/email/domains', body);
    expect(await blocked.json()).toMatchObject({
      ok: false,
      domain: {
        inboundMode: 'none',
        operationStatus: 'blocked',
        readiness: { inbound: { status: 'disabled' }, outbound: { status: 'blocked' } },
      },
    });
    expect(callsByTag(stub.calls, 'routingDns')).toEqual([]);
    expect(callsByTag(stub.calls, 'scriptPut')).toEqual([]);
    expect(callsByTag(stub.calls, 'catchAll')).toEqual([]);

    delete failOn.onboardSending;
    const synced = await request('/email/domains/brand.example.com/sync', {});
    expect(await synced.json()).toMatchObject({
      domain: {
        inboundMode: 'none',
        status: 'ready',
        operationStatus: 'completed',
        readiness: { inbound: { status: 'disabled' }, outbound: { status: 'ready' } },
      },
    });
    sendingSubdomains.push({ name: 'brand.example.com', enabled: true });
    const status = await request('/email/domains/brand.example.com');
    expect(await status.json()).toMatchObject({
      inboundMode: 'none',
      status: 'ready',
      readiness: {
        inbound: { status: 'disabled' },
        outbound: { status: 'ready' },
        management: { status: 'healthy' },
      },
    });
    expect(callsByTag(stub.calls, 'catchAllGet')).toEqual([]);
    expect(
      await (
        await request('/email/domains', {
          domain: 'brand.example.com',
          project: project.slug,
          dryRun: true,
        })
      ).json(),
    ).toMatchObject({ plan: 'refuse', existing: { inboundMode: 'none', status: 'ready' } });
    expect(
      await (await request('/email/domains/brand.example.com/sync', { dryRun: true })).json(),
    ).toMatchObject({ effect: expect.stringContaining('Email Sending onboarding') });
    expect(
      (await request('/email/domains/brand.example.com/rotate-secret', { dryRun: true })).status,
    ).toBe(409);
    expect((await request('/email/domains/brand.example.com/rotate-secret', {})).status).toBe(409);
    expect(callsByTag(stub.calls, 'secretPut')).toEqual([]);
    expect(
      (
        await env.db.select().from(operatorEvents).where(eq(operatorEvents.action, 'email/domains'))
      ).map((event) => JSON.parse(event.target)),
    ).toContainEqual({ domain: 'brand.example.com', project: project.slug, outboundOnly: true });

    expect((await request('/email/domains/brand.example.com/remove', {})).status).toBe(200);
    expect((await env.db.select().from(emailDomainRoutes))[0]?.desired_state).toBe('removed');
    expect(callsByTag(stub.calls, 'routingDns')).toEqual([]);
  });

  it('keeps a newer Sending result when a status refresh read it stale', async () => {
    const owner = await createTestUser(env.db, 'outbound-race-owner');
    const project = await createTestProject(env.db, owner.id, 'outbound-race-project');
    const on: NonNullable<Parameters<typeof stubCustomerCf>[0]>['on'] = {};
    stubCustomerCf({ zones, on });
    await request('/email/domains', {
      domain: 'brand-race.example.com',
      project: project.slug,
      outboundOnly: true,
    });
    await env.db
      .update(emailDomainRoutes)
      .set({ outbound_status: 'pending', outbound_observed_at: null })
      .where(eq(emailDomainRoutes.domain, 'brand-race.example.com'));
    // The refresh reads an empty Sending list, then a setup step records 'ready'.
    on.sendingSubdomainsGet = async () => {
      await env.db
        .update(emailDomainRoutes)
        .set({ outbound_status: 'ready', outbound_observed_at: new Date().toISOString() })
        .where(eq(emailDomainRoutes.domain, 'brand-race.example.com'));
    };
    expect((await request('/email/domains/brand-race.example.com')).status).toBe(200);
    expect(
      (
        await env.db
          .select()
          .from(emailDomainRoutes)
          .where(eq(emailDomainRoutes.domain, 'brand-race.example.com'))
      )[0]?.outbound_status,
    ).toBe('ready');
  });

  it('leaves a foreign catch-all untouched and reports the refusal', async () => {
    const owner = await createTestUser(env.db, 'foreign-owner'),
      project = await createTestProject(env.db, owner.id, 'foreign-project');
    const stub = stubCustomerCf({
      zones,
      catchAllRule: { enabled: true, workerName: 'foreign-worker' },
    });
    const response = await request('/email/domains', {
      domain: 'mail.example.com',
      project: project.slug,
    });
    expect(response.status).toBe(409);
    expect(callsByTag(stub.calls, 'catchAll')).toHaveLength(0);
    expect(await env.db.select().from(emailDomainRoutes)).toHaveLength(0);
  });

  it('previews and applies an exact aged unknown-write recovery fence', async () => {
    const owner = await createTestUser(env.db, 'recovery-owner');
    const project = await createTestProject(env.db, owner.id, 'recovery-project');
    stubCustomerCf({
      zones,
      failOn: { scriptPut: { message: 'response lost', status: 504 } },
    });
    const added = await request('/email/domains', {
      domain: 'recovery.example.com',
      project: project.slug,
    });
    expect(await added.json()).toMatchObject({
      ok: false,
      domain: { operationStatus: 'unknown' },
    });
    expect(await env.db.select().from(operatorEvents)).toEqual([
      expect.objectContaining({ action: 'email/domains', status: 'failed' }),
    ]);
    const [operation] = await env.db
      .select()
      .from(emailOperations)
      .where(eq(emailOperations.status, 'unknown'));
    expect(operation?.current_step).toBe('ingress_deploy');
    const tooRecent = await request(`/email/operations/${operation!.id}/resolve`, {
      ended: true,
      outcome: 'not-applied',
      reason: 'Provider audit completed',
      dryRun: true,
    });
    expect(tooRecent.status).toBe(409);
    await env.db
      .update(emailOperationSteps)
      .set({
        started_at: new Date(
          Date.now() - EMAIL_OPERATION_RECOVERY_MIN_AGE_MS - 1_000,
        ).toISOString(),
      })
      .where(eq(emailOperationSteps.operation_id, operation!.id));
    const preview = await request(`/email/operations/${operation!.id}/resolve`, {
      ended: true,
      outcome: 'not-applied',
      reason: 'Provider audit completed',
      dryRun: true,
    });
    expect(preview.status).toBe(200);
    const target = ((await preview.json()) as { target: Record<string, unknown> }).target;
    expect(target).toMatchObject({
      operationId: operation!.id,
      step: 'ingress_deploy',
      outcome: 'not-applied',
    });
    const applied = await request(`/email/operations/${operation!.id}/resolve`, {
      ended: true,
      outcome: 'not-applied',
      reason: 'Provider audit completed',
      stepId: target.stepId,
      attempt: target.attempt,
      requestDigest: target.requestDigest,
      resourceIdentity: target.resourceIdentity,
      connectionId: target.connectionId,
      desiredGeneration: target.desiredGeneration,
      routeId: target.routeId,
      routeDesiredGeneration: target.routeDesiredGeneration,
    });
    expect(applied.status).toBe(200);
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, operation!.id)))[0]
        ?.status,
    ).toBe('pending');
  });

  it('reports blocked setup as failure and a completed sync as success', async () => {
    const owner = await createTestUser(env.db, 'blocked-owner');
    const project = await createTestProject(env.db, owner.id, 'blocked-project');
    const failOn: { scriptPut?: { message: string; status: number } } = {
      scriptPut: { message: 'Permission denied', status: 403 },
    };
    stubCustomerCf({ zones, failOn });
    const added = await request('/email/domains', {
      domain: 'blocked.example.com',
      project: project.slug,
    });
    expect(await added.json()).toMatchObject({
      ok: false,
      domain: { operationStatus: 'blocked' },
    });
    expect(await env.db.select().from(operatorEvents)).toEqual([
      expect.objectContaining({ action: 'email/domains', status: 'failed' }),
    ]);

    delete failOn.scriptPut;
    const synced = await request('/email/domains/blocked.example.com/sync', {});
    const result = await synced.json();
    expect(result).toMatchObject({ domain: { operationStatus: 'completed' } });
    expect(result).not.toHaveProperty('ok', false);
    expect(
      await env.db
        .select()
        .from(operatorEvents)
        .where(eq(operatorEvents.action, 'email/domains/blocked.example.com/sync')),
    ).toEqual([expect.objectContaining({ status: 'success' })]);
  });

  it('lets an administrator finish blocked cleanup after the project is deleted', async () => {
    const owner = await createTestUser(env.db, 'deleted-cleanup-owner');
    const project = await createTestProject(env.db, owner.id, 'deleted-cleanup-project');
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {};
    const stub = stubCustomerCf({ zones, failOn: failures });
    const added = await request('/email/domains', {
      domain: 'deleted-cleanup.example.com',
      project: project.slug,
    });
    expect(added.status).toBe(200);
    const [route] = await env.db.select().from(emailDomainRoutes);
    failures.scriptDelete = { message: 'script delete permission denied', status: 403 };
    const cleanup = await requestEmailDomainRemove(
      env.db,
      bindings(),
      route!.id,
      { kind: 'system' },
      `teardown:${project.id}:${route!.id}`,
    );
    await runEmailOperation(env.db, bindings(), cleanup);
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, cleanup)))[0],
    ).toMatchObject({ status: 'blocked', current_step: 'ingress_delete' });

    await env.db.delete(projects).where(eq(projects.id, project.id));
    delete failures.scriptDelete;
    const removed = await request('/email/domains/deleted-cleanup.example.com/remove', {});
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({
      domain: { removed: true, operationStatus: 'completed' },
    });
    expect(
      (await env.db.select().from(emailDomainRoutes).where(eq(emailDomainRoutes.id, route!.id)))[0]
        ?.desired_state,
    ).toBe('removed');
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(2);
  });

  it('resumes an owner-managed system cleanup after the project is deleted', async () => {
    const owner = await createTestUser(env.db, 'deleted-owner-cleanup-owner');
    const project = await createTestProject(env.db, owner.id, 'deleted-owner-cleanup-project');
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {};
    const stub = stubCustomerCf({ zones, failOn: failures });
    const added = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'deleted-owner-cleanup.example.com',
      token: OWNER_TOKEN,
      actor: { kind: 'owner', userId: owner.id },
    });
    await runEmailOperation(env.db, bindings(), added.operationId);
    expect((await env.db.select().from(emailZoneConnections))[0]?.managed_by).toBe('owner');

    failures.scriptDelete = { message: 'script delete permission denied', status: 403 };
    const cleanup = await requestEmailDomainRemove(
      env.db,
      bindings(),
      added.routeId,
      { kind: 'system' },
      `teardown:${project.id}:${added.routeId}`,
    );
    await runEmailOperation(env.db, bindings(), cleanup);
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, cleanup)))[0],
    ).toMatchObject({
      actor_kind: 'system',
      status: 'blocked',
      current_step: 'ingress_delete',
    });

    await env.db.delete(projects).where(eq(projects.id, project.id));
    delete failures.scriptDelete;
    const removed = await request('/email/domains/deleted-owner-cleanup.example.com/remove', {});
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({
      domain: { operationId: cleanup, removed: true, operationStatus: 'completed' },
    });
    expect(
      (await env.db.select().from(emailOperations)).filter(
        (operation) => operation.kind === 'remove',
      ),
    ).toHaveLength(1);
    expect((await env.db.select().from(emailZoneConnections))[0]?.credential_id).toBeNull();
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(2);
  });

  it('replaces an expired credential only to finish the original orphaned system cleanup', async () => {
    const owner = await createTestUser(env.db, 'replacement-cleanup-owner');
    const project = await createTestProject(env.db, owner.id, 'replacement-cleanup-project');
    const stub = stubCustomerCf({ zones });
    const added = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'replacement-cleanup.example.com',
      token: OWNER_TOKEN,
      actor: { kind: 'owner', userId: owner.id },
    });
    await runEmailOperation(env.db, bindings(), added.operationId);
    const [connectionBefore] = await env.db.select().from(emailZoneConnections);
    await env.db.update(emailCredentials).set({ status: 'expired' });
    const cleanup = await requestEmailDomainRemove(
      env.db,
      bindings(),
      added.routeId,
      { kind: 'system' },
      `teardown:${project.id}:${added.routeId}`,
    );
    await runEmailOperation(env.db, bindings(), cleanup);
    const cleanupBefore = (
      await env.db.select().from(emailOperations).where(eq(emailOperations.id, cleanup))
    )[0]!;
    expect(cleanupBefore).toMatchObject({
      actor_kind: 'system',
      status: 'blocked',
      current_step: 'catchall_detach',
    });

    await env.db.delete(projects).where(eq(projects.id, project.id));
    const checkpoint = stub.calls.length;
    const preview = await request('/email/domains/replacement-cleanup.example.com/remove', {
      apiToken: 'replacement-scoped-token',
      dryRun: true,
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      dryRun: true,
      target: { credentialReplacement: true },
      effect: expect.stringContaining('resumes the retained blocked project cleanup'),
    });
    expect(stub.calls).toHaveLength(checkpoint);
    const removed = await request('/email/domains/replacement-cleanup.example.com/remove', {
      apiToken: 'replacement-scoped-token',
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({
      domain: { operationId: cleanup, removed: true, operationStatus: 'completed' },
    });
    const [connectionAfter] = await env.db.select().from(emailZoneConnections);
    expect(connectionAfter).toMatchObject({
      managed_by: connectionBefore!.managed_by,
      manager_user_id: connectionBefore!.manager_user_id,
      desired_generation: cleanupBefore.desired_generation,
      credential_id: null,
    });
    expect(
      (await env.db.select().from(emailOperations)).filter(
        (operation) => operation.kind === 'remove',
      ),
    ).toHaveLength(1);
    expect(callsByTag(stub.calls, 'verifyToken')).toHaveLength(2);
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(1);
  });

  it('rejects cleanup credential replacement for an active owner, sibling, or unresolved operation', async () => {
    const owner = await createTestUser(env.db, 'guarded-replacement-owner');
    const project = await createTestProject(env.db, owner.id, 'guarded-replacement-project');
    const stub = stubCustomerCf({ zones });
    const added = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'guarded-replacement.example.com',
      token: OWNER_TOKEN,
      actor: { kind: 'owner', userId: owner.id },
    });
    await runEmailOperation(env.db, bindings(), added.operationId);
    const [connection] = await env.db.select().from(emailZoneConnections);
    await env.db.update(emailCredentials).set({ status: 'expired' });
    const cleanup = await requestEmailDomainRemove(
      env.db,
      bindings(),
      added.routeId,
      { kind: 'system' },
      `teardown:${project.id}:${added.routeId}`,
    );
    await runEmailOperation(env.db, bindings(), cleanup);
    const activeOwner = await request('/email/domains/guarded-replacement.example.com/remove', {
      apiToken: 'replacement-scoped-token',
    });
    expect(activeOwner.status).toBe(409);
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
    await env.db.insert(emailDomainRoutes).values({
      id: 'replacement-sibling',
      domain: 'replacement-sibling.example.com',
      connection_id: connection!.id,
      project_id: project.id,
      addressing: 'custom',
      managed_by: 'owner',
      assigned_by_user_id: owner.id,
    });

    const sibling = await request('/email/domains/guarded-replacement.example.com/remove', {
      apiToken: 'replacement-scoped-token',
    });
    expect(sibling.status).toBe(409);
    await env.db
      .update(emailDomainRoutes)
      .set({ desired_state: 'removed' })
      .where(eq(emailDomainRoutes.id, 'replacement-sibling'));
    await env.db.insert(emailOperations).values({
      id: 'replacement-unresolved',
      installation_id: connection!.installation_id,
      connection_id: connection!.id,
      actor_kind: 'system',
      actor_scope: 'system',
      kind: 'cleanup',
      idempotency_key: 'replacement-unresolved',
      request_digest: 'a'.repeat(64),
      desired_generation: connection!.desired_generation,
    });
    for (const status of ['pending', 'running', 'unknown'] as const) {
      await env.db
        .update(emailOperations)
        .set({ status })
        .where(eq(emailOperations.id, 'replacement-unresolved'));
      const unresolved = await request('/email/domains/guarded-replacement.example.com/remove', {
        apiToken: 'replacement-scoped-token',
      });
      expect(unresolved.status).toBe(409);
    }
    expect(callsByTag(stub.calls, 'verifyToken')).toHaveLength(1);
  });

  it('reclaims an admin-removed final owner connection during project teardown', async () => {
    skipOrphanSweepDelay();
    const owner = await createTestUser(env.db, 'teardown-owner-cleanup-owner');
    const first = await createTestProject(env.db, owner.id, 'teardown-owner-cleanup-first');
    const second = await createTestProject(env.db, owner.id, 'teardown-owner-cleanup-second');
    const stub = stubCustomerCf({ zones });
    const firstAdded = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: first.id,
      domain: 'teardown-first.example.com',
      token: OWNER_TOKEN,
      actor: { kind: 'owner', userId: owner.id },
    });
    await runEmailOperation(env.db, bindings(), firstAdded.operationId);
    const secondAdded = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: second.id,
      domain: 'teardown-second.example.com',
      token: OWNER_TOKEN,
      actor: { kind: 'owner', userId: owner.id },
    });
    await runEmailOperation(env.db, bindings(), secondAdded.operationId);

    expect((await request('/email/domains/teardown-first.example.com/remove', {})).status).toBe(
      200,
    );
    expect(
      (
        await app.fetch(
          new Request(`http://localhost/projects/${first.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${owner.jwt}` },
          }),
          bindings(),
        )
      ).status,
    ).toBe(200);
    expect(
      (await env.db.select().from(emailOperations)).filter(
        (operation) => operation.kind === 'remove',
      ),
    ).toHaveLength(2);
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(1);

    expect((await request('/email/domains/teardown-second.example.com/remove', {})).status).toBe(
      200,
    );
    expect(
      (await env.db.select().from(emailZoneConnections)).find(
        (row) => row.zone_name === 'teardown-second.example.com',
      )?.credential_id,
    ).not.toBeNull();
    expect(
      (
        await app.fetch(
          new Request(`http://localhost/projects/${second.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${owner.jwt}` },
          }),
          bindings(),
        )
      ).status,
    ).toBe(200);

    const removals = (await env.db.select().from(emailOperations)).filter(
      (operation) => operation.kind === 'remove',
    );
    expect(removals).toHaveLength(4);
    expect(removals).toContainEqual(
      expect.objectContaining({
        route_id: secondAdded.routeId,
        actor_kind: 'system',
        status: 'completed',
      }),
    );
    expect((await env.db.select().from(emailZoneConnections))[0]?.credential_id).toBeNull();
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(2);
  });

  it('does not let a stale project teardown remove a reassigned route', async () => {
    const owner = await createTestUser(env.db, 'stale-teardown-owner');
    const original = await createTestProject(env.db, owner.id, 'stale-teardown-original');
    const replacement = await createTestProject(env.db, owner.id, 'stale-teardown-replacement');
    stubCustomerCf({ zones });
    const added = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: original.id,
      domain: 'stale-teardown.example.com',
      token: OWNER_TOKEN,
      actor: { kind: 'owner', userId: owner.id },
    });
    await runEmailOperation(env.db, bindings(), added.operationId);
    expect((await request('/email/domains/stale-teardown.example.com/remove', {})).status).toBe(
      200,
    );
    const reassigned = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: replacement.id,
      domain: 'stale-teardown.example.com',
      token: OWNER_TOKEN,
      actor: { kind: 'owner', userId: owner.id },
    });
    await runEmailOperation(env.db, bindings(), reassigned.operationId);

    expect(
      await requestEmailDomainRemove(
        env.db,
        bindings(),
        reassigned.routeId,
        { kind: 'system' },
        `teardown:${original.id}:${reassigned.routeId}`,
        original.id,
      ),
    ).toBeNull();
    expect(
      (
        await env.db.select().from(emailDomainRoutes).where(eq(emailDomainRoutes.id, added.routeId))
      )[0],
    ).toMatchObject({ project_id: replacement.id, desired_state: 'active' });
    expect(
      (await env.db.select().from(emailOperations)).filter(
        (operation) => operation.kind === 'remove',
      ),
    ).toHaveLength(1);
  });

  it('does not replay unknown cleanup after the project is deleted', async () => {
    const owner = await createTestUser(env.db, 'unknown-cleanup-owner');
    const project = await createTestProject(env.db, owner.id, 'unknown-cleanup-project');
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {};
    const stub = stubCustomerCf({ zones, failOn: failures });
    const added = await request('/email/domains', {
      domain: 'unknown-cleanup.example.com',
      project: project.slug,
    });
    expect(added.status).toBe(200);
    const [route] = await env.db
      .select()
      .from(emailDomainRoutes)
      .where(eq(emailDomainRoutes.domain, 'unknown-cleanup.example.com'));
    failures.scriptDelete = { message: 'script delete response lost', status: 504 };
    const cleanup = await requestEmailDomainRemove(
      env.db,
      bindings(),
      route!.id,
      { kind: 'system' },
      `teardown:${project.id}:${route!.id}`,
    );
    await runEmailOperation(env.db, bindings(), cleanup);
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, cleanup)))[0]
        ?.status,
    ).toBe('unknown');

    await env.db.delete(projects).where(eq(projects.id, project.id));
    delete failures.scriptDelete;
    const retained = await request('/email/domains/unknown-cleanup.example.com/remove', {});
    expect(retained.status).toBe(200);
    expect(await retained.json()).toMatchObject({
      ok: false,
      domain: { operationId: cleanup, operationStatus: 'unknown' },
    });
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(1);
  });
});
