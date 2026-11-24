import { PLATFORM_DISABLED_KEY } from '@void/platform';
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
import { createCfCustomerClient } from '../../src/email/cf-customer.ts';
import {
  emailDomainRoutes,
  emailOperations,
  emailOperationSteps,
  emailZoneConnections,
} from '../../src/email/connection-schema.ts';
// oxlint-disable-next-line import/no-namespace -- The test replaces or spies on members of the module object.
import * as emailConnections from '../../src/email/connection-service.ts';
import type { ApiEnv } from '../../src/env.ts';
import { app } from '../../src/index.ts';
import { callsByTag, stubCustomerCf } from './email-domain-cf-stub.ts';
import { clearTables, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
  await env.ROUTING.put(PLATFORM_DISABLED_KEY, 'disabled');
});

afterEach(async () => {
  await env.ROUTING.delete(PLATFORM_DISABLED_KEY);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function bindings(): ApiEnv['Bindings'] {
  return {
    ...env,
    EMAIL_GATEWAY_ORIGIN: 'https://email-gateway.example.test',
    EMAIL_SENDER_DOMAIN: 'mail.example.com',
    EMAIL_SHARED_ACCOUNT_ID: env.CF_ACCOUNT_ID,
    EMAIL_SHARED_ZONE_ID: 'platform-mail-zone',
    EMAIL_SHARED_INGRESS_NAME: 'void-email-gateway',
    PLATFORM_CAPABILITIES: JSON.stringify({
      ai: true,
      customDomains: false,
      email: true,
      githubActions: false,
      githubOAuth: true,
      googleOAuth: false,
      managedBuilds: false,
      sandbox: false,
    }),
    PLATFORM_HEALTH_PROBE_TOKEN: 'probe-token',
    PLATFORM_INSTALLATION_ID: 'installation-id',
    PLATFORM_TRAFFIC_STATE: 'staging',
  } as unknown as ApiEnv['Bindings'];
}

function request(token = 'probe-token') {
  return new Request('http://localhost/internal/platform/email-bootstrap', {
    method: 'POST',
    headers: { 'X-Void-Platform-Probe': token },
  });
}

describe('POST /internal/platform/email-bootstrap', () => {
  it('invalidates completed legacy catch-all readiness and durably verifies subaddressing on upgrade', async () => {
    const provider = stubCustomerCf({
      zones: {
        'example.com': {
          id: 'platform-mail-zone',
          name: 'example.com',
          accountId: env.CF_ACCOUNT_ID,
        },
      },
      mx: { 'mail.example.com': ['route1.mx.cloudflare.net'] },
      catchAllRule: { enabled: true, workerName: 'void-email-gateway' },
    });
    // Retain the real installed identities and completed operation, but model
    // the old bootstrap's exact key/step and provider observation.
    const first = await emailConnections.ensureSharedEmailConnection(env.db, bindings());
    await emailConnections.runEmailOperation(env.db, bindings(), first!);
    const [legacy] = await env.db.select().from(emailOperations);
    const [originalRoute] = await env.db.select().from(emailDomainRoutes);
    await env.db
      .update(emailOperations)
      .set({ idempotency_key: 'shared:mail.example.com' })
      .where(eq(emailOperations.id, first!));
    const [plusStep] = (await env.db.select().from(emailOperationSteps)).filter(
      (step) => step.kind === 'subaddressing_ensure',
    );
    await env.db
      .update(emailOperationSteps)
      .set({ kind: 'catchall_ensure', outcome: { workerName: 'void-email-gateway' } })
      .where(eq(emailOperationSteps.id, plusStep!.id));
    provider.routingSettingsStates.get('platform-mail-zone')!.support_subaddress = false;
    provider.calls.length = 0;

    const upgraded = await emailConnections.ensureSharedEmailConnection(env.db, bindings());
    expect(upgraded).not.toBe(first);
    expect((await env.db.select().from(emailDomainRoutes))[0]).toMatchObject({
      id: originalRoute!.id,
      inbound_status: 'pending',
      desired_generation: originalRoute!.desired_generation + 1,
    });
    expect((await env.db.select().from(emailZoneConnections))[0]).toMatchObject({
      id: legacy!.connection_id,
      inbound_status: 'pending',
    });
    const pending = (await env.db.select().from(emailOperationSteps)).filter(
      (step) => step.operation_id === upgraded,
    );
    expect(pending.map((step) => step.kind)).toEqual([
      'routing_enable',
      'subaddressing_ensure',
      'inbound_probe',
      'publish',
    ]);

    // The installer endpoint resumes this exact new operation, without
    // trusting the completed legacy checkpoint or duplicating PATCH.
    const response = await app.fetch(request(), bindings());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: 'ready', operationId: upgraded });
    expect(callsByTag(provider.calls, 'subaddressing')[0]?.body).toEqual({
      support_subaddress: true,
    });
    expect(callsByTag(provider.calls, 'subaddressing')).toHaveLength(1);
    expect(callsByTag(provider.calls, 'catchAll')).toHaveLength(0);
    expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(0);
    expect(
      await createCfCustomerClient(bindings().CF_API_TOKEN).getCatchAll('platform-mail-zone'),
    ).toMatchObject({ enabled: true, workerName: 'void-email-gateway' });
    const retry = await app.fetch(request(), bindings());
    expect(retry.status).toBe(200);
    expect(callsByTag(provider.calls, 'subaddressing')).toHaveLength(1);
    expect(await env.db.select().from(emailOperations)).toHaveLength(2);
  });
  it('retains the durable operation ID if execution fails after setup was recorded', async () => {
    stubCustomerCf({
      zones: {
        'mail.example.com': {
          id: 'platform-mail-zone',
          name: 'mail.example.com',
          accountId: env.CF_ACCOUNT_ID,
        },
      },
    });
    vi.spyOn(emailConnections, 'runEmailOperation').mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    const response = await app.fetch(request(), bindings());
    expect(response.status).toBe(503);
    const [operation] = await env.db.select().from(emailOperations);
    expect(operation).toBeDefined();
    expect(await response.json()).toMatchObject({ state: 'failed', operationId: operation!.id });
  });

  it('completes the durable shared route before the installer opens traffic', async () => {
    const cloudflare = stubCustomerCf({
      zones: {
        'mail.example.com': {
          id: 'platform-mail-zone',
          name: 'mail.example.com',
          accountId: env.CF_ACCOUNT_ID,
        },
      },
      mx: { 'mail.example.com': ['route1.mx.cloudflare.net'] },
    });

    const response = await app.fetch(request(), bindings());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      state: 'ready',
      operationId: expect.any(String),
    });
    expect(callsByTag(cloudflare.calls, 'catchAll')).toHaveLength(0);
    expect(callsByTag(cloudflare.calls, 'subaddressing')).toHaveLength(1);
    const operation = (await env.db.select().from(emailOperations))[0];
    const route = (
      await env.db
        .select()
        .from(emailDomainRoutes)
        .where(eq(emailDomainRoutes.id, operation!.route_id!))
    )[0];
    expect(operation?.status).toBe('completed');
    expect(route).toMatchObject({
      addressing: 'shared',
      desired_state: 'active',
      inbound_status: 'ready',
    });
  });

  it('does not let an invalid probe token bypass the lifecycle gate', async () => {
    const response = await app.fetch(request('wrong-token'), bindings());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Platform disabled', reason: 'maintenance' });
  });

  it('fails readiness when the durable setup operation is blocked', async () => {
    stubCustomerCf({
      zones: {
        'mail.example.com': {
          id: 'platform-mail-zone',
          name: 'mail.example.com',
          accountId: env.CF_ACCOUNT_ID,
        },
      },
      mx: { 'mail.example.com': ['route1.mx.cloudflare.net'] },
      failOn: { subaddressing: { message: 'permission denied: provider-secret', status: 403 } },
      failBeforeEffect: ['subaddressing'],
    });

    const response = await app.fetch(request(), bindings());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({
      version: 1,
      state: 'incomplete',
      operationStatus: 'blocked',
      currentStep: 'subaddressing_ensure',
      failureCode: 'blocked',
      failureDetail: null,
      domain: 'mail.example.com',
      inboundStatus: 'pending',
    });
    expect(JSON.stringify(body)).not.toContain('provider-secret');
  });

  it('provisions the shared subdomain without taking over unrelated literal rules or the apex catch-all', async () => {
    const provider = stubCustomerCf({
      zones: {
        'example.com': {
          id: 'platform-mail-zone',
          name: 'example.com',
          accountId: env.CF_ACCOUNT_ID,
        },
      },
      mx: { 'mail.example.com': ['route1.mx.cloudflare.net'] },
      routingRules: [{ enabled: true, addresses: ['support@mail.example.com'] }],
      catchAllRule: { enabled: true, workerName: 'unrelated-apex-worker' },
    });

    const response = await app.fetch(request(), bindings());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: 'ready' });
    expect(callsByTag(provider.calls, 'catchAll')).toHaveLength(0);
    expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(0);
    expect(callsByTag(provider.calls, 'literalRuleUpdate')).toHaveLength(0);
    expect(callsByTag(provider.calls, 'routingDns')[0]?.body).toEqual({ name: 'mail.example.com' });
  });

  it('resumes the same blocked shared operation after configuration is corrected', async () => {
    const config: NonNullable<Parameters<typeof stubCustomerCf>[0]> = {
      zones: {
        'mail.example.com': {
          id: 'platform-mail-zone',
          name: 'mail.example.com',
          accountId: env.CF_ACCOUNT_ID,
        },
      },
      mx: { 'mail.example.com': [] },
    };
    const cloudflare = stubCustomerCf(config);

    const blocked = await app.fetch(request(), bindings());
    expect(blocked.status).toBe(503);
    const blockedBody = (await blocked.json()) as Record<string, unknown>;
    expect(blockedBody).toMatchObject({
      version: 1,
      state: 'incomplete',
      operationStatus: 'blocked',
      currentStep: 'inbound_probe',
      failureCode: 'blocked',
      failureDetail:
        'MX records for mail.example.com do not route mail to Cloudflare Email Routing',
      domain: 'mail.example.com',
      inboundStatus: 'drifted',
    });

    config.mx!['mail.example.com'] = ['route1.mx.cloudflare.net'];
    const resumed = await app.fetch(request(), bindings());
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({
      version: 1,
      state: 'ready',
      operationId: blockedBody.operationId,
    });
    expect(callsByTag(cloudflare.calls, 'catchAll')).toHaveLength(0);
    expect(callsByTag(cloudflare.calls, 'routingDns')).toHaveLength(1);
    expect(await env.db.select().from(emailOperations)).toHaveLength(1);
  });
});
