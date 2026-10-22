import { and, eq, sql } from 'drizzle-orm';
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
import { hmacSignState } from '../../src/auth/hmac.ts';
import { emailUnresolvedAttempts } from '../../src/email/admission-schema.ts';
import { disableEmailDomainRouteAndDrainTx } from '../../src/email/admission.ts';
import {
  emailCacheOutbox,
  emailCredentials,
  emailDomainRoutes,
  emailOperationSteps,
  emailOperations,
  emailSharedRecipients,
  emailZoneConnections,
} from '../../src/email/connection-schema.ts';
import {
  ensureSharedEmailConnection,
  EMAIL_OPERATION_RECOVERY_MIN_AGE_MS,
  flushEmailCacheOutbox,
  getEmailOperation,
  inspectUnknownEmailOperationRecovery,
  reconcilePendingEmailOperations,
  reconcileUnknownEmailOperation,
  requestEmailDomainAdd,
  requestEmailDomainRemove,
  requestEmailDomainSync,
  requestEmailSecretRotation,
  readConnectionSecret,
  resolveEmailDomain,
  resolveEmailIngress,
  resolveUnknownEmailOperation,
  runEmailOperation,
} from '../../src/email/connection-service.ts';
import type { ApiEnv } from '../../src/env.ts';
import { app } from '../../src/index.ts';
import { deployments, projectMembers, projects } from '../../src/schema.ts';
import { callsByTag, stubCustomerCf } from './email-domain-cf-stub.ts';
import {
  clearTables,
  createTestProject,
  createTestDeployment,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

// Each fixture domain below is the apex of its own visible test zone.
const zones = Object.fromEntries(
  [
    'example.com',
    'active.example.com',
    'alerts.example.com',
    'blocked-removal.example.com',
    'blocked-rotation.example.com',
    'catchall-preflight.example.com',
    'concurrent-one.example.com',
    'concurrent-two.example.com',
    'first.example.com',
    'foreign.example.com',
    'gone.example.com',
    'hr.example.com',
    'late-failure.example.com',
    'late-success.example.com',
    'limits.example.com',
    'lost.example.com',
    'mail.example.com',
    'manager-retained-replacement.example.com',
    'manager-retained-staged.example.com',
    'manager.example.com',
    'mutation-race.example.com',
    'mutation-replay.example.com',
    'mx.example.com',
    'not-applied-delete.example.com',
    'not-applied-rotation.example.com',
    'occupied.example.com',
    'one.example.com',
    'other.example.com',
    'outbound.example.com',
    'outbound-conflict.example.com',
    'outbound-mode.example.com',
    'outbound-refused.example.com',
    'outbound-timeout.example.com',
    'pending-original.example.com',
    'pending-replacement.example.com',
    'pending-rotation.example.com',
    'permission.example.com',
    'probe-removal.example.com',
    'probe-route.example.com',
    'queue-a.example.com',
    'queue-b.example.com',
    'race.example.com',
    'readd-conflict.example.com',
    'readd-staged.example.com',
    'readd.example.com',
    'recover-relay.example.com',
    'recover-routing.example.com',
    'recovery-timezone.example.com',
    'refused.example.com',
    'replacement-staged.example.com',
    'replay.example.com',
    'rotate.example.com',
    'rotation-credential.example.com',
    'rotation-repair.example.com',
    'second.example.com',
    'sending-negative.example.com',
    'sending-removal.example.com',
    'sending.example.com',
    'setup-repair.example.com',
    'stale-removal.example.com',
    'status-removal.example.com',
    'support.example.com',
    'sync-staged-rotation.example.com',
    'timeout.example.com',
    'transfer.example.com',
    'two.example.com',
    'unknown-delete.example.com',
    'unknown.example.com',
  ].map((name) => [
    name,
    {
      id: name === 'example.com' ? 'zone-example' : 'zone-' + name.replaceAll('.', '-'),
      name,
      accountId: 'customer-account',
    },
  ]),
);
const TOKEN = 'customer-scoped-token';
let env: TestEnv;
function bindings(): ApiEnv['Bindings'] {
  return {
    ...env,
    EMAIL_GATEWAY_ORIGIN: 'https://email-gateway.example.test',
  } as unknown as ApiEnv['Bindings'];
}

async function waitForPostgresLockWaiters(minimum: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await env.db.execute(sql`
      SELECT count(*)::int AS waiters
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
    `);
    if (Number((result.rows[0] as { waiters?: number } | undefined)?.waiters ?? 0) >= minimum) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${minimum} PostgreSQL lock waiters`);
}

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

describe('durable zone email connections', () => {
  it('resolves tenant dispatch limits from the owner plan and active deployment', async () => {
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id, 'ingress-limits');
    stubCustomerCf({ zones });
    const added = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'limits.example.com',
      token: TOKEN,
      actor: { kind: 'owner', userId: owner.id },
    });
    await runEmailOperation(env.db, bindings(), added.operationId);
    const deployment = await createTestDeployment(env.db, project.id);
    await env.db
      .update(deployments)
      .set({ manifest: JSON.stringify({ emailProtocolVersion: 1, limits: { cpuMs: 100 } }) })
      .where(eq(deployments.id, deployment.id));
    const { connection, route } = (await resolveEmailDomain(env.db, 'limits.example.com'))!;
    const to = 'support@limits.example.com';
    const proof = await hmacSignState(
      `email-ingress-v1\n${connection.account_id}\n${connection.zone_id}\n${connection.ingress_worker_name}\n${to}`,
      env.EMAIL_SIGNING_SECRET,
    );
    const response = await app.fetch(
      new Request('https://api/internal/email/resolve-ingress', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-void-internal': proof },
        body: JSON.stringify({
          accountId: connection.account_id,
          zoneId: connection.zone_id,
          ingressName: connection.ingress_worker_name,
          to,
          secret: await readConnectionSecret(bindings(), connection),
        }),
      }),
      bindings(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      projectId: project.id,
      deploymentId: deployment.id,
      routeId: route.id,
      routeGeneration: route.desired_generation,
      connectionId: connection.id,
      limits: { cpuMs: 10, subRequests: 50 },
    });
  });

  it('does not treat a DNS resolver failure as an unused mail domain', async () => {
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id, 'dns-failure');
    const stub = stubCustomerCf({ zones, dnsStatus: 2 });
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: project.id,
        domain: 'example.com',
        token: TOKEN,
        actor: { kind: 'owner', userId: owner.id },
      }),
    ).rejects.toThrow('DNS MX lookup');
    expect(stub.calls.filter((call) => call.method !== 'GET')).toEqual([]);
    expect(await env.db.select().from(emailOperations)).toEqual([]);
  });

  it('blocks setup when Cloudflare definitively refuses a provider write', async () => {
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id, 'routing-permission');
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {
      routingDns: { message: 'permission denied', status: 403 },
    };
    const stub = stubCustomerCf({
      zones,
      failOn: failures,
    });
    const actor = { kind: 'owner' as const, userId: owner.id };
    const { operationId, routeId } = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'permission.example.com',
      token: TOKEN,
      actor,
    });

    await runEmailOperation(env.db, bindings(), operationId);

    expect((await getEmailOperation(env.db, project.id, operationId))?.operation).toMatchObject({
      status: 'blocked',
      current_step: 'routing_enable',
      failure_code: 'blocked',
      failure_detail: expect.stringContaining('permission denied'),
    });
    expect(callsByTag(stub.calls, 'routingDns')).toHaveLength(1);
    expect(await reconcilePendingEmailOperations(env.db, bindings())).toBe(0);

    delete failures.routingDns;
    const resumed = await requestEmailDomainSync(env.db, bindings(), routeId, actor);
    expect(resumed).toBe(operationId);
    await runEmailOperation(env.db, bindings(), resumed);
    expect((await getEmailOperation(env.db, project.id, operationId))?.operation.status).toBe(
      'completed',
    );
    expect(callsByTag(stub.calls, 'routingDns')).toHaveLength(2);
  });

  it('keeps a Cloudflare request timeout outcome unknown', async () => {
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id, 'routing-timeout');
    const stub = stubCustomerCf({
      zones,
      failOn: { routingDns: { message: 'request timeout', status: 408 } },
    });
    const { operationId } = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'timeout.example.com',
      token: TOKEN,
      actor: { kind: 'owner', userId: owner.id },
    });

    await runEmailOperation(env.db, bindings(), operationId);

    expect((await getEmailOperation(env.db, project.id, operationId))?.operation).toMatchObject({
      status: 'unknown',
      current_step: 'routing_enable',
      failure_code: 'outcome_unknown',
      failure_detail: expect.stringContaining('request timeout'),
    });
    expect(callsByTag(stub.calls, 'routingDns')).toHaveLength(1);
  });

  it('repairs a blocked initial setup with a corrected credential under a new attempt', async () => {
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id, 'setup-credential-repair');
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {
      routingDns: { message: 'routing permission denied', status: 403 },
    };
    const stub = stubCustomerCf({ zones, failOn: failures });
    const actor = { kind: 'owner' as const, userId: owner.id };
    const first = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'setup-repair.example.com',
      token: TOKEN,
      actor,
      attemptId: 'initial-setup-attempt',
    });
    await runEmailOperation(env.db, bindings(), first.operationId);
    expect(
      (
        await env.db.select().from(emailOperations).where(eq(emailOperations.id, first.operationId))
      )[0],
    ).toMatchObject({ status: 'blocked', current_step: 'routing_enable' });

    delete failures.routingDns;
    const replacementInput = {
      projectId: project.id,
      domain: 'setup-repair.example.com',
      token: 'corrected-customer-token',
      actor,
      attemptId: 'replacement-setup-attempt',
    };
    const repaired = await requestEmailDomainAdd(env.db, bindings(), replacementInput);
    expect(repaired.operationId).not.toBe(first.operationId);
    expect(await requestEmailDomainAdd(env.db, bindings(), replacementInput)).toEqual(repaired);

    await runEmailOperation(env.db, bindings(), repaired.operationId);

    expect(
      (
        await env.db
          .select()
          .from(emailOperations)
          .where(eq(emailOperations.id, repaired.operationId))
      )[0]?.status,
    ).toBe('completed');
    expect(
      (
        await env.db.select().from(emailOperations).where(eq(emailOperations.id, first.operationId))
      )[0]?.status,
    ).toBe('blocked');
    expect(
      (await resolveEmailDomain(env.db, 'setup-repair.example.com'))?.route.inbound_status,
    ).toBe('ready');
    expect(callsByTag(stub.calls, 'routingDns')).toHaveLength(2);
    expect(callsByTag(stub.calls, 'secretPut')).toHaveLength(1);
  });

  it('repairs a pending apex connection while fencing its superseded original operation', async () => {
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id, 'pending-connection-repair');
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {
      routingDns: { message: 'routing permission denied', status: 403 },
    };
    const stub = stubCustomerCf({ zones, failOn: failures });
    const actor = { kind: 'owner' as const, userId: owner.id };
    const originalInput = {
      projectId: project.id,
      domain: 'pending-original.example.com',
      token: TOKEN,
      actor,
      attemptId: 'pending-original-attempt',
    };
    const original = await requestEmailDomainAdd(env.db, bindings(), originalInput);
    await runEmailOperation(env.db, bindings(), original.operationId);
    const blocked = (
      await env.db
        .select()
        .from(emailOperations)
        .where(eq(emailOperations.id, original.operationId))
    )[0]!;
    expect(blocked).toMatchObject({ status: 'blocked', current_step: 'routing_enable' });

    delete failures.routingDns;
    const replacement = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'pending-original.example.com',
      token: 'corrected-customer-token',
      actor,
    });
    await runEmailOperation(env.db, bindings(), replacement.operationId);

    const replacementRoute = (await resolveEmailDomain(env.db, 'pending-original.example.com'))!;
    expect(replacementRoute.route.inbound_status).toBe('ready');
    expect(replacementRoute.connection.desired_generation).toBeGreaterThan(
      blocked.desired_generation,
    );
    expect(await requestEmailDomainAdd(env.db, bindings(), originalInput)).toEqual(original);
    expect(
      (
        await env.db
          .select()
          .from(emailOperations)
          .where(eq(emailOperations.id, original.operationId))
      )[0]?.status,
    ).toBe('blocked');

    const repairedOriginal = await requestEmailDomainSync(
      env.db,
      bindings(),
      original.routeId,
      actor,
    );
    await runEmailOperation(env.db, bindings(), repairedOriginal);
    expect(
      (await resolveEmailDomain(env.db, 'pending-original.example.com'))?.route.inbound_status,
    ).toBe('ready');
    expect(callsByTag(stub.calls, 'scriptPut')).toHaveLength(2);
    expect(callsByTag(stub.calls, 'secretPut')).toHaveLength(1);
  });

  it('blocks a failed provider read before its write and resumes without an ambiguous mutation', async () => {
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id, 'probe-route-preflight');
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {
      scriptSubdomain: { message: 'subdomain lookup unavailable', status: 503 },
    };
    const stub = stubCustomerCf({ zones, failOn: failures });
    const actor = { kind: 'owner' as const, userId: owner.id };
    const { operationId, routeId } = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'probe-route.example.com',
      token: TOKEN,
      actor,
    });

    await runEmailOperation(env.db, bindings(), operationId);

    expect((await getEmailOperation(env.db, project.id, operationId))?.operation).toMatchObject({
      status: 'blocked',
      current_step: 'probe_route_enable',
      failure_code: 'blocked',
    });
    expect(callsByTag(stub.calls, 'scriptSubdomain')).toMatchObject([{ method: 'GET' }]);

    delete failures.scriptSubdomain;
    expect(await requestEmailDomainSync(env.db, bindings(), routeId, actor)).toBe(operationId);
    await runEmailOperation(env.db, bindings(), operationId);

    expect((await getEmailOperation(env.db, project.id, operationId))?.operation.status).toBe(
      'completed',
    );
    expect(
      callsByTag(stub.calls, 'scriptSubdomain').filter((call) => call.method === 'POST'),
    ).toHaveLength(1);
  });

  it('blocks a failed catch-all ownership read before its write and resumes safely', async () => {
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id, 'catchall-preflight');
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {};
    const stub = stubCustomerCf({ zones, failOn: failures });
    const actor = { kind: 'owner' as const, userId: owner.id };
    const { operationId, routeId } = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'catchall-preflight.example.com',
      token: TOKEN,
      actor,
    });
    failures.catchAllGet = { message: 'catch-all lookup unavailable', status: 503 };

    await runEmailOperation(env.db, bindings(), operationId);

    expect((await getEmailOperation(env.db, project.id, operationId))?.operation).toMatchObject({
      status: 'blocked',
      current_step: 'catchall_ensure',
      failure_code: 'blocked',
    });
    expect(callsByTag(stub.calls, 'catchAll')).toHaveLength(0);

    delete failures.catchAllGet;
    expect(await requestEmailDomainSync(env.db, bindings(), routeId, actor)).toBe(operationId);
    await runEmailOperation(env.db, bindings(), operationId);

    expect((await getEmailOperation(env.db, project.id, operationId))?.operation.status).toBe(
      'completed',
    );
    expect(callsByTag(stub.calls, 'catchAll')).toHaveLength(1);
  });

  it('retries an attested not-applied routing write only through its exact recovery fence', async () => {
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id, 'routing-recovery');
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {
      routingDns: { message: 'response lost', status: 504 },
    };
    const stub = stubCustomerCf({ zones, failOn: failures });
    const { operationId, routeId } = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'recover-routing.example.com',
      token: TOKEN,
      actor: { kind: 'owner', userId: owner.id },
    });
    await runEmailOperation(env.db, bindings(), operationId);
    const old = new Date(Date.now() - EMAIL_OPERATION_RECOVERY_MIN_AGE_MS - 1_000).toISOString();
    await env.db
      .update(emailOperationSteps)
      .set({ started_at: old })
      .where(eq(emailOperationSteps.operation_id, operationId));
    const fence = await inspectUnknownEmailOperationRecovery(env.db, bindings(), operationId);
    await expect(
      resolveUnknownEmailOperation(env.db, bindings(), {
        ...fence,
        attempt: fence.attempt + 1,
        ended: true,
        outcome: 'not-applied',
        reason: 'Provider audit shows the request did not apply',
      }),
    ).rejects.toThrow('fence changed');

    await resolveUnknownEmailOperation(env.db, bindings(), {
      ...fence,
      ended: true,
      outcome: 'not-applied',
      reason: 'Provider audit shows the request did not apply',
    });
    delete failures.routingDns;
    await env.db
      .update(emailOperationSteps)
      .set({ request_digest: 'different-runtime-intent' })
      .where(eq(emailOperationSteps.id, fence.stepId));
    await runEmailOperation(env.db, bindings(), operationId);
    expect((await getEmailOperation(env.db, project.id, operationId))?.operation.status).toBe(
      'blocked',
    );
    expect(callsByTag(stub.calls, 'routingDns')).toHaveLength(1);
    await env.db
      .update(emailOperationSteps)
      .set({ request_digest: fence.requestDigest })
      .where(eq(emailOperationSteps.id, fence.stepId));
    expect(
      await requestEmailDomainSync(env.db, bindings(), routeId, {
        kind: 'owner',
        userId: owner.id,
      }),
    ).toBe(operationId);
    await runEmailOperation(env.db, bindings(), operationId);
    expect((await getEmailOperation(env.db, project.id, operationId))?.operation.status).toBe(
      'completed',
    );
    expect(callsByTag(stub.calls, 'routingDns')).toHaveLength(2);
  });

  it('accepts an attested applied relay upload without replaying the ambiguous write', async () => {
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id, 'relay-recovery');
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {
      scriptPut: { message: 'response lost', status: 504 },
    };
    const stub = stubCustomerCf({ zones, failOn: failures });
    const { operationId } = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'recover-relay.example.com',
      token: TOKEN,
      actor: { kind: 'owner', userId: owner.id },
    });
    await runEmailOperation(env.db, bindings(), operationId);
    await env.db
      .update(emailOperationSteps)
      .set({
        started_at: new Date(
          Date.now() - EMAIL_OPERATION_RECOVERY_MIN_AGE_MS - 1_000,
        ).toISOString(),
      })
      .where(eq(emailOperationSteps.operation_id, operationId));
    const fence = await inspectUnknownEmailOperationRecovery(env.db, bindings(), operationId);
    expect(fence.step).toBe('ingress_deploy');
    await resolveUnknownEmailOperation(env.db, bindings(), {
      ...fence,
      ended: true,
      outcome: 'applied',
      reason: 'Cloudflare shows the exact relay upload is active',
    });
    delete failures.scriptPut;
    await runEmailOperation(env.db, bindings(), operationId);
    const operation = (await getEmailOperation(env.db, project.id, operationId))?.operation;
    expect(operation?.status).toBe('completed');
    expect(callsByTag(stub.calls, 'scriptPut')).toHaveLength(1);
    expect(
      (
        await env.db
          .select({ version: emailZoneConnections.ingress_version })
          .from(emailZoneConnections)
      )[0]?.version,
    ).toBeGreaterThan(0);
  });

  it('lets newer operations progress while an older write remains unknown', async () => {
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id, 'reconcile-fairness');
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {
      scriptPut: { message: 'write outcome unknown', status: 504 },
    };
    const stub = stubCustomerCf({
      zones: {
        ...zones,
        'other.test': { id: 'zone-other', name: 'other.test', accountId: 'customer-account' },
      },
      failOn: failures,
    });
    const actor = { kind: 'owner' as const, userId: owner.id };
    const first = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'mail.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), first.operationId);
    delete failures.scriptPut;
    const second = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'other.test',
      actor,
      token: TOKEN,
    });
    await env.db
      .update(emailOperations)
      .set({ updated_at: '2020-01-01T00:00:00Z' })
      .where(eq(emailOperations.id, first.operationId));
    await reconcilePendingEmailOperations(env.db, bindings(), 1);
    expect((await getEmailOperation(env.db, project.id, first.operationId))?.operation.status).toBe(
      'unknown',
    );
    await reconcilePendingEmailOperations(env.db, bindings(), 1);
    expect(
      (await getEmailOperation(env.db, project.id, second.operationId))?.operation.status,
    ).toBe('completed');
    expect(callsByTag(stub.calls, 'scriptPut')).toHaveLength(2);
  });

  it('applies an attested Sending onboarding result and restores outbound readiness', async () => {
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id, 'sending-uncertain');
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {
      onboardSending: { message: 'write outcome unavailable', status: 504 },
      sendingSubdomainsGet: { message: 'readback unavailable', status: 504 },
    };
    const stub = stubCustomerCf({ zones, failOn: failures });
    const { operationId } = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'sending.example.com',
      token: TOKEN,
      actor: { kind: 'owner', userId: owner.id },
    });
    await runEmailOperation(env.db, bindings(), operationId);
    expect((await getEmailOperation(env.db, project.id, operationId))?.operation.status).toBe(
      'unknown',
    );
    expect((await resolveEmailDomain(env.db, 'sending.example.com'))?.route).toMatchObject({
      inbound_status: 'ready',
      outbound_status: 'pending',
    });
    await env.db
      .update(emailOperationSteps)
      .set({
        started_at: new Date(
          Date.now() - EMAIL_OPERATION_RECOVERY_MIN_AGE_MS - 1_000,
        ).toISOString(),
      })
      .where(eq(emailOperationSteps.operation_id, operationId));
    const fence = await inspectUnknownEmailOperationRecovery(env.db, bindings(), operationId);
    expect(fence.step).toBe('sending_onboard');
    await resolveUnknownEmailOperation(env.db, bindings(), {
      ...fence,
      ended: true,
      outcome: 'applied',
      reason: 'Cloudflare shows the exact sending domain is active',
    });
    delete failures.onboardSending;
    delete failures.sendingSubdomainsGet;
    await runEmailOperation(env.db, bindings(), operationId);
    expect((await getEmailOperation(env.db, project.id, operationId))?.operation.status).toBe(
      'completed',
    );
    expect((await resolveEmailDomain(env.db, 'sending.example.com'))?.route.outbound_status).toBe(
      'ready',
    );
    expect(callsByTag(stub.calls, 'onboardSending')).toHaveLength(1);
  });

  it('keeps a timed-out Sending onboarding unknown when readback is negative', async () => {
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id, 'sending-negative-readback');
    const stub = stubCustomerCf({
      zones,
      sendingSubdomains: [],
      failOn: {
        onboardSending: { message: 'write outcome unavailable', status: 504 },
      },
    });
    const { operationId } = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'sending-negative.example.com',
      token: TOKEN,
      actor: { kind: 'owner', userId: owner.id },
    });

    await runEmailOperation(env.db, bindings(), operationId);

    expect((await getEmailOperation(env.db, project.id, operationId))?.operation).toMatchObject({
      status: 'unknown',
      current_step: 'sending_onboard',
      failure_code: 'outcome_unknown',
    });
    expect(
      (await resolveEmailDomain(env.db, 'sending-negative.example.com'))?.route.outbound_status,
    ).toBe('pending');
    expect(callsByTag(stub.calls, 'onboardSending')).toHaveLength(1);
    expect(callsByTag(stub.calls, 'sendingSubdomainsGet')).toHaveLength(1);
  });

  it('does not report sync ready after the domain loses its MX records', async () => {
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id, 'mx-drift');
    const mx: Record<string, Array<string>> = {};
    stubCustomerCf({ zones, mx });
    const actor = { kind: 'owner' as const, userId: owner.id };
    const added = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'mx.example.com',
      token: TOKEN,
      actor,
    });
    await runEmailOperation(env.db, bindings(), added.operationId);
    mx['mx.example.com'] = [];
    const sync = await requestEmailDomainSync(env.db, bindings(), added.routeId, actor);
    await runEmailOperation(env.db, bindings(), sync);
    expect((await getEmailOperation(env.db, project.id, sync))?.operation.status).toBe('blocked');
    expect((await resolveEmailDomain(env.db, 'mx.example.com'))?.route).toMatchObject({
      inbound_status: 'drifted',
      inbound_reason: expect.stringContaining('MX records'),
    });
  });

  it('checks MX and explicit routing conflicts for new assignments on an existing zone', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'sibling-preflight');
    const routingRules: Array<{ enabled: boolean; addresses: Array<string> }> = [];
    const stub = stubCustomerCf({
      zones,
      routingRules,
      mx: { 'occupied.example.com': ['mx.other.test'] },
    });
    const actor = { kind: 'owner' as const, userId: user.id };
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'first.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    const writes = stub.calls.filter((call) => call.method !== 'GET').length;
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: project.id,
        domain: 'occupied.example.com',
        actor,
        token: TOKEN,
      }),
    ).rejects.toThrow('already has MX');
    routingRules.push({ enabled: true, addresses: ['owner@second.example.com'] });
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: project.id,
        domain: 'second.example.com',
        actor,
        token: TOKEN,
      }),
    ).rejects.toThrow('explicit Cloudflare email rules conflict');
    expect(stub.calls.filter((call) => call.method !== 'GET')).toHaveLength(writes);
    expect(await env.db.select().from(emailDomainRoutes)).toHaveLength(1);
  });

  it('returns the same operation for concurrent rotation and sync requests with the same key', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'operation-replay');
    stubCustomerCf({ zones });
    const actor = { kind: 'owner' as const, userId: user.id };
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'replay.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    const { connection } = (await resolveEmailDomain(env.db, 'replay.example.com'))!;
    const rotations = await Promise.all(
      Array.from({ length: 3 }, () =>
        requestEmailSecretRotation(env.db, bindings(), connection.id, actor, 'same-rotation'),
      ),
    );
    expect(new Set(rotations).size).toBe(1);
    await runEmailOperation(env.db, bindings(), rotations[0]);
    expect(
      await requestEmailSecretRotation(
        env.db,
        bindings(),
        connection.id,
        actor,
        'same-rotation',
        project.id,
      ),
    ).toBe(rotations[0]);
    const syncs = await Promise.all(
      Array.from({ length: 3 }, () =>
        requestEmailDomainSync(env.db, bindings(), add.routeId, actor, 'same-sync'),
      ),
    );
    expect(new Set(syncs).size).toBe(1);
    expect(
      await requestEmailDomainSync(env.db, bindings(), add.routeId, actor, 'same-sync', project.id),
    ).toBe(syncs[0]);
  });

  it.runIf(Boolean(process.env.VOID_TEST_DATABASE_URL))(
    'orders project-admin demotion before durable email-domain mutations',
    async () => {
      const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {};
      stubCustomerCf({ zones, failOn: failures });
      const owner = await createTestUser(env.db, 'email-mutation-race-owner');
      const admin = await createTestUser(env.db, 'email-mutation-race-admin');
      const project = await createTestProject(env.db, owner.id, 'email-mutation-race-project');
      await env.db.insert(projectMembers).values({
        project_id: project.id,
        user_id: admin.id,
        role: 'admin',
        added_by_user_id: owner.id,
      });
      const added = await requestEmailDomainAdd(env.db, bindings(), {
        projectId: project.id,
        domain: 'mutation-race.example.com',
        actor: { kind: 'owner', userId: owner.id },
        token: TOKEN,
      });
      await runEmailOperation(env.db, bindings(), added.operationId);
      const connection = (await resolveEmailDomain(env.db, 'mutation-race.example.com'))!
        .connection;
      const replayInput = {
        projectId: project.id,
        domain: 'mutation-replay.example.com',
        actor: { kind: 'owner' as const, userId: admin.id },
        token: TOKEN,
        attemptId: 'mutation-race-replay',
      };
      const blocked = await requestEmailDomainAdd(env.db, bindings(), replayInput);
      failures.routingDns = { message: 'permission denied', status: 403 };
      await runEmailOperation(env.db, bindings(), blocked.operationId);
      delete failures.routingDns;
      expect(
        (
          await env.db
            .select()
            .from(emailOperations)
            .where(eq(emailOperations.id, blocked.operationId))
        )[0],
      ).toMatchObject({ status: 'blocked' });

      for (const kind of ['add-replay', 'sync', 'remove', 'rotate'] as const) {
        await env.db
          .update(projectMembers)
          .set({ role: 'admin' })
          .where(
            and(eq(projectMembers.project_id, project.id), eq(projectMembers.user_id, admin.id)),
          );
        const operationCount = (await env.db.select().from(emailOperations)).length;
        let mutation:
          | Promise<
              { status: 'fulfilled'; value: string | null } | { status: 'rejected'; error: unknown }
            >
          | undefined;

        await env.db.transaction(async (tx) => {
          await tx
            .select({ id: projects.id })
            .from(projects)
            .where(eq(projects.id, project.id))
            .for('update');
          await tx
            .update(projectMembers)
            .set({ role: 'collaborator' })
            .where(
              and(eq(projectMembers.project_id, project.id), eq(projectMembers.user_id, admin.id)),
            );
          const actor = { kind: 'owner' as const, userId: admin.id };
          const request =
            kind === 'add-replay'
              ? requestEmailDomainAdd(env.db, bindings(), replayInput).then(
                  ({ operationId }) => operationId,
                )
              : kind === 'sync'
                ? requestEmailDomainSync(
                    env.db,
                    bindings(),
                    added.routeId,
                    actor,
                    undefined,
                    project.id,
                  )
                : kind === 'remove'
                  ? requestEmailDomainRemove(
                      env.db,
                      bindings(),
                      added.routeId,
                      actor,
                      undefined,
                      project.id,
                    )
                  : requestEmailSecretRotation(
                      env.db,
                      bindings(),
                      connection.id,
                      actor,
                      undefined,
                      project.id,
                    );
          mutation = request.then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (error: unknown) => ({ status: 'rejected' as const, error }),
          );
          await waitForPostgresLockWaiters(1);
        });

        const result = await mutation!;
        expect(result.status).toBe('rejected');
        if (result.status !== 'rejected') {
          throw new Error(`${kind} unexpectedly committed after project-admin demotion`);
        }
        expect(result.error).toMatchObject({ message: 'forbidden', status: 403 });
        expect(await env.db.select().from(emailOperations)).toHaveLength(operationCount);
        expect(
          (await resolveEmailDomain(env.db, 'mutation-race.example.com'))?.route,
        ).toMatchObject({ desired_state: 'active' });
      }
    },
    20_000,
  );

  it.runIf(Boolean(process.env.VOID_TEST_DATABASE_URL))(
    'serializes concurrent first assignments on the same Cloudflare zone',
    async () => {
      const user = await createTestUser(env.db);
      const first = await createTestProject(env.db, user.id, 'concurrent-zone-first');
      const second = await createTestProject(env.db, user.id, 'concurrent-zone-second');
      const mx: Record<string, Array<string>> = {
        'concurrent-one.example.com': [],
        'concurrent-two.example.com': [],
      };
      let provisionedDomain = '';
      // Both lookups must identify the same provider zone for this locking regression.
      stubCustomerCf({
        zones: {
          ...zones,
          'concurrent-two.example.com': {
            ...zones['concurrent-two.example.com']!,
            id: zones['concurrent-one.example.com']!.id,
          },
        },
        mx,
        on: {
          routingDns: () => {
            mx[provisionedDomain] = ['route1.mx.cloudflare.net'];
          },
        },
      });
      const actor = { kind: 'owner' as const, userId: user.id };

      const results = await Promise.allSettled([
        requestEmailDomainAdd(env.db, bindings(), {
          projectId: first.id,
          domain: 'concurrent-one.example.com',
          actor,
          token: TOKEN,
        }),
        requestEmailDomainAdd(env.db, bindings(), {
          projectId: second.id,
          domain: 'concurrent-two.example.com',
          actor,
          token: TOKEN,
        }),
      ]);

      const acceptedIndex = results.findIndex((result) => result.status === 'fulfilled');
      const accepted = results[acceptedIndex];
      const deferred = results[1 - acceptedIndex];
      expect(acceptedIndex).toBeGreaterThanOrEqual(0);
      expect(deferred?.status).toBe('rejected');
      if (accepted?.status !== 'fulfilled' || deferred?.status !== 'rejected') {
        throw new Error('expected one accepted assignment and one deferred assignment');
      }
      expect(deferred.reason).toMatchObject({
        message: expect.stringMatching(/^connection operation .* is unresolved$/),
        status: 409,
      });
      expect(await env.db.select().from(emailZoneConnections)).toHaveLength(1);
      expect(await env.db.select().from(emailDomainRoutes)).toHaveLength(1);

      provisionedDomain = (await env.db.select().from(emailDomainRoutes))[0]!.domain;
      await runEmailOperation(env.db, bindings(), accepted.value.operationId);
      const deferredProject = acceptedIndex === 0 ? second : first;
      const deferredDomain =
        deferredProject.id === first.id
          ? 'concurrent-one.example.com'
          : 'concurrent-two.example.com';
      await requestEmailDomainAdd(env.db, bindings(), {
        projectId: deferredProject.id,
        domain: deferredDomain,
        actor,
        token: TOKEN,
      });
      expect(await env.db.select().from(emailDomainRoutes)).toHaveLength(2);
    },
    15_000,
  );

  it.runIf(Boolean(process.env.VOID_TEST_DATABASE_URL))(
    'keeps provider status read-back behind the route-to-connection removal lock order',
    async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'status-removal-lock-order');
      stubCustomerCf({ zones });
      const added = await requestEmailDomainAdd(env.db, bindings(), {
        projectId: project.id,
        domain: 'status-removal.example.com',
        actor: { kind: 'owner', userId: user.id },
        token: TOKEN,
      });
      await runEmailOperation(env.db, bindings(), added.operationId);
      const before = (await resolveEmailDomain(env.db, 'status-removal.example.com'))!;

      let continueRemoval!: () => void;
      let routeLocked!: () => void;
      const removalMayContinue = new Promise<void>((resolve) => {
        continueRemoval = resolve;
      });
      const removalHasRoute = new Promise<void>((resolve) => {
        routeLocked = resolve;
      });
      const removal = env.db.transaction(async (tx) => {
        await disableEmailDomainRouteAndDrainTx(tx, added.routeId);
        routeLocked();
        await removalMayContinue;
        await tx
          .select({ id: emailZoneConnections.id })
          .from(emailZoneConnections)
          .where(eq(emailZoneConnections.id, before.connection.id))
          .for('update');
      });
      await removalHasRoute;

      const status = app.fetch(
        new Request(
          `http://localhost/projects/${project.id}/email/domains/status-removal.example.com`,
          { headers: { Authorization: `Bearer ${user.jwt}` } },
        ),
        bindings(),
      );
      try {
        await waitForPostgresLockWaiters(1);
        continueRemoval();
        const results = await Promise.allSettled([status, removal]);
        expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
        if (results[0]?.status !== 'fulfilled') {
          throw results[0]?.reason;
        }
        expect(results[0].value.status).toBe(200);
        expect(await results[0].value.json()).toMatchObject({ status: 'disabled' });

        const after = (await resolveEmailDomain(env.db, 'status-removal.example.com'))!;
        expect(after.route).toMatchObject({
          desired_state: 'disabled',
          inbound_status: 'disabled',
        });
        expect(after.connection.management_observed_at).toEqual(
          before.connection.management_observed_at,
        );
      } finally {
        continueRemoval();
        await Promise.allSettled([status, removal]);
      }
    },
    15_000,
  );

  it.runIf(Boolean(process.env.VOID_TEST_DATABASE_URL))(
    'keeps inbound probe read-back behind the route-to-connection removal lock order',
    async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'probe-removal-lock-order');
      let gateInboundProbe = false;
      let releaseProvider!: () => void;
      let providerEntered!: () => void;
      const providerMayReturn = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      const providerWasEntered = new Promise<void>((resolve) => {
        providerEntered = resolve;
      });
      stubCustomerCf({
        zones,
        on: {
          routingRulesGet: async () => {
            if (!gateInboundProbe) {
              return;
            }
            gateInboundProbe = false;
            providerEntered();
            await providerMayReturn;
          },
        },
      });
      const added = await requestEmailDomainAdd(env.db, bindings(), {
        projectId: project.id,
        domain: 'probe-removal.example.com',
        actor: { kind: 'owner', userId: user.id },
        token: TOKEN,
      });
      const before = (await resolveEmailDomain(env.db, 'probe-removal.example.com'))!;

      gateInboundProbe = true;
      const driver = runEmailOperation(env.db, bindings(), added.operationId);
      await providerWasEntered;

      let continueRemoval!: () => void;
      let routeLocked!: () => void;
      const removalMayContinue = new Promise<void>((resolve) => {
        continueRemoval = resolve;
      });
      const removalHasRoute = new Promise<void>((resolve) => {
        routeLocked = resolve;
      });
      const removal = env.db.transaction(async (tx) => {
        await disableEmailDomainRouteAndDrainTx(tx, added.routeId);
        routeLocked();
        await removalMayContinue;
        await tx
          .select({ id: emailZoneConnections.id })
          .from(emailZoneConnections)
          .where(eq(emailZoneConnections.id, before.connection.id))
          .for('update');
      });
      await removalHasRoute;

      try {
        releaseProvider();
        await waitForPostgresLockWaiters(1);
        continueRemoval();
        const results = await Promise.allSettled([driver, removal]);
        expect(results.every((result) => result.status === 'fulfilled')).toBe(true);

        const after = (await resolveEmailDomain(env.db, 'probe-removal.example.com'))!;
        expect(after.route).toMatchObject({
          desired_state: 'disabled',
          inbound_status: 'disabled',
        });
        expect(after.connection.inbound_status).toBe(before.connection.inbound_status);
        expect(
          (
            await env.db
              .select()
              .from(emailOperations)
              .where(eq(emailOperations.id, added.operationId))
          )[0]?.status,
        ).toBe('blocked');
      } finally {
        releaseProvider();
        continueRemoval();
        await Promise.allSettled([driver, removal]);
      }
    },
    15_000,
  );

  it.each(['applied', 'not-applied'] as const)(
    'finishes removal after an unknown setup is resolved as %s without resuming setup',
    async (outcome) => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'remove-unknown');
      const failures: { scriptPut?: { message: string; status: number } } = {
        scriptPut: { message: 'lost response', status: 504 },
      };
      const stub = stubCustomerCf({ zones, failOn: failures });
      const add = await requestEmailDomainAdd(env.db, bindings(), {
        projectId: project.id,
        domain: 'unknown.example.com',
        actor: { kind: 'owner', userId: user.id },
        token: TOKEN,
      });
      await runEmailOperation(env.db, bindings(), add.operationId);
      expect(
        (
          await env.db.select().from(emailOperations).where(eq(emailOperations.id, add.operationId))
        )[0]?.status,
      ).toBe('unknown');
      const remove = await requestEmailDomainRemove(env.db, bindings(), add.routeId, {
        kind: 'system',
      });
      expect((await resolveEmailDomain(env.db, 'unknown.example.com'))?.route.desired_state).toBe(
        'disabled',
      );
      await runEmailOperation(env.db, bindings(), remove);
      expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(0);
      await env.db.delete(projects).where(eq(projects.id, project.id));
      await env.db
        .update(emailOperationSteps)
        .set({
          started_at: new Date(
            Date.now() - EMAIL_OPERATION_RECOVERY_MIN_AGE_MS - 1_000,
          ).toISOString(),
        })
        .where(
          and(
            eq(emailOperationSteps.operation_id, add.operationId),
            eq(emailOperationSteps.status, 'unknown'),
          ),
        );
      const fence = await inspectUnknownEmailOperationRecovery(env.db, bindings(), add.operationId);
      expect(fence.step).toBe('ingress_deploy');
      const resolution = await resolveUnknownEmailOperation(env.db, bindings(), {
        ...fence,
        ended: true,
        outcome,
        reason: `Provider audit says the relay upload was ${outcome}`,
      });
      expect(resolution).toMatchObject({
        operationId: add.operationId,
        stepId: fence.stepId,
        status: 'completed',
        outcome,
      });
      expect(
        (
          await env.db.select().from(emailOperations).where(eq(emailOperations.id, add.operationId))
        )[0],
      ).toMatchObject({ status: 'completed', current_step: null });
      const predecessorSteps = await env.db
        .select()
        .from(emailOperationSteps)
        .where(eq(emailOperationSteps.operation_id, add.operationId))
        .orderBy(emailOperationSteps.ordinal);
      const resolvedStep = predecessorSteps.find((step) => step.id === fence.stepId)!;
      expect(resolvedStep).toMatchObject({
        status: 'confirmed',
        outcome: {
          operatorResolution: outcome,
          reason: `Provider audit says the relay upload was ${outcome}`,
          supersededByRemoval: remove,
        },
      });
      const skippedSteps = predecessorSteps.filter((step) => step.ordinal > resolvedStep.ordinal);
      expect(skippedSteps.length).toBeGreaterThan(0);
      expect(
        skippedSteps.every(
          (step) =>
            step.status === 'confirmed' &&
            (step.outcome as { skipped?: boolean; supersededByRemoval?: string } | null)
              ?.skipped === true &&
            (step.outcome as { skipped?: boolean; supersededByRemoval?: string } | null)
              ?.supersededByRemoval === remove,
        ),
      ).toBe(true);
      delete failures.scriptPut;
      await runEmailOperation(env.db, bindings(), add.operationId);
      await runEmailOperation(env.db, bindings(), remove);
      expect(
        (await env.db.select().from(emailOperations).where(eq(emailOperations.id, remove)))[0]
          ?.status,
      ).toBe('completed');
      expect((await resolveEmailDomain(env.db, 'unknown.example.com'))?.route.desired_state).toBe(
        'removed',
      );
      expect(callsByTag(stub.calls, 'scriptPut')).toHaveLength(1);
      expect(callsByTag(stub.calls, 'secretPut')).toHaveLength(0);
      expect(callsByTag(stub.calls, 'catchAll')).toHaveLength(0);
      expect(callsByTag(stub.calls, 'onboardSending')).toHaveLength(0);
      expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(1);
    },
  );

  it('finishes removal after Sending readback confirms a superseded setup', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'remove-sending-unknown');
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {
      onboardSending: { message: 'lost response', status: 504 },
      sendingSubdomainsGet: { message: 'readback unavailable', status: 504 },
    };
    const stub = stubCustomerCf({
      zones,
      failOn: failures,
      sendingSubdomains: [{ name: 'sending-removal.example.com', enabled: true }],
    });
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'sending-removal.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    expect(
      (
        await env.db.select().from(emailOperations).where(eq(emailOperations.id, add.operationId))
      )[0],
    ).toMatchObject({ status: 'unknown', current_step: 'sending_onboard' });

    const remove = await requestEmailDomainRemove(env.db, bindings(), add.routeId, {
      kind: 'system',
    });
    await env.db.delete(projects).where(eq(projects.id, project.id));
    expect(await reconcileUnknownEmailOperation(env.db, bindings(), add.operationId)).toBe(false);
    delete failures.sendingSubdomainsGet;
    expect(await reconcileUnknownEmailOperation(env.db, bindings(), add.operationId)).toBe(true);

    expect(
      (
        await env.db.select().from(emailOperations).where(eq(emailOperations.id, add.operationId))
      )[0],
    ).toMatchObject({ status: 'completed', current_step: null });
    expect(await resolveEmailDomain(env.db, 'sending-removal.example.com')).toMatchObject({
      route: { desired_state: 'disabled', outbound_status: 'pending' },
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    await runEmailOperation(env.db, bindings(), remove);

    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, remove)))[0]
        ?.status,
    ).toBe('completed');
    expect(
      (await resolveEmailDomain(env.db, 'sending-removal.example.com'))?.route.desired_state,
    ).toBe('removed');
    expect(callsByTag(stub.calls, 'onboardSending')).toHaveLength(1);
    expect(callsByTag(stub.calls, 'sendingSubdomainsGet')).toHaveLength(3);
    expect(callsByTag(stub.calls, 'scriptPut')).toHaveLength(1);
    expect(callsByTag(stub.calls, 'secretPut')).toHaveLength(1);
    expect(callsByTag(stub.calls, 'catchAll')).toHaveLength(2);
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(1);
  });

  it('runs a persisted system removal after its project row is gone', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'removed-owner');
    stubCustomerCf({ zones });
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'gone.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    await env.db.delete(projects).where(eq(projects.id, project.id));
    const remove = await requestEmailDomainRemove(env.db, bindings(), add.routeId, {
      kind: 'system',
    });
    await runEmailOperation(env.db, bindings(), remove);
    expect((await resolveEmailDomain(env.db, 'gone.example.com'))?.route.desired_state).toBe(
      'removed',
    );
  });

  it.each([
    { credentialStatus: 'healthy', interruptStep: null },
    { credentialStatus: 'expired', interruptStep: null },
    { credentialStatus: 'expired', interruptStep: 'catchall_detach' },
    { credentialStatus: 'expired', interruptStep: 'ingress_delete' },
  ] as const)(
    'keeps unrelated zone ingress with $credentialStatus credentials after interruption at $interruptStep',
    async ({ credentialStatus, interruptStep }) => {
      const user = await createTestUser(env.db);
      const first = await createTestProject(env.db, user.id, 'disabled-first');
      const second = await createTestProject(env.db, user.id, 'disabled-second');
      const stub = stubCustomerCf({ zones });
      const a = await requestEmailDomainAdd(env.db, bindings(), {
        projectId: first.id,
        domain: 'one.example.com',
        actor: { kind: 'owner', userId: user.id },
        token: TOKEN,
      });
      await runEmailOperation(env.db, bindings(), a.operationId);
      const b = await requestEmailDomainAdd(env.db, bindings(), {
        projectId: second.id,
        domain: 'two.example.com',
        actor: { kind: 'owner', userId: user.id },
        token: TOKEN,
      });
      await runEmailOperation(env.db, bindings(), b.operationId);
      await env.db
        .update(emailDomainRoutes)
        .set({ desired_state: 'disabled', inbound_status: 'disabled' })
        .where(eq(emailDomainRoutes.id, b.routeId));
      await env.db
        .update(emailCredentials)
        .set({ status: credentialStatus })
        .where(
          eq(
            emailCredentials.id,
            (await resolveEmailDomain(env.db, 'two.example.com'))!.connection.credential_id!,
          ),
        );
      const callsBeforeRemoval = stub.calls.length;
      const remove = await requestEmailDomainRemove(env.db, bindings(), a.routeId, {
        kind: 'owner',
        userId: user.id,
      });
      if (interruptStep) {
        const transaction = env.db.transaction.bind(env.db);
        const interrupted = vi.spyOn(env.db, 'transaction').mockImplementation(async (...args) => {
          const result = await transaction(...args);
          const [operation] = await env.db
            .select()
            .from(emailOperations)
            .where(eq(emailOperations.id, remove));
          if (operation?.current_step === interruptStep) {
            interrupted.mockRestore();
            throw new Error('driver exited after transaction commit');
          }
          return result;
        });
        await expect(runEmailOperation(env.db, bindings(), remove)).rejects.toThrow(
          'driver exited after transaction commit',
        );
        await env.db
          .update(emailOperationSteps)
          .set({ started_at: sql`now() - interval '25 hours'` })
          .where(eq(emailOperationSteps.operation_id, remove));
        await runEmailOperation(env.db, bindings(), remove);
        const fence = await inspectUnknownEmailOperationRecovery(env.db, bindings(), remove);
        await resolveUnknownEmailOperation(env.db, bindings(), {
          ...fence,
          ended: true,
          outcome: 'not-applied',
          reason:
            'Stub provider audit confirms the interrupted driver did not execute its deletion',
        });
      }
      await runEmailOperation(env.db, bindings(), remove);
      expect((await resolveEmailDomain(env.db, 'one.example.com'))?.route.desired_state).toBe(
        'removed',
      );
      expect(
        (await env.db.select().from(emailOperations).where(eq(emailOperations.id, remove)))[0]
          ?.status,
      ).toBe('completed');
      expect(stub.calls.length).toBeGreaterThan(callsBeforeRemoval);
      expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(1);
      expect((await resolveEmailDomain(env.db, 'two.example.com'))?.route.desired_state).toBe(
        'disabled',
      );
    },
  );

  it('defers destructive removal while an admitted provider attempt is live', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'active-send');
    const stub = stubCustomerCf({ zones });
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'active.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    await env.db.insert(emailUnresolvedAttempts).values({
      id: 'live-provider-test',
      project_id: project.id,
      sender_domain: 'active.example.com',
      started_at: new Date().toISOString(),
    });
    const remove = await requestEmailDomainRemove(env.db, bindings(), add.routeId, {
      kind: 'owner',
      userId: user.id,
    });
    await runEmailOperation(env.db, bindings(), remove);
    expect((await resolveEmailDomain(env.db, 'active.example.com'))?.route.desired_state).toBe(
      'disabled',
    );
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(0);
    expect(['pending', 'running']).toContain(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, remove)))[0]
        ?.status,
    );
    await env.db
      .delete(emailUnresolvedAttempts)
      .where(eq(emailUnresolvedAttempts.id, 'live-provider-test'));
    await runEmailOperation(env.db, bindings(), remove);
    expect((await resolveEmailDomain(env.db, 'active.example.com'))?.route.desired_state).toBe(
      'removed',
    );
  });

  it('re-adds a removed last route with a new credential, deployed secret, and cache version', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'readd-mail');
    const stub = stubCustomerCf({ zones });
    const actor = { kind: 'owner' as const, userId: user.id };
    const first = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'readd.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), first.operationId);
    const original = (await resolveEmailDomain(env.db, 'readd.example.com'))!;
    const removed = await requestEmailDomainRemove(env.db, bindings(), first.routeId, actor);
    await runEmailOperation(env.db, bindings(), removed);
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(1);
    expect(
      (await resolveEmailDomain(env.db, 'readd.example.com'))?.connection.credential_id,
    ).toBeNull();
    expect(await env.db.select().from(emailCredentials)).toHaveLength(0);
    await expect(requestEmailDomainSync(env.db, bindings(), first.routeId, actor)).rejects.toThrow(
      'must be active',
    );
    await flushEmailCacheOutbox(env.db, env.ROUTING);
    const cacheBase = `email-cache:route:${first.routeId}`;
    const removedVersion = Number(await env.ROUTING.get(`${cacheBase}:latest`));
    expect(JSON.parse((await env.ROUTING.get(`${cacheBase}:v${removedVersion}`))!).status).toBe(
      'removed',
    );

    const readded = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'readd.example.com',
      actor,
      token: TOKEN,
    });
    expect(readded.routeId).toBe(first.routeId);
    const pending = (await resolveEmailDomain(env.db, 'readd.example.com'))!;
    expect(pending.route.desired_generation).toBeGreaterThan(removedVersion);
    expect(pending.route.inbound_status).toBe('pending');
    expect(pending.route.outbound_status).toBe('pending');
    expect(pending.connection.credential_id).not.toBeNull();
    await runEmailOperation(env.db, bindings(), readded.operationId);
    expect(
      (
        await env.db
          .select()
          .from(emailOperations)
          .where(eq(emailOperations.id, readded.operationId))
      )[0]?.status,
    ).toBe('completed');
    expect(callsByTag(stub.calls, 'scriptPut')).toHaveLength(2);
    expect(callsByTag(stub.calls, 'secretPut')).toHaveLength(2);
    expect((await resolveEmailDomain(env.db, 'readd.example.com'))?.route.inbound_status).toBe(
      'ready',
    );
    await flushEmailCacheOutbox(env.db, env.ROUTING);
    const activeVersion = Number(await env.ROUTING.get(`${cacheBase}:latest`));
    expect(activeVersion).toBeGreaterThan(removedVersion);
    expect(JSON.parse((await env.ROUTING.get(`${cacheBase}:v${activeVersion}`))!).status).toBe(
      'active',
    );
    expect(original.connection.id).toBe(pending.connection.id);
    expect(await env.db.select().from(emailCacheOutbox)).toHaveLength(3);
  });

  it.each(['readd-staged.example.com'])(
    'retires a blocked rotation when the last removed connection is reused by %s',
    async (replacementDomain) => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'readd-staged-rotation');
      const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {};
      stubCustomerCf({ zones, failOn: failures });
      const actor = { kind: 'owner' as const, userId: user.id };
      const added = await requestEmailDomainAdd(env.db, bindings(), {
        projectId: project.id,
        domain: 'readd-staged.example.com',
        actor,
        token: TOKEN,
      });
      await runEmailOperation(env.db, bindings(), added.operationId);
      const original = (await resolveEmailDomain(env.db, 'readd-staged.example.com'))!.connection;
      const rotation = await requestEmailSecretRotation(env.db, bindings(), original.id, actor);
      failures.secretPut = { message: 'secret permission denied', status: 403 };
      await runEmailOperation(env.db, bindings(), rotation);
      const staged = (await resolveEmailDomain(env.db, 'readd-staged.example.com'))!.connection;
      expect(staged.staged_secret_generation).toBe(original.active_secret_generation + 1);

      const removal = await requestEmailDomainRemove(env.db, bindings(), added.routeId, actor);
      await runEmailOperation(env.db, bindings(), removal);
      expect(
        (await resolveEmailDomain(env.db, 'readd-staged.example.com'))?.route.desired_state,
      ).toBe('removed');
      expect(
        (await resolveEmailDomain(env.db, 'readd-staged.example.com'))?.connection
          .staged_secret_generation,
      ).toBe(staged.staged_secret_generation);

      delete failures.secretPut;
      const readded = await requestEmailDomainAdd(env.db, bindings(), {
        projectId: project.id,
        domain: replacementDomain,
        actor,
        token: 'readd-corrected-token',
        attemptId: 'readd-staged-attempt',
      });
      await runEmailOperation(env.db, bindings(), readded.operationId);

      const repaired = (await resolveEmailDomain(env.db, replacementDomain))!;
      expect(repaired.route.desired_state).toBe('active');
      expect(repaired.route.inbound_status).toBe('ready');
      expect(repaired.connection.active_secret_generation).toBe(original.active_secret_generation);
      expect(repaired.connection.staged_secret_generation).toBeNull();
      expect(repaired.connection.staged_secret_ciphertext).toBeNull();
      expect(
        (await env.db.select().from(emailOperations).where(eq(emailOperations.id, rotation)))[0]
          ?.status,
      ).toBe('blocked');
      const nextRotation = await requestEmailSecretRotation(env.db, bindings(), original.id, actor);
      await runEmailOperation(env.db, bindings(), nextRotation);
      expect(
        (await env.db.select().from(emailOperations).where(eq(emailOperations.id, nextRotation)))[0]
          ?.status,
      ).toBe('completed');
    },
  );

  it('retires a blocked rotation when a manager-retained connection reuses its zone apex', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'manager-retained-staged');
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {};
    const stub = stubCustomerCf({ zones, failOn: failures });
    const actor = { kind: 'owner' as const, userId: user.id };
    const added = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'manager-retained-staged.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), added.operationId);
    const original = (await resolveEmailDomain(env.db, 'manager-retained-staged.example.com'))!
      .connection;
    const rotation = await requestEmailSecretRotation(env.db, bindings(), original.id, actor);
    failures.secretPut = { message: 'secret permission denied', status: 403 };
    await runEmailOperation(env.db, bindings(), rotation);

    const removal = await requestEmailDomainRemove(env.db, bindings(), added.routeId, {
      kind: 'admin',
      userId: 'admin-actor',
    });
    await runEmailOperation(env.db, bindings(), removal);
    const retained = (await resolveEmailDomain(env.db, 'manager-retained-staged.example.com'))!;
    expect(retained.route.desired_state).toBe('removed');
    expect(retained.connection.inbound_status).toBe('ready');
    expect(retained.connection.staged_secret_generation).toBe(
      original.active_secret_generation + 1,
    );
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(0);

    delete failures.secretPut;
    const replacement = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'manager-retained-staged.example.com',
      actor,
      token: 'manager-retained-corrected-token',
    });
    await runEmailOperation(env.db, bindings(), replacement.operationId);

    const repaired = (await resolveEmailDomain(env.db, 'manager-retained-staged.example.com'))!;
    expect(repaired.route.inbound_status).toBe('ready');
    expect(repaired.connection.active_secret_generation).toBe(original.active_secret_generation);
    expect(repaired.connection.staged_secret_generation).toBeNull();
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, rotation)))[0]
        ?.status,
    ).toBe('blocked');
    const nextRotation = await requestEmailSecretRotation(env.db, bindings(), original.id, actor);
    await runEmailOperation(env.db, bindings(), nextRotation);
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, nextRotation)))[0]
        ?.status,
    ).toBe('completed');
  });

  it('does not reuse a blocked removal from an older route and connection generation', async () => {
    const user = await createTestUser(env.db, 'stale-removal-owner');
    const project = await createTestProject(env.db, user.id, 'stale-removal-project');
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {};
    stubCustomerCf({ zones, failOn: failures });
    const actor = { kind: 'owner' as const, userId: user.id };
    const added = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'stale-removal.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), added.operationId);

    failures.scriptDelete = { message: 'script delete permission denied', status: 403 };
    const staleRemoval = await requestEmailDomainRemove(env.db, bindings(), added.routeId, actor);
    await runEmailOperation(env.db, bindings(), staleRemoval);
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, staleRemoval)))[0],
    ).toMatchObject({ status: 'blocked', current_step: 'ingress_delete' });

    delete failures.scriptDelete;
    const reactivated = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'stale-removal.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), reactivated.operationId);
    const removal = await requestEmailDomainRemove(env.db, bindings(), added.routeId, actor);
    expect(removal).not.toBe(staleRemoval);
    await runEmailOperation(env.db, bindings(), removal);
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, staleRemoval)))[0]
        ?.status,
    ).toBe('blocked');
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, removal)))[0]
        ?.status,
    ).toBe('completed');
  });

  it('rejects new external MX records before reactivating a removed route', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'readd-mx-conflict');
    const mx: Record<string, Array<string>> = {};
    const stub = stubCustomerCf({ zones, mx });
    const actor = { kind: 'owner' as const, userId: user.id };
    const first = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'readd-conflict.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), first.operationId);
    const removed = await requestEmailDomainRemove(env.db, bindings(), first.routeId, actor);
    await runEmailOperation(env.db, bindings(), removed);
    const writes = stub.calls.filter((call) => call.method !== 'GET').length;
    mx['readd-conflict.example.com'] = ['route1.mx.cloudflare.net', 'mx.external.example.net'];

    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: project.id,
        domain: 'readd-conflict.example.com',
        actor,
        token: TOKEN,
      }),
    ).rejects.toThrow('already has MX');

    expect(stub.calls.filter((call) => call.method !== 'GET')).toHaveLength(writes);
    expect((await resolveEmailDomain(env.db, 'readd-conflict.example.com'))?.route).toMatchObject({
      desired_state: 'removed',
      inbound_status: 'disabled',
    });
  });

  it('retains the credential after an uncertain ingress delete until readback proves cleanup', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'unknown-delete');
    const existingScripts: Array<string> = [];
    const failures: { scriptDelete?: { message: string; status: number } } = {};
    const stub = stubCustomerCf({ zones, existingScripts, failOn: failures });
    const actor = { kind: 'owner' as const, userId: user.id };
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'unknown-delete.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    const connection = (await resolveEmailDomain(env.db, 'unknown-delete.example.com'))!.connection;
    existingScripts.push(connection.ingress_worker_name);
    const remove = await requestEmailDomainRemove(env.db, bindings(), add.routeId, actor);
    failures.scriptDelete = { message: 'response lost', status: 504 };
    await runEmailOperation(env.db, bindings(), remove);
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, remove)))[0]
        ?.status,
    ).toBe('unknown');
    expect(
      (await resolveEmailDomain(env.db, 'unknown-delete.example.com'))?.connection.credential_id,
    ).not.toBeNull();
    await reconcilePendingEmailOperations(env.db, bindings());
    expect(
      (await resolveEmailDomain(env.db, 'unknown-delete.example.com'))?.connection.credential_id,
    ).not.toBeNull();
    existingScripts.length = 0;
    delete failures.scriptDelete;
    await reconcilePendingEmailOperations(env.db, bindings());
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, remove)))[0]
        ?.status,
    ).toBe('completed');
    expect(
      (await resolveEmailDomain(env.db, 'unknown-delete.example.com'))?.connection.credential_id,
    ).toBeNull();
    expect(await env.db.select().from(emailCredentials)).toHaveLength(0);
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(1);
  });

  it('retries only an attested not-applied ingress delete and completes removal cleanup', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'not-applied-delete');
    const existingScripts: Array<string> = [];
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {};
    const stub = stubCustomerCf({ zones, existingScripts, failOn: failures });
    const actor = { kind: 'owner' as const, userId: user.id };
    const added = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'not-applied-delete.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), added.operationId);
    const connection = (await resolveEmailDomain(env.db, 'not-applied-delete.example.com'))!
      .connection;
    existingScripts.push(connection.ingress_worker_name);
    const removal = await requestEmailDomainRemove(env.db, bindings(), added.routeId, actor);
    failures.scriptDelete = { message: 'request ended before Cloudflare applied it', status: 504 };

    await runEmailOperation(env.db, bindings(), removal);

    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, removal)))[0]
        ?.status,
    ).toBe('unknown');
    const catchAllWrites = callsByTag(stub.calls, 'catchAll').length;
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(1);
    await reconcilePendingEmailOperations(env.db, bindings());
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(1);

    await env.db
      .update(emailOperationSteps)
      .set({
        started_at: new Date(
          Date.now() - EMAIL_OPERATION_RECOVERY_MIN_AGE_MS - 1_000,
        ).toISOString(),
      })
      .where(eq(emailOperationSteps.operation_id, removal));
    const fence = await inspectUnknownEmailOperationRecovery(env.db, bindings(), removal);
    expect(fence.step).toBe('ingress_delete');
    await resolveUnknownEmailOperation(env.db, bindings(), {
      ...fence,
      ended: true,
      outcome: 'not-applied',
      reason: 'Provider audit proves the Worker delete did not apply',
    });
    delete failures.scriptDelete;
    await runEmailOperation(env.db, bindings(), removal);

    const resolved = await resolveEmailDomain(env.db, 'not-applied-delete.example.com');
    expect(resolved?.route.desired_state).toBe('removed');
    expect(resolved?.connection).toMatchObject({
      inbound_status: 'disabled',
      credential_id: null,
    });
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(2);
    expect(callsByTag(stub.calls, 'catchAll')).toHaveLength(catchAllWrites);
  });

  it('transfers only a completed removed assignment and never exposes old operation history', async () => {
    const manager = await createTestUser(env.db, 'transfer-manager');
    const stranger = await createTestUser(env.db, 'transfer-stranger');
    const source = await createTestProject(env.db, manager.id, 'transfer-source');
    const target = await createTestProject(env.db, manager.id, 'transfer-target');
    const foreign = await createTestProject(env.db, stranger.id, 'transfer-foreign');
    stubCustomerCf({ zones });
    const actor = { kind: 'owner' as const, userId: manager.id };
    const first = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: source.id,
      domain: 'transfer.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), first.operationId);
    await flushEmailCacheOutbox(env.db, env.ROUTING);
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: target.id,
        domain: 'transfer.example.com',
        actor,
        token: TOKEN,
      }),
    ).rejects.toThrow('assigned to another project');
    const removed = await requestEmailDomainRemove(env.db, bindings(), first.routeId, actor);
    await runEmailOperation(env.db, bindings(), removed);
    await flushEmailCacheOutbox(env.db, env.ROUTING);
    const oldHint = await env.ROUTING.get(`email-cache:route:${first.routeId}:latest`);
    expect(oldHint).not.toBeNull();
    expect(
      JSON.parse((await env.ROUTING.get(`email-cache:route:${first.routeId}:v${oldHint}`))!).status,
    ).toBe('removed');
    expect(
      await resolveEmailIngress(env.db, {
        installationId: 'void-hosted',
        accountId: 'customer-account',
        zoneId: zones['transfer.example.com'].id,
        ingressName: (await resolveEmailDomain(env.db, 'transfer.example.com'))!.connection
          .ingress_worker_name,
        recipient: 'hello@transfer.example.com',
      }),
    ).toBeNull();
    await env.db.insert(emailUnresolvedAttempts).values({
      id: 'transfer-unresolved',
      project_id: source.id,
      sender_domain: 'transfer.example.com',
      started_at: new Date().toISOString(),
    });
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: target.id,
        domain: 'transfer.example.com',
        actor,
        token: TOKEN,
      }),
    ).rejects.toThrow('sends are unresolved');
    await env.db
      .delete(emailUnresolvedAttempts)
      .where(eq(emailUnresolvedAttempts.id, 'transfer-unresolved'));
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: foreign.id,
        domain: 'transfer.example.com',
        actor: { kind: 'owner', userId: stranger.id },
        token: TOKEN,
      }),
    ).rejects.toThrow('manager approval');

    const transfer = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: target.id,
      domain: 'transfer.example.com',
      actor,
      token: TOKEN,
    });
    expect(transfer.routeId).toBe(first.routeId);
    expect((await resolveEmailDomain(env.db, 'transfer.example.com'))?.route.project_id).toBe(
      target.id,
    );
    expect(await getEmailOperation(env.db, target.id, first.operationId)).toBeNull();
    expect(await getEmailOperation(env.db, source.id, transfer.operationId)).toBeNull();
    expect(
      (
        await env.db.select().from(emailOperations).where(eq(emailOperations.id, first.operationId))
      )[0],
    ).toBeTruthy();
    await runEmailOperation(env.db, bindings(), transfer.operationId);
    expect(
      (
        await env.db
          .select()
          .from(emailOperations)
          .where(eq(emailOperations.id, transfer.operationId))
      )[0]?.status,
    ).toBe('completed');
    const live = await resolveEmailIngress(env.db, {
      installationId: 'void-hosted',
      accountId: 'customer-account',
      zoneId: zones['transfer.example.com'].id,
      ingressName: (await resolveEmailDomain(env.db, 'transfer.example.com'))!.connection
        .ingress_worker_name,
      recipient: 'hello@transfer.example.com',
    });
    expect(live?.route.project_id).toBe(target.id);
    await flushEmailCacheOutbox(env.db, env.ROUTING);
    const newHint = await env.ROUTING.get(`email-cache:route:${first.routeId}:latest`);
    expect(Number(newHint)).toBeGreaterThan(Number(oldHint));
  });

  it('keeps independent apex removal progress separate from an unresolved zone write', async () => {
    const user = await createTestUser(env.db);
    const aProject = await createTestProject(env.db, user.id, 'queued-a');
    const bProject = await createTestProject(env.db, user.id, 'queued-b');
    stubCustomerCf({ zones });
    const a = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: aProject.id,
      domain: 'queue-a.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), a.operationId);
    const b = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: bProject.id,
      domain: 'queue-b.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), b.operationId);
    await env.db
      .update(emailOperations)
      .set({ status: 'unknown' })
      .where(eq(emailOperations.id, b.operationId));
    const removeA = await requestEmailDomainRemove(env.db, bindings(), a.routeId, {
      kind: 'system',
    });
    const removeB = await requestEmailDomainRemove(env.db, bindings(), b.routeId, {
      kind: 'system',
    });
    const queuedB = (
      await env.db.select().from(emailOperations).where(eq(emailOperations.id, removeB))
    )[0]!;
    expect(queuedB.current_step).toBe(`wait:${b.operationId}`);
    await runEmailOperation(env.db, bindings(), removeA);
    await runEmailOperation(env.db, bindings(), removeB);
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, removeB)))[0]
        ?.status,
    ).toBe('pending');
    // Represent an operator-proven resolution of the earlier ambiguous write.
    await env.db
      .update(emailOperations)
      .set({ status: 'completed' })
      .where(eq(emailOperations.id, b.operationId));
    await runEmailOperation(env.db, bindings(), removeA);
    await runEmailOperation(env.db, bindings(), removeB);
    expect((await resolveEmailDomain(env.db, 'queue-a.example.com'))?.route.desired_state).toBe(
      'removed',
    );
    expect((await resolveEmailDomain(env.db, 'queue-b.example.com'))?.route.desired_state).toBe(
      'removed',
    );
  });
  it('keeps independent apex ingress and credentials isolated when one zone is removed', async () => {
    const user = await createTestUser(env.db);
    const first = await createTestProject(env.db, user.id, 'first-mail');
    const second = await createTestProject(env.db, user.id, 'second-mail');
    const stub = stubCustomerCf({ zones });
    const a = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: first.id,
      domain: 'hr.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
      attemptId: 'first-attempt',
    });
    await runEmailOperation(env.db, bindings(), a.operationId);
    const aOp = (
      await env.db.select().from(emailOperations).where(eq(emailOperations.id, a.operationId))
    )[0]!;
    expect(aOp.status).toBe('completed');
    const b = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: second.id,
      domain: 'support.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
      attemptId: 'second-attempt',
    });
    await runEmailOperation(env.db, bindings(), b.operationId);
    const [aRoute, bRoute, connections] = await Promise.all([
      resolveEmailDomain(env.db, 'hr.example.com'),
      resolveEmailDomain(env.db, 'support.example.com'),
      env.db.select().from(emailZoneConnections),
    ]);
    expect(connections).toHaveLength(2);
    expect(aRoute?.connection.id).not.toBe(bRoute?.connection.id);
    expect(aRoute?.route.project_id).toBe(first.id);
    expect(bRoute?.route.project_id).toBe(second.id);
    expect(aRoute?.route.outbound_status).toBe('ready');
    expect(bRoute?.route.outbound_status).toBe('ready');
    expect(callsByTag(stub.calls, 'onboardSending')).toHaveLength(2);
    expect(callsByTag(stub.calls, 'scriptPut')).toHaveLength(2);
    const removed = await requestEmailDomainRemove(env.db, bindings(), a.routeId, {
      kind: 'owner',
      userId: user.id,
    });
    await runEmailOperation(env.db, bindings(), removed);
    expect((await resolveEmailDomain(env.db, 'hr.example.com'))?.route.desired_state).toBe(
      'removed',
    );
    expect((await resolveEmailDomain(env.db, 'support.example.com'))?.route.inbound_status).toBe(
      'ready',
    );
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(1);
    expect(
      (await resolveEmailDomain(env.db, 'support.example.com'))?.connection.credential_id,
    ).not.toBeNull();
  });

  it('commits step intent before provider writes and fences an ambiguous result', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'uncertain-mail');
    let observedIntent = false;
    const stub = stubCustomerCf({
      zones,
      on: {
        scriptPut: async () => {
          const steps = await env.db.select().from(emailOperationSteps);
          observedIntent = steps.some(
            (step) => step.kind === 'ingress_deploy' && step.status === 'in_flight',
          );
        },
      },
      failOn: { scriptPut: { message: 'upstream timeout', status: 504 } },
    });
    const requested = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'alerts.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
      attemptId: 'stable-key',
    });
    await runEmailOperation(env.db, bindings(), requested.operationId);
    const op = (
      await env.db
        .select()
        .from(emailOperations)
        .where(eq(emailOperations.id, requested.operationId))
    )[0]!;
    expect(observedIntent).toBe(true);
    expect(op.status).toBe('unknown');
    const writes = callsByTag(stub.calls, 'scriptPut').length;
    await reconcilePendingEmailOperations(env.db, bindings());
    expect(callsByTag(stub.calls, 'scriptPut')).toHaveLength(writes);
    const replay = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'alerts.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
      attemptId: 'stable-key',
    });
    expect(replay.operationId).toBe(requested.operationId);
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: project.id,
        domain: 'alerts.example.com',
        actor: { kind: 'owner', userId: user.id },
        token: 'different-token',
        attemptId: 'stable-key',
      }),
    ).rejects.toThrow('reused');
  });

  it('does not let a second driver invalidate an in-flight provider result', async () => {
    const user = await createTestUser(env.db),
      project = await createTestProject(env.db, user.id, 'race-mail');
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = new Promise<void>((resolve) => {
      entered = resolve;
    });
    stubCustomerCf({
      zones,
      on: {
        scriptPut: async () => {
          entered();
          await gate;
        },
      },
    });
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'race.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
    });
    const first = runEmailOperation(env.db, bindings(), add.operationId);
    await seen;
    await runEmailOperation(env.db, bindings(), add.operationId);
    expect(
      (
        await env.db.select().from(emailOperations).where(eq(emailOperations.id, add.operationId))
      )[0]?.status,
    ).toBe('running');
    release();
    await first;
    expect(
      (
        await env.db.select().from(emailOperations).where(eq(emailOperations.id, add.operationId))
      )[0]?.status,
    ).toBe('completed');
  });

  it.runIf(Boolean(process.env.VOID_TEST_DATABASE_URL))(
    'serializes late provider success with unknown-operation read-back',
    async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'late-success-mail');
      let gateSecretWrite = false;
      let releaseProvider!: () => void;
      let enteredProvider!: () => void;
      const providerMayReturn = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      const providerEntered = new Promise<void>((resolve) => {
        enteredProvider = resolve;
      });
      stubCustomerCf({
        zones,
        on: {
          secretPut: async () => {
            if (gateSecretWrite) {
              enteredProvider();
              await providerMayReturn;
            }
          },
        },
      });
      const actor = { kind: 'owner' as const, userId: user.id };
      const added = await requestEmailDomainAdd(env.db, bindings(), {
        projectId: project.id,
        domain: 'late-success.example.com',
        actor,
        token: TOKEN,
      });
      await runEmailOperation(env.db, bindings(), added.operationId);
      const connection = (await resolveEmailDomain(env.db, 'late-success.example.com'))!.connection;
      const operationId = await requestEmailSecretRotation(
        env.db,
        bindings(),
        connection.id,
        actor,
      );

      gateSecretWrite = true;
      const firstDriver = runEmailOperation(env.db, bindings(), operationId);
      await providerEntered;
      await env.db
        .update(emailOperationSteps)
        .set({ started_at: new Date(Date.now() - 10 * 60_000).toISOString() })
        .where(
          and(
            eq(emailOperationSteps.operation_id, operationId),
            eq(emailOperationSteps.status, 'in_flight'),
          ),
        );
      await runEmailOperation(env.db, bindings(), operationId);

      let releaseOperationLock!: () => void;
      let operationLocked!: () => void;
      const operationMayUnlock = new Promise<void>((resolve) => {
        releaseOperationLock = resolve;
      });
      const operationLockAcquired = new Promise<void>((resolve) => {
        operationLocked = resolve;
      });
      const operationBlocker = env.db.transaction(async (tx) => {
        await tx
          .select({ id: emailOperations.id })
          .from(emailOperations)
          .where(eq(emailOperations.id, operationId))
          .for('update');
        operationLocked();
        await operationMayUnlock;
      });
      await operationLockAcquired;

      let readBack: Promise<boolean> | undefined;
      try {
        releaseProvider();
        await waitForPostgresLockWaiters(1);
        readBack = reconcileUnknownEmailOperation(env.db, bindings(), operationId);
        await waitForPostgresLockWaiters(2);
        releaseOperationLock();

        const results = await Promise.allSettled([firstDriver, readBack, operationBlocker]);
        expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
        expect(
          (
            await env.db.select().from(emailOperations).where(eq(emailOperations.id, operationId))
          )[0]?.status,
        ).toBe('completed');
      } finally {
        releaseProvider();
        releaseOperationLock();
        await Promise.allSettled([firstDriver, operationBlocker, ...(readBack ? [readBack] : [])]);
      }
    },
    15_000,
  );

  it.runIf(Boolean(process.env.VOID_TEST_DATABASE_URL))(
    'serializes an expired lease with a late provider failure',
    async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'late-failure-mail');
      const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {};
      let gateSecretWrite = false;
      let releaseProvider!: () => void;
      let enteredProvider!: () => void;
      const providerMayReturn = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      const providerEntered = new Promise<void>((resolve) => {
        enteredProvider = resolve;
      });
      stubCustomerCf({
        zones,
        failOn: failures,
        on: {
          secretPut: async () => {
            if (gateSecretWrite) {
              enteredProvider();
              await providerMayReturn;
            }
          },
        },
      });
      const actor = { kind: 'owner' as const, userId: user.id };
      const added = await requestEmailDomainAdd(env.db, bindings(), {
        projectId: project.id,
        domain: 'late-failure.example.com',
        actor,
        token: TOKEN,
      });
      await runEmailOperation(env.db, bindings(), added.operationId);
      const connection = (await resolveEmailDomain(env.db, 'late-failure.example.com'))!.connection;
      const operationId = await requestEmailSecretRotation(
        env.db,
        bindings(),
        connection.id,
        actor,
      );
      failures.secretPut = { message: 'provider response ended late', status: 504 };

      gateSecretWrite = true;
      const firstDriver = runEmailOperation(env.db, bindings(), operationId);
      await providerEntered;
      await env.db
        .update(emailOperationSteps)
        .set({ started_at: new Date(Date.now() - 10 * 60_000).toISOString() })
        .where(
          and(
            eq(emailOperationSteps.operation_id, operationId),
            eq(emailOperationSteps.status, 'in_flight'),
          ),
        );

      let releaseOperationLock!: () => void;
      let operationLocked!: () => void;
      const operationMayUnlock = new Promise<void>((resolve) => {
        releaseOperationLock = resolve;
      });
      const operationLockAcquired = new Promise<void>((resolve) => {
        operationLocked = resolve;
      });
      const operationBlocker = env.db.transaction(async (tx) => {
        await tx
          .select({ id: emailOperations.id })
          .from(emailOperations)
          .where(eq(emailOperations.id, operationId))
          .for('update');
        operationLocked();
        await operationMayUnlock;
      });
      await operationLockAcquired;

      let expiryDriver: Promise<void> | undefined;
      try {
        expiryDriver = runEmailOperation(env.db, bindings(), operationId);
        await waitForPostgresLockWaiters(1);
        releaseProvider();
        await waitForPostgresLockWaiters(2);
        releaseOperationLock();

        const results = await Promise.allSettled([firstDriver, expiryDriver, operationBlocker]);
        expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
        const operation = (
          await env.db.select().from(emailOperations).where(eq(emailOperations.id, operationId))
        )[0];
        const step = (
          await env.db
            .select()
            .from(emailOperationSteps)
            .where(eq(emailOperationSteps.operation_id, operationId))
            .orderBy(emailOperationSteps.ordinal)
        )[0];
        expect(operation).toMatchObject({ status: 'unknown', current_step: 'secret_put' });
        expect(step).toMatchObject({ status: 'unknown', failure_code: 'outcome_unknown' });
      } finally {
        releaseProvider();
        releaseOperationLock();
        await Promise.allSettled([
          firstDriver,
          operationBlocker,
          ...(expiryDriver ? [expiryDriver] : []),
        ]);
      }
    },
    15_000,
  );

  it.runIf(Boolean(process.env.VOID_TEST_DATABASE_URL))(
    'keeps operator recovery ineligible for 24 real hours under a non-UTC process timezone',
    async () => {
      const previousTimezone = process.env.TZ;
      process.env.TZ = 'Asia/Singapore';
      try {
        const user = await createTestUser(env.db);
        const project = await createTestProject(env.db, user.id, 'recovery-timezone-mail');
        stubCustomerCf({
          zones,
          failOn: { scriptPut: { message: 'provider response lost', status: 504 } },
        });
        const added = await requestEmailDomainAdd(env.db, bindings(), {
          projectId: project.id,
          domain: 'recovery-timezone.example.com',
          actor: { kind: 'owner', userId: user.id },
          token: TOKEN,
        });
        await runEmailOperation(env.db, bindings(), added.operationId);
        await env.db
          .update(emailOperationSteps)
          .set({ started_at: sql`now() - interval '23 hours'` })
          .where(
            and(
              eq(emailOperationSteps.operation_id, added.operationId),
              eq(emailOperationSteps.status, 'unknown'),
            ),
          );

        const fence = await inspectUnknownEmailOperationRecovery(
          env.db,
          bindings(),
          added.operationId,
        );
        expect(Date.parse(fence.eligibleAt)).toBeGreaterThan(Date.now());
        await expect(
          resolveUnknownEmailOperation(env.db, bindings(), {
            ...fence,
            ended: true,
            outcome: 'not-applied',
            reason: 'Provider audit completed before the minimum recovery age',
          }),
        ).rejects.toThrow('cannot be resolved before');
      } finally {
        if (previousTimezone === undefined) {
          delete process.env.TZ;
        } else {
          process.env.TZ = previousTimezone;
        }
      }
    },
    15_000,
  );

  it('promotes a rotated secret only after the gateway accepts it', async () => {
    const user = await createTestUser(env.db),
      project = await createTestProject(env.db, user.id, 'rotation-mail');
    const failures: { gatewayProbe?: { message: string; status: number } } = {};
    const stub = stubCustomerCf({ zones, failOn: failures });
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'rotate.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    const route = (await resolveEmailDomain(env.db, 'rotate.example.com'))!;
    const before = route.connection.active_secret_generation;
    const operationId = await requestEmailSecretRotation(env.db, bindings(), route.connection.id, {
      kind: 'owner',
      userId: user.id,
    });
    failures.gatewayProbe = { message: 'gateway refused secret', status: 403 };
    await runEmailOperation(env.db, bindings(), operationId);
    const pending = (
      await env.db
        .select()
        .from(emailZoneConnections)
        .where(eq(emailZoneConnections.id, route.connection.id))
    )[0]!;
    expect(pending.active_secret_generation).toBe(before);
    expect(pending.staged_secret_generation).toBe(before + 1);
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, operationId)))[0]
        ?.status,
    ).toBe('unknown');
    delete failures.gatewayProbe;
    await reconcilePendingEmailOperations(env.db, bindings());
    const promoted = (
      await env.db
        .select()
        .from(emailZoneConnections)
        .where(eq(emailZoneConnections.id, route.connection.id))
    )[0]!;
    expect(promoted.active_secret_generation).toBe(before + 1);
    expect(promoted.staged_secret_generation).toBeNull();
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, operationId)))[0]
        ?.status,
    ).toBe('completed');
    expect(callsByTag(stub.calls, 'secretPut')).toHaveLength(2);
  });

  it('blocks secret rotation before the provider write when its credential is unavailable', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rotation-credential-preflight');
    const stub = stubCustomerCf({ zones });
    const actor = { kind: 'owner' as const, userId: user.id };
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'rotation-credential.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    const connection = (await resolveEmailDomain(env.db, 'rotation-credential.example.com'))!
      .connection;
    const operationId = await requestEmailSecretRotation(
      env.db,
      bindings(),
      connection.id,
      actor,
      'credential-preflight-rotation',
    );
    await env.db
      .update(emailCredentials)
      .set({ status: 'revoked' })
      .where(eq(emailCredentials.id, connection.credential_id!));
    const writesBefore = callsByTag(stub.calls, 'secretPut').length;

    await runEmailOperation(env.db, bindings(), operationId);

    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, operationId)))[0],
    ).toMatchObject({ status: 'blocked', current_step: 'secret_put', failure_code: 'blocked' });
    expect(callsByTag(stub.calls, 'secretPut')).toHaveLength(writesBefore);

    await env.db
      .update(emailCredentials)
      .set({ status: 'healthy' })
      .where(eq(emailCredentials.id, connection.credential_id!));
    expect(
      await requestEmailSecretRotation(
        env.db,
        bindings(),
        connection.id,
        actor,
        'credential-preflight-rotation',
      ),
    ).toBe(operationId);
    await runEmailOperation(env.db, bindings(), operationId);

    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, operationId)))[0]
        ?.status,
    ).toBe('completed');
    expect(callsByTag(stub.calls, 'secretPut')).toHaveLength(writesBefore + 1);
  });

  it('recovers a lost secret PUT response by proving the staged deployed value', async () => {
    const user = await createTestUser(env.db),
      project = await createTestProject(env.db, user.id, 'lost-rotation');
    const failures: { secretPut?: { message: string; status: number } } = {};
    const stub = stubCustomerCf({ zones, failOn: failures });
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'lost.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    const connection = (await resolveEmailDomain(env.db, 'lost.example.com'))!.connection;
    const rotation = await requestEmailSecretRotation(env.db, bindings(), connection.id, {
      kind: 'owner',
      userId: user.id,
    });
    failures.secretPut = { message: 'response lost', status: 504 };
    await runEmailOperation(env.db, bindings(), rotation);
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, rotation)))[0]
        ?.status,
    ).toBe('unknown');
    delete failures.secretPut;
    await reconcilePendingEmailOperations(env.db, bindings());
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, rotation)))[0]
        ?.status,
    ).toBe('completed');
    expect(callsByTag(stub.calls, 'secretPut')).toHaveLength(2);
  });

  it('retries an attested not-applied secret write with the same staged generation', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'not-applied-rotation');
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {};
    const failBeforeEffect: Array<'secretPut'> = [];
    const stub = stubCustomerCf({ zones, failOn: failures, failBeforeEffect });
    const actor = { kind: 'owner' as const, userId: user.id };
    const added = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'not-applied-rotation.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), added.operationId);
    const before = (await resolveEmailDomain(env.db, 'not-applied-rotation.example.com'))!
      .connection;
    const setupSecretWrites = callsByTag(stub.calls, 'secretPut').length;
    const setupScriptWrites = callsByTag(stub.calls, 'scriptPut').length;
    const rotation = await requestEmailSecretRotation(env.db, bindings(), before.id, actor);
    failures.secretPut = { message: 'request ended before Cloudflare applied it', status: 504 };
    failBeforeEffect.push('secretPut');

    await runEmailOperation(env.db, bindings(), rotation);

    const staged = (
      await env.db.select().from(emailZoneConnections).where(eq(emailZoneConnections.id, before.id))
    )[0]!;
    expect(staged.staged_secret_generation).toBe(before.active_secret_generation + 1);
    await reconcilePendingEmailOperations(env.db, bindings());
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, rotation)))[0]
        ?.status,
    ).toBe('unknown');
    expect(callsByTag(stub.calls, 'secretPut')).toHaveLength(setupSecretWrites + 1);

    await env.db
      .update(emailOperationSteps)
      .set({
        started_at: new Date(
          Date.now() - EMAIL_OPERATION_RECOVERY_MIN_AGE_MS - 1_000,
        ).toISOString(),
      })
      .where(eq(emailOperationSteps.operation_id, rotation));
    const fence = await inspectUnknownEmailOperationRecovery(env.db, bindings(), rotation);
    expect(fence).toMatchObject({
      step: 'secret_put',
      desiredGeneration: staged.desired_generation,
      routeId: null,
      routeDesiredGeneration: null,
    });
    expect(fence.resourceIdentity).toContain(`/secret/${staged.staged_secret_generation}`);
    await resolveUnknownEmailOperation(env.db, bindings(), {
      ...fence,
      ended: true,
      outcome: 'not-applied',
      reason: 'Provider audit proves the secret write did not apply',
    });
    delete failures.secretPut;
    failBeforeEffect.length = 0;
    await runEmailOperation(env.db, bindings(), rotation);

    const promoted = (
      await env.db.select().from(emailZoneConnections).where(eq(emailZoneConnections.id, before.id))
    )[0]!;
    expect(promoted.active_secret_generation).toBe(staged.staged_secret_generation);
    expect(promoted.staged_secret_generation).toBeNull();
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, rotation)))[0]
        ?.status,
    ).toBe('completed');
    expect(callsByTag(stub.calls, 'secretPut')).toHaveLength(setupSecretWrites + 2);
    expect(callsByTag(stub.calls, 'scriptPut')).toHaveLength(setupScriptWrites);
  });

  it('resumes a blocked secret rotation without replacing its staged generation', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'blocked-rotation');
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {};
    const stub = stubCustomerCf({ zones, failOn: failures });
    const actor = { kind: 'owner' as const, userId: user.id };
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'blocked-rotation.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    const before = (await resolveEmailDomain(env.db, 'blocked-rotation.example.com'))!.connection;
    const rotation = await requestEmailSecretRotation(env.db, bindings(), before.id, actor);
    failures.secretPut = { message: 'secret permission denied', status: 403 };
    await runEmailOperation(env.db, bindings(), rotation);
    const staged = (
      await env.db.select().from(emailZoneConnections).where(eq(emailZoneConnections.id, before.id))
    )[0]!;
    expect(staged.staged_secret_generation).toBe(before.active_secret_generation + 1);
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, rotation)))[0],
    ).toMatchObject({ status: 'blocked', current_step: 'secret_put' });

    delete failures.secretPut;
    const resumed = await requestEmailSecretRotation(env.db, bindings(), before.id, actor);
    expect(resumed).toBe(rotation);
    await runEmailOperation(env.db, bindings(), resumed);
    const promoted = (
      await env.db.select().from(emailZoneConnections).where(eq(emailZoneConnections.id, before.id))
    )[0]!;
    expect(promoted.active_secret_generation).toBe(before.active_secret_generation + 1);
    expect(promoted.staged_secret_generation).toBeNull();
    expect(callsByTag(stub.calls, 'secretPut')).toHaveLength(3);
  });

  it('retires a blocked rotation through domain sync before allowing the next rotation', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'sync-staged-rotation');
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {};
    stubCustomerCf({ zones, failOn: failures });
    const actor = { kind: 'owner' as const, userId: user.id };
    const added = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'sync-staged-rotation.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), added.operationId);
    const connection = (await resolveEmailDomain(env.db, 'sync-staged-rotation.example.com'))!
      .connection;
    const blockedKey = 'sync-staged-blocked-rotation';
    const blockedRotation = await requestEmailSecretRotation(
      env.db,
      bindings(),
      connection.id,
      actor,
      blockedKey,
    );
    failures.secretPut = { message: 'secret permission denied', status: 403 };
    await runEmailOperation(env.db, bindings(), blockedRotation);
    const staged = (await resolveEmailDomain(env.db, 'sync-staged-rotation.example.com'))!
      .connection;
    expect(staged.staged_secret_generation).toBe(connection.active_secret_generation + 1);

    delete failures.secretPut;
    const sync = await requestEmailDomainSync(env.db, bindings(), added.routeId, actor);
    await runEmailOperation(env.db, bindings(), sync);
    const repaired = (await resolveEmailDomain(env.db, 'sync-staged-rotation.example.com'))!
      .connection;
    expect(repaired.active_secret_generation).toBe(connection.active_secret_generation);
    expect(repaired.staged_secret_generation).toBeNull();
    expect(
      (
        await env.db.select().from(emailOperations).where(eq(emailOperations.id, blockedRotation))
      )[0]?.status,
    ).toBe('blocked');
    expect(
      await requestEmailSecretRotation(env.db, bindings(), connection.id, actor, blockedKey),
    ).toBe(blockedRotation);

    const nextRotation = await requestEmailSecretRotation(env.db, bindings(), connection.id, actor);
    await runEmailOperation(env.db, bindings(), nextRotation);
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, nextRotation)))[0]
        ?.status,
    ).toBe('completed');
  });

  it('rejects a fresh secret rotation while the connection setup is pending', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pending-rotation');
    const actor = { kind: 'owner' as const, userId: user.id };
    stubCustomerCf({
      zones,
      failOn: { routingDns: { message: 'routing permission denied', status: 403 } },
    });
    const added = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'pending-rotation.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), added.operationId);
    const connection = (await resolveEmailDomain(env.db, 'pending-rotation.example.com'))!
      .connection;

    await expect(
      requestEmailSecretRotation(env.db, bindings(), connection.id, actor),
    ).rejects.toThrow('must be ready');
    expect(
      (
        await env.db
          .select()
          .from(emailZoneConnections)
          .where(eq(emailZoneConnections.id, connection.id))
      )[0],
    ).toMatchObject({
      desired_generation: connection.desired_generation,
      staged_secret_generation: null,
    });
  });

  it('repairs a blocked rotation with a corrected credential before retiring its staged secret', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rotation-credential-repair');
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {};
    stubCustomerCf({ zones, failOn: failures });
    const actor = { kind: 'owner' as const, userId: user.id };
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'rotation-repair.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    const before = (await resolveEmailDomain(env.db, 'rotation-repair.example.com'))!.connection;
    const rotation = await requestEmailSecretRotation(env.db, bindings(), before.id, actor);
    failures.secretPut = { message: 'replacement token lacks secret permission', status: 403 };
    await runEmailOperation(env.db, bindings(), rotation);
    const staged = (await resolveEmailDomain(env.db, 'rotation-repair.example.com'))!.connection;
    expect(staged.staged_secret_generation).toBe(before.active_secret_generation + 1);
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, rotation)))[0],
    ).toMatchObject({ status: 'blocked', current_step: 'secret_put' });

    delete failures.secretPut;
    failures.gatewayProbe = { message: 'gateway proof temporarily unavailable', status: 503 };
    const replacementInput = {
      projectId: project.id,
      domain: 'rotation-repair.example.com',
      actor,
      token: 'corrected-rotation-token',
      attemptId: 'replacement-rotation-credential',
    };
    const repair = await requestEmailDomainAdd(env.db, bindings(), replacementInput);
    expect(await requestEmailDomainAdd(env.db, bindings(), replacementInput)).toEqual(repair);
    await runEmailOperation(env.db, bindings(), repair.operationId);

    expect(
      (
        await env.db
          .select()
          .from(emailOperations)
          .where(eq(emailOperations.id, repair.operationId))
      )[0],
    ).toMatchObject({ status: 'unknown', current_step: 'gateway_probe' });
    const awaitingProof = (await resolveEmailDomain(env.db, 'rotation-repair.example.com'))!
      .connection;
    expect(awaitingProof.active_secret_generation).toBe(before.active_secret_generation);
    expect(awaitingProof.staged_secret_generation).toBe(staged.staged_secret_generation);

    delete failures.gatewayProbe;
    await reconcilePendingEmailOperations(env.db, bindings());

    const repaired = (await resolveEmailDomain(env.db, 'rotation-repair.example.com'))!.connection;
    expect(repaired.active_secret_generation).toBe(before.active_secret_generation);
    expect(repaired.staged_secret_generation).toBeNull();
    expect(repaired.staged_secret_ciphertext).toBeNull();
    expect(
      (
        await env.db
          .select()
          .from(emailOperations)
          .where(eq(emailOperations.id, repair.operationId))
      )[0]?.status,
    ).toBe('completed');
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, rotation)))[0]
        ?.status,
    ).toBe('blocked');
    expect(
      await env.db
        .select({ kind: emailOperationSteps.kind })
        .from(emailOperationSteps)
        .where(eq(emailOperationSteps.operation_id, repair.operationId))
        .orderBy(emailOperationSteps.ordinal),
    ).toContainEqual({ kind: 'secret_retire' });
  });

  it('resumes a blocked removal without changing its route generation', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'blocked-removal');
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {};
    const stub = stubCustomerCf({ zones, failOn: failures });
    const actor = { kind: 'owner' as const, userId: user.id };
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'blocked-removal.example.com',
      actor,
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);

    failures.scriptDelete = { message: 'script delete permission denied', status: 403 };
    const removalKey = 'blocked-removal-attempt';
    const removal = await requestEmailDomainRemove(
      env.db,
      bindings(),
      add.routeId,
      actor,
      removalKey,
    );
    await runEmailOperation(env.db, bindings(), removal);
    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, removal)))[0],
    ).toMatchObject({ status: 'blocked', current_step: 'ingress_delete' });
    const disabled = (await resolveEmailDomain(env.db, 'blocked-removal.example.com'))!.route;
    expect(disabled.desired_state).toBe('disabled');
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(1);

    delete failures.scriptDelete;
    expect(await requestEmailDomainRemove(env.db, bindings(), add.routeId, actor, removalKey)).toBe(
      removal,
    );
    expect(
      (await resolveEmailDomain(env.db, 'blocked-removal.example.com'))!.route.desired_generation,
    ).toBe(disabled.desired_generation);
    await runEmailOperation(env.db, bindings(), removal);

    expect(
      (await env.db.select().from(emailOperations).where(eq(emailOperations.id, removal)))[0]
        ?.status,
    ).toBe('completed');
    expect(
      (await resolveEmailDomain(env.db, 'blocked-removal.example.com'))!.route.desired_state,
    ).toBe('removed');
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(2);
  });

  it('does not replace a foreign zone catch-all', async () => {
    const user = await createTestUser(env.db),
      project = await createTestProject(env.db, user.id, 'foreign-mail');
    const stub = stubCustomerCf({
      zones,
      catchAllRule: { enabled: true, workerName: 'somebody-else' },
    });
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: project.id,
        domain: 'foreign.example.com',
        actor: { kind: 'owner', userId: user.id },
        token: TOKEN,
      }),
    ).rejects.toThrow('unrelated catch-all');
    expect(callsByTag(stub.calls, 'scriptPut')).toHaveLength(0);
    expect(callsByTag(stub.calls, 'catchAll')).toHaveLength(0);
  });

  it('does not install catch-all until the gateway accepts the zone secret', async () => {
    const user = await createTestUser(env.db),
      project = await createTestProject(env.db, user.id, 'gateway-refusal');
    const stub = stubCustomerCf({
      zones,
      failOn: { gatewayProbe: { message: 'refused', status: 403 } },
    });
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'refused.example.com',
      actor: { kind: 'owner', userId: user.id },
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    expect(
      (
        await env.db.select().from(emailOperations).where(eq(emailOperations.id, add.operationId))
      )[0]?.status,
    ).toBe('unknown');
    expect((await resolveEmailDomain(env.db, 'refused.example.com'))?.route.inbound_status).toBe(
      'pending',
    );
    expect(callsByTag(stub.calls, 'relayProbe')).toHaveLength(1);
    expect(callsByTag(stub.calls, 'catchAll')).toHaveLength(0);
  });

  it('keeps the installation gateway Worker when a custom sibling is added, synced and removed', async () => {
    const owner = await createTestUser(env.db),
      project = await createTestProject(env.db, owner.id, 'shared-sibling');
    const shared = {
      ...bindings(),
      EMAIL_SENDER_DOMAIN: 'mail.example.com',
      EMAIL_SHARED_ACCOUNT_ID: env.CF_ACCOUNT_ID,
      EMAIL_SHARED_ZONE_ID: 'platform-mail-zone',
      EMAIL_SHARED_INGRESS_NAME: 'void-email-gateway',
    } as ApiEnv['Bindings'];
    const stub = stubCustomerCf({
      zones: {
        'example.com': {
          id: 'platform-mail-zone',
          name: 'example.com',
          accountId: env.CF_ACCOUNT_ID,
        },
      },
      mx: { 'mail.example.com': ['route1.mx.cloudflare.net'] },
    });
    const bootstrap = await ensureSharedEmailConnection(env.db, shared);
    expect(bootstrap).toBeTruthy();
    await runEmailOperation(env.db, shared, bootstrap!);
    const added = await requestEmailDomainAdd(env.db, shared, {
      projectId: project.id,
      domain: 'example.com',
      actor: { kind: 'admin', userId: owner.id },
    });
    await runEmailOperation(env.db, shared, added.operationId);
    const route = await resolveEmailDomain(env.db, 'example.com');
    expect(route?.route.inbound_status).toBe('ready');
    expect(route?.route.outbound_status).toBe('ready');
    expect(route?.connection.ingress_worker_name).toBe('void-email-gateway');
    const nativeRoute = await resolveEmailIngress(env.db, {
      installationId: 'void-hosted',
      accountId: env.CF_ACCOUNT_ID,
      zoneId: 'platform-mail-zone',
      ingressName: 'void-email-gateway',
      recipient: 'inbox@example.com',
    });
    expect(nativeRoute?.route.project_id).toBe(project.id);
    expect(nativeRoute?.route.addressing).toBe('custom');
    const sync = await requestEmailDomainSync(env.db, shared, added.routeId, {
      kind: 'admin',
      userId: owner.id,
    });
    await runEmailOperation(env.db, shared, sync);
    const retried = await requestEmailDomainAdd(env.db, shared, {
      projectId: project.id,
      domain: 'example.com',
      actor: { kind: 'admin', userId: owner.id },
      attemptId: 'shared-active-retry',
    });
    await runEmailOperation(env.db, shared, retried.operationId);
    await expect(
      requestEmailSecretRotation(env.db, shared, route!.connection.id, {
        kind: 'admin',
        userId: owner.id,
      }),
    ).rejects.toThrow('managed by platform deployment');
    const remove = await requestEmailDomainRemove(env.db, shared, added.routeId, {
      kind: 'admin',
      userId: owner.id,
    });
    await runEmailOperation(env.db, shared, remove);
    const readded = await requestEmailDomainAdd(env.db, shared, {
      projectId: project.id,
      domain: 'example.com',
      actor: { kind: 'admin', userId: owner.id },
      attemptId: 'shared-removed-retry',
    });
    await runEmailOperation(env.db, shared, readded.operationId);
    expect((await resolveEmailDomain(env.db, 'example.com'))?.route.inbound_status).toBe('ready');
    const finalRemove = await requestEmailDomainRemove(env.db, shared, added.routeId, {
      kind: 'admin',
      userId: owner.id,
    });
    await runEmailOperation(env.db, shared, finalRemove);
    const removedRoute = (await resolveEmailDomain(env.db, 'example.com'))!.route;
    expect(removedRoute.desired_state).toBe('removed');
    expect(
      await env.db.transaction((tx) => disableEmailDomainRouteAndDrainTx(tx, removedRoute.id)),
    ).toEqual({
      cancelled: 0,
      inFlight: 0,
    });
    const repeatedRemoval = (await resolveEmailDomain(env.db, 'example.com'))!.route;
    expect(repeatedRemoval.desired_state).toBe('removed');
    expect(repeatedRemoval.desired_generation).toBe(removedRoute.desired_generation);
    expect(callsByTag(stub.calls, 'scriptPut')).toHaveLength(0);
    expect(callsByTag(stub.calls, 'secretPut')).toHaveLength(0);
    expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(0);
    expect((await resolveEmailDomain(env.db, 'mail.example.com'))?.route.desired_state).toBe(
      'active',
    );
  });

  it('rejects another project claiming an assigned apex and blocks credential renewal while outcome is unknown', async () => {
    const manager = await createTestUser(env.db, 'zone-manager'),
      other = await createTestUser(env.db, 'zone-other');
    const first = await createTestProject(env.db, manager.id, 'manager-project'),
      second = await createTestProject(env.db, other.id, 'other-project');
    const failures: { secretPut?: { message: string; status: number } } = {};
    stubCustomerCf({ zones, failOn: failures });
    const add = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: first.id,
      domain: 'manager.example.com',
      actor: { kind: 'owner', userId: manager.id },
      token: TOKEN,
    });
    await runEmailOperation(env.db, bindings(), add.operationId);
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: second.id,
        domain: 'manager.example.com',
        actor: { kind: 'owner', userId: other.id },
        token: TOKEN,
      }),
    ).rejects.toThrow('assigned to another project');
    const connection = (await resolveEmailDomain(env.db, 'manager.example.com'))!.connection;
    const rotation = await requestEmailSecretRotation(env.db, bindings(), connection.id, {
      kind: 'owner',
      userId: manager.id,
    });
    failures.secretPut = { message: 'unknown write', status: 504 };
    await runEmailOperation(env.db, bindings(), rotation);
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: first.id,
        domain: 'manager.example.com',
        actor: { kind: 'owner', userId: manager.id },
        token: 'renewed-token',
      }),
    ).rejects.toThrow('unresolved');
  });
});

describe('outbound-only email domains', () => {
  // Microsoft 365 / Google Workspace keep the apex MX; Void only onboards Email Sending.
  const FOREIGN_MX = { 'outbound.example.com': ['brand-example.mail.protection.outlook.com'] };
  const INBOUND_TAGS = [
    'mxLookup',
    'routingDns',
    'routingSettingsGet',
    'routingRulesGet',
    'catchAll',
    'catchAllGet',
    'scriptGet',
    'scriptPut',
    'secretPut',
    'scriptDelete',
    'subaddressing',
    'relayProbe',
    'gatewayProbe',
  ] as const;
  const inboundCalls = (calls: Parameters<typeof callsByTag>[0]) =>
    INBOUND_TAGS.flatMap((tag) => callsByTag(calls, tag));
  const stepKinds = async (operationId: string) =>
    (
      await env.db
        .select({ kind: emailOperationSteps.kind })
        .from(emailOperationSteps)
        .where(eq(emailOperationSteps.operation_id, operationId))
        .orderBy(emailOperationSteps.ordinal)
    ).map((step) => step.kind);

  it('onboards only Email Sending on an apex whose MX belongs to another provider', async () => {
    const admin = await createTestUser(env.db);
    const project = await createTestProject(env.db, admin.id, 'outbound-only');
    const sendingSubdomains: Array<{ name: string; enabled: boolean }> = [];
    const stub = stubCustomerCf({ zones, mx: FOREIGN_MX, sendingSubdomains });
    const actor = { kind: 'admin' as const, userId: admin.id };
    const added = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'outbound.example.com',
      token: TOKEN,
      actor,
      inboundMode: 'none',
    });
    await runEmailOperation(env.db, bindings(), added.operationId);

    const operation = await getEmailOperation(env.db, project.id, added.operationId);
    expect(operation?.operation.status).toBe('completed');
    expect(await stepKinds(added.operationId)).toEqual(['sending_onboard', 'publish']);
    const resolved = await resolveEmailDomain(env.db, 'outbound.example.com');
    expect(resolved?.route).toMatchObject({
      inbound_mode: 'none',
      inbound_status: 'disabled',
      inbound_reason: expect.stringContaining('Outbound only'),
      outbound_status: 'ready',
      managed_by: 'admin',
    });
    expect(callsByTag(stub.calls, 'sendingPreview')).toHaveLength(1);
    expect(callsByTag(stub.calls, 'onboardSending')).toHaveLength(1);
    expect(inboundCalls(stub.calls)).toEqual([]);
    await expect(
      resolveEmailIngress(env.db, {
        installationId: 'void-hosted',
        accountId: 'customer-account',
        zoneId: zones['outbound.example.com'].id,
        ingressName: resolved!.connection.ingress_worker_name,
        recipient: 'support@outbound.example.com',
      }),
    ).resolves.toBeNull();

    // A sync keeps to the same two steps and skips the preview once the domain is onboarded.
    sendingSubdomains.push({ name: 'outbound.example.com', enabled: true });
    const sync = await requestEmailDomainSync(env.db, bindings(), added.routeId, actor);
    await runEmailOperation(env.db, bindings(), sync);
    expect((await getEmailOperation(env.db, project.id, sync))?.operation.status).toBe('completed');
    expect(await stepKinds(sync)).toEqual(['sending_onboard', 'publish']);
    expect(callsByTag(stub.calls, 'sendingPreview')).toHaveLength(1);

    // Removal never calls Email Routing or Workers, so a Sending-only token can finish it.
    const removal = await requestEmailDomainRemove(env.db, bindings(), added.routeId, actor);
    await runEmailOperation(env.db, bindings(), removal);
    expect((await getEmailOperation(env.db, project.id, removal))?.operation.status).toBe(
      'completed',
    );
    expect(inboundCalls(stub.calls)).toEqual([]);
    expect((await resolveEmailDomain(env.db, 'outbound.example.com'))?.route.desired_state).toBe(
      'removed',
    );
    expect((await env.db.select().from(emailZoneConnections))[0]?.credential_id).toBeNull();
  });

  it('blocks before onboarding when the preview reports conflicting DNS records', async () => {
    const admin = await createTestUser(env.db);
    const project = await createTestProject(env.db, admin.id, 'outbound-conflict');
    const previewErrors: Array<{ code: string; existing?: { name: string } }> = [
      { code: 'dmarc.missing' },
      { code: 'dmarc.multiple', existing: { name: '_dmarc.outbound-conflict.example.com' } },
    ];
    const stub = stubCustomerCf({ zones, sendingPreviewErrors: previewErrors });
    const actor = { kind: 'admin' as const, userId: admin.id };
    const added = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'outbound-conflict.example.com',
      token: TOKEN,
      actor,
      inboundMode: 'none',
    });
    await runEmailOperation(env.db, bindings(), added.operationId);

    const operation = (await getEmailOperation(env.db, project.id, added.operationId))?.operation;
    expect(operation).toMatchObject({ status: 'blocked', current_step: 'sending_onboard' });
    expect(operation?.failure_detail).toContain(
      'dmarc.multiple at _dmarc.outbound-conflict.example.com',
    );
    expect(operation?.failure_detail).not.toContain('dmarc.missing');
    expect(callsByTag(stub.calls, 'onboardSending')).toEqual([]);
    expect(
      (await resolveEmailDomain(env.db, 'outbound-conflict.example.com'))?.route,
    ).toMatchObject({ outbound_status: 'blocked', inbound_status: 'disabled' });

    previewErrors.splice(1);
    const resumed = await requestEmailDomainSync(env.db, bindings(), added.routeId, actor);
    expect(resumed).toBe(added.operationId);
    await runEmailOperation(env.db, bindings(), resumed);
    expect((await getEmailOperation(env.db, project.id, resumed))?.operation.status).toBe(
      'completed',
    );
    expect(
      (await resolveEmailDomain(env.db, 'outbound-conflict.example.com'))?.route.outbound_status,
    ).toBe('ready');
  });

  it('blocks instead of falling back to verified-only sending when Cloudflare refuses', async () => {
    const admin = await createTestUser(env.db);
    const project = await createTestProject(env.db, admin.id, 'outbound-refused');
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {
      onboardSending: { message: 'entitlement required', status: 403 },
    };
    const stub = stubCustomerCf({ zones, failOn: failures });
    const actor = { kind: 'admin' as const, userId: admin.id };
    const added = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'outbound-refused.example.com',
      token: TOKEN,
      actor,
      inboundMode: 'none',
    });
    await runEmailOperation(env.db, bindings(), added.operationId);

    expect(
      (await getEmailOperation(env.db, project.id, added.operationId))?.operation,
    ).toMatchObject({
      status: 'blocked',
      current_step: 'sending_onboard',
      failure_detail: expect.stringContaining('Workers Paid'),
    });
    expect((await resolveEmailDomain(env.db, 'outbound-refused.example.com'))?.route).toMatchObject(
      {
        outbound_status: 'blocked',
        outbound_reason: 'Cloudflare Sending onboarding unavailable',
      },
    );

    delete failures.onboardSending;
    const resumed = await requestEmailDomainSync(env.db, bindings(), added.routeId, actor);
    await runEmailOperation(env.db, bindings(), resumed);
    expect(
      (await resolveEmailDomain(env.db, 'outbound-refused.example.com'))?.route.outbound_status,
    ).toBe('ready');
    expect(callsByTag(stub.calls, 'onboardSending')).toHaveLength(2);
  });

  it('still falls back to verified-only sending for a domain that receives mail', async () => {
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id, 'managed-refused');
    stubCustomerCf({
      zones,
      failOn: { onboardSending: { message: 'entitlement required', status: 403 } },
    });
    const added = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'refused.example.com',
      token: TOKEN,
      actor: { kind: 'owner', userId: owner.id },
    });
    await runEmailOperation(env.db, bindings(), added.operationId);
    expect((await getEmailOperation(env.db, project.id, added.operationId))?.operation.status).toBe(
      'completed',
    );
    expect((await resolveEmailDomain(env.db, 'refused.example.com'))?.route).toMatchObject({
      inbound_mode: 'managed',
      inbound_status: 'ready',
      outbound_status: 'verified_only',
    });
  });

  it('keeps a timed-out outbound-only onboarding unknown', async () => {
    const admin = await createTestUser(env.db);
    const project = await createTestProject(env.db, admin.id, 'outbound-timeout');
    stubCustomerCf({
      zones,
      failOn: { onboardSending: { message: 'write outcome unavailable', status: 504 } },
    });
    const added = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'outbound-timeout.example.com',
      token: TOKEN,
      actor: { kind: 'admin', userId: admin.id },
      inboundMode: 'none',
    });
    await runEmailOperation(env.db, bindings(), added.operationId);
    expect(
      (await getEmailOperation(env.db, project.id, added.operationId))?.operation,
    ).toMatchObject({
      status: 'unknown',
      current_step: 'sending_onboard',
      failure_code: 'outcome_unknown',
    });
    expect(
      (await resolveEmailDomain(env.db, 'outbound-timeout.example.com'))?.route.outbound_status,
    ).toBe('pending');
  });

  it('refuses owners, the shared mail zone, subdomains and a mode change on an active route', async () => {
    const admin = await createTestUser(env.db);
    const project = await createTestProject(env.db, admin.id, 'outbound-mode');
    const stub = stubCustomerCf({ zones });
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: project.id,
        domain: 'outbound-mode.example.com',
        token: TOKEN,
        actor: { kind: 'owner', userId: admin.id },
        inboundMode: 'none',
      }),
    ).rejects.toThrow('administrator-managed');
    const actor = { kind: 'admin' as const, userId: admin.id };
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: project.id,
        domain: 'news.outbound-mode.example.com',
        token: TOKEN,
        actor,
        inboundMode: 'none',
      }),
    ).rejects.toThrow('must be a zone apex');
    const shared = {
      ...bindings(),
      EMAIL_SHARED_ACCOUNT_ID: 'customer-account',
      EMAIL_SHARED_ZONE_ID: zones['outbound-mode.example.com'].id,
    } as ApiEnv['Bindings'];
    await expect(
      requestEmailDomainAdd(env.db, shared, {
        projectId: project.id,
        domain: 'outbound-mode.example.com',
        token: TOKEN,
        actor,
        inboundMode: 'none',
      }),
    ).rejects.toThrow('cannot be outbound-only');
    expect(stub.calls.filter((call) => call.method !== 'GET')).toEqual([]);

    const added = await requestEmailDomainAdd(env.db, bindings(), {
      projectId: project.id,
      domain: 'outbound-mode.example.com',
      token: TOKEN,
      actor,
      inboundMode: 'none',
    });
    await runEmailOperation(env.db, bindings(), added.operationId);
    await expect(
      requestEmailDomainAdd(env.db, bindings(), {
        projectId: project.id,
        domain: 'outbound-mode.example.com',
        token: TOKEN,
        actor,
      }),
    ).rejects.toThrow('set up as outbound-only');
    expect(stub.calls.filter((call) => call.method !== 'GET').map((call) => call.tag)).toEqual([
      'sendingPreview',
      'onboardSending',
    ]);
  });
});

describe('shared mail domain ingress', () => {
  function sharedBindings(): ApiEnv['Bindings'] {
    return {
      ...bindings(),
      EMAIL_SENDER_DOMAIN: 'mail.example.com',
      EMAIL_SHARED_ACCOUNT_ID: env.CF_ACCOUNT_ID,
      EMAIL_SHARED_ZONE_ID: 'platform-mail-zone',
      EMAIL_SHARED_INGRESS_NAME: 'void-email-gateway',
    } as ApiEnv['Bindings'];
  }

  // A shared-domain project with slug `acme`, alias `acme-mail` and one
  // recipient row per name, each `ready` unless `statuses` says otherwise.
  async function aliasedProject(
    statuses: {
      slug?: 'ready' | 'pending' | 'blocked';
      alias?: 'ready' | 'pending' | 'blocked';
    } = {},
  ) {
    stubCustomerCf({
      zones: {
        'example.com': {
          id: 'platform-mail-zone',
          name: 'example.com',
          accountId: env.CF_ACCOUNT_ID,
        },
      },
      mx: { 'mail.example.com': ['route1.mx.cloudflare.net'] },
    });
    const bootstrap = await ensureSharedEmailConnection(env.db, sharedBindings());
    await runEmailOperation(env.db, sharedBindings(), bootstrap!);
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id, 'acme');
    await env.db
      .update(projects)
      .set({ email_alias: 'acme-mail' })
      .where(eq(projects.id, project.id));
    const deployment = await createTestDeployment(env.db, project.id);
    await env.db
      .update(deployments)
      .set({ manifest: JSON.stringify({ emailProtocolVersion: 1 }) })
      .where(eq(deployments.id, deployment.id));
    const { connection, route } = (await resolveEmailDomain(env.db, 'mail.example.com'))!;
    for (const [name, status] of [
      ['acme', statuses.slug ?? 'ready'],
      ['acme-mail', statuses.alias ?? 'ready'],
    ] as const) {
      await env.db.insert(emailSharedRecipients).values({
        id: `recipient-${name}`,
        installation_id: connection.installation_id,
        project_id: project.id,
        route_id: route.id,
        recipient: `${name}@mail.example.com`,
        rule_name: `rule-name-${name}`,
        rule_id: `rule-${name}`,
        status,
      });
    }
    return { project, deployment, connection };
  }

  async function resolveIngress(
    connection: typeof emailZoneConnections.$inferSelect,
    to: string,
  ): Promise<Response> {
    const proof = await hmacSignState(
      `email-ingress-v1\n${connection.account_id}\n${connection.zone_id}\n${connection.ingress_worker_name}\n${to}`,
      env.EMAIL_SIGNING_SECRET,
    );
    return app.fetch(
      new Request('https://api/internal/email/resolve-ingress', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-void-internal': proof },
        body: JSON.stringify({
          accountId: connection.account_id,
          zoneId: connection.zone_id,
          ingressName: connection.ingress_worker_name,
          to,
          secret: await readConnectionSecret(sharedBindings(), connection),
        }),
      }),
      sharedBindings(),
    );
  }

  it.each([
    ['acme-mail@mail.example.com', 'acme-mail'],
    ['acme-mail+billing@mail.example.com', 'acme-mail'],
    ['acme@mail.example.com', 'acme'],
    ['acme+billing@mail.example.com', 'acme'],
  ])('resolves %s to the project and the mailbox it used', async (to, mailbox) => {
    const { project, deployment, connection } = await aliasedProject();
    const response = await resolveIngress(connection, to);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      projectId: project.id,
      slug: 'acme',
      mailbox,
      alias: 'acme-mail',
      deploymentId: deployment.id,
      addressing: 'shared',
      domain: 'mail.example.com',
    });
  });

  it('checks readiness of the alias row alone when mail uses the alias', async () => {
    const { connection } = await aliasedProject({ alias: 'pending' });
    const alias = await resolveIngress(connection, 'acme-mail+billing@mail.example.com');
    expect(alias.status).toBe(503);
    expect(await alias.json()).toEqual({ error: 'shared recipient routing is not ready' });
    const slug = await resolveIngress(connection, 'acme@mail.example.com');
    expect(slug.status).toBe(200);
    expect(await slug.json()).toMatchObject({ mailbox: 'acme' });
  });

  it('checks readiness of the slug row alone when mail uses the slug', async () => {
    const { connection } = await aliasedProject({ slug: 'blocked' });
    const slug = await resolveIngress(connection, 'acme+billing@mail.example.com');
    expect(slug.status).toBe(503);
    expect(await slug.json()).toEqual({ error: 'shared recipient routing is not ready' });
    const alias = await resolveIngress(connection, 'acme-mail@mail.example.com');
    expect(alias.status).toBe(200);
    expect(await alias.json()).toMatchObject({ mailbox: 'acme-mail' });
  });

  it('does not resolve a name that is neither the slug nor the alias', async () => {
    const { connection } = await aliasedProject();
    const response = await resolveIngress(connection, 'acme-other@mail.example.com');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'unknown shared recipient' });
  });
});
