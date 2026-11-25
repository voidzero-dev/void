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
import { hmacSignState } from '../../src/auth/hmac.ts';
import {
  emailCredentials,
  emailDomainRoutes,
  emailOperations,
} from '../../src/email/connection-schema.ts';
import app from '../../src/index.ts';
import { projectMembers } from '../../src/schema.ts';
import { stubCustomerCf } from './email-domain-cf-stub.ts';
import {
  clearTables,
  createTestProject,
  createTestUser,
  EMAIL_SIGNING_SECRET,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;
const token = 'customer-scoped-token';
// Each fixture domain below is the apex of its own visible test zone.
const zones = {
  'example.com': { id: 'zone-example', name: 'example.com', accountId: 'customer-account' },
  'expiry.example.com': {
    id: 'zone-expiry-example-com',
    name: 'expiry.example.com',
    accountId: 'customer-account',
  },
  'gone.example.com': {
    id: 'zone-gone-example-com',
    name: 'gone.example.com',
    accountId: 'customer-account',
  },
  'lease.example.com': {
    id: 'zone-lease-example-com',
    name: 'lease.example.com',
    accountId: 'customer-account',
  },
  'mail.example.com': {
    id: 'zone-mail-example-com',
    name: 'mail.example.com',
    accountId: 'customer-account',
  },
  'moved.example.com': {
    id: 'zone-moved-example-com',
    name: 'moved.example.com',
    accountId: 'customer-account',
  },
  'nlease.example.com': {
    id: 'zone-nlease-example-com',
    name: 'nlease.example.com',
    accountId: 'customer-account',
  },
  'other.example.com': {
    id: 'zone-other-example-com',
    name: 'other.example.com',
    accountId: 'customer-account',
  },
  'status.example.com': {
    id: 'zone-status-example-com',
    name: 'status.example.com',
    accountId: 'customer-account',
  },
  'team.example.com': {
    id: 'zone-team-example-com',
    name: 'team.example.com',
    accountId: 'customer-account',
  },
};
function runtime() {
  return { ...env, EMAIL_GATEWAY_ORIGIN: 'https://email-gateway.example.test' } as typeof env;
}
function call(projectId: string, jwt: string, method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://localhost/projects/${projectId}/email${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    runtime(),
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
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('project email domain authority', () => {
  it('allows members to read email state and only admins to change domains', async () => {
    const owner = await createTestUser(env.db, 'email-team-owner');
    const reader = await createTestUser(env.db, 'email-team-reader');
    const collaborator = await createTestUser(env.db, 'email-team-collaborator');
    const admin = await createTestUser(env.db, 'email-team-admin');
    const project = await createTestProject(env.db, owner.id, 'email-team-project');
    await env.db.insert(projectMembers).values([
      {
        project_id: project.id,
        user_id: reader.id,
        role: 'reader',
        added_by_user_id: owner.id,
      },
      {
        project_id: project.id,
        user_id: collaborator.id,
        role: 'collaborator',
        added_by_user_id: owner.id,
      },
      {
        project_id: project.id,
        user_id: admin.id,
        role: 'admin',
        added_by_user_id: owner.id,
      },
    ]);
    stubCustomerCf({ zones });

    for (const member of [reader, collaborator, admin]) {
      expect((await call(project.id, member.jwt, 'GET', '/settings')).status).toBe(200);
      expect((await call(project.id, member.jwt, 'GET', '/domains')).status).toBe(200);
    }
    expect(
      (
        await call(project.id, collaborator.jwt, 'POST', '/domains', {
          domain: 'team.example.com',
          apiToken: token,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(project.id, owner.jwt, 'POST', '/domains', {
          domain: 'team.example.com',
          apiToken: token,
        })
      ).status,
    ).toBe(200);
    expect((await call(project.id, reader.jwt, 'GET', '/domains/team.example.com')).status).toBe(
      200,
    );
    expect(
      (
        await call(project.id, admin.jwt, 'POST', '/domains', {
          domain: 'team.example.com',
          apiToken: token,
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(project.id, admin.jwt, 'POST', '/domains/team.example.com/sync')).status,
    ).toBe(200);
    expect((await call(project.id, admin.jwt, 'DELETE', '/domains/team.example.com')).status).toBe(
      200,
    );
    expect(
      (
        await call(project.id, admin.jwt, 'POST', '/domains', {
          domain: 'team.example.com',
          apiToken: token,
        })
      ).status,
    ).toBe(200);
  });

  it('persists token identity and expiry and reports a known expired credential locally', async () => {
    const owner = await createTestUser(env.db, 'expiry-owner');
    const project = await createTestProject(env.db, owner.id, 'expiry-mail');
    const expiresOn = new Date(Date.now() + 86_400_000).toISOString();
    const stub = stubCustomerCf({ zones, verifyExpiresOn: expiresOn });
    expect(
      (
        await call(project.id, owner.jwt, 'POST', '/domains', {
          domain: 'expiry.example.com',
          apiToken: token,
        })
      ).status,
    ).toBe(200);
    const credential = (await env.db.select().from(emailCredentials))[0];
    expect(credential).toMatchObject({
      token_id: 'tok_dummy',
      status: 'healthy',
    });
    expect(Date.parse(credential.expires_on!)).toBe(Date.parse(expiresOn));

    await env.db
      .update(emailCredentials)
      .set({ expires_on: new Date(Date.now() - 60_000).toISOString() });
    const checkpoint = stub.calls.length;
    const status = await call(project.id, owner.jwt, 'GET', '/domains/expiry.example.com');
    expect(await status.json()).toMatchObject({
      readiness: {
        management: {
          status: 'expired',
          reason: expect.stringContaining('expired'),
        },
      },
    });
    expect(stub.calls).toHaveLength(checkpoint);
  });

  it('refreshes readiness from provider reads and preserves inbound state when the credential probe fails', async () => {
    const owner = await createTestUser(env.db, 'readiness-owner');
    const project = await createTestProject(env.db, owner.id, 'readiness-mail');
    const routingRules: Array<{ enabled: boolean; addresses: Array<string> }> = [];
    const failures: { routingRulesGet?: { message: string; status: number } } = {};
    const mx: Record<string, Array<string>> = {};
    const stub = stubCustomerCf({ zones, routingRules, failOn: failures, mx });
    expect(
      (
        await call(project.id, owner.jwt, 'POST', '/domains', {
          domain: 'status.example.com',
          apiToken: token,
        })
      ).status,
    ).toBe(200);
    const checkpoint = stub.calls.length;
    routingRules.push({ enabled: true, addresses: ['support@status.example.com'] });
    const drifted = await call(project.id, owner.jwt, 'GET', '/domains/status.example.com');
    expect(await drifted.json()).toMatchObject({
      readiness: {
        inbound: { status: 'drifted', reason: expect.stringContaining('explicit Cloudflare') },
        management: { status: 'healthy' },
      },
    });
    failures.routingRulesGet = { status: 403, message: 'permission revoked' };
    const unavailable = await call(project.id, owner.jwt, 'GET', '/domains/status.example.com');
    expect(await unavailable.json()).toMatchObject({
      readiness: {
        inbound: { status: 'drifted' },
        management: { status: 'probe_failed' },
      },
    });
    delete failures.routingRulesGet;
    routingRules.length = 0;
    mx['status.example.com'] = [];
    const dnsDrift = await call(project.id, owner.jwt, 'GET', '/domains/status.example.com');
    expect(await dnsDrift.json()).toMatchObject({
      readiness: { inbound: { status: 'drifted', reason: expect.stringContaining('MX records') } },
    });
    mx['status.example.com'] = ['route1.mx.cloudflare.net'];
    await env.db
      .update(emailDomainRoutes)
      .set({ inbound_status: 'pending', inbound_reason: 'waiting for setup proof' })
      .where(eq(emailDomainRoutes.project_id, project.id));
    const pending = await call(project.id, owner.jwt, 'GET', '/domains/status.example.com');
    expect(await pending.json()).toMatchObject({
      readiness: {
        inbound: { status: 'pending', reason: 'waiting for setup proof' },
        management: { status: 'healthy' },
      },
    });
    expect(stub.calls.slice(checkpoint).every((call) => call.method === 'GET')).toBe(true);
  });

  it('does not return a route removed or reassigned during a provider status read', async () => {
    const owner = await createTestUser(env.db, 'status-race-owner');
    const other = await createTestUser(env.db, 'status-race-other');
    const project = await createTestProject(env.db, owner.id, 'status-race-mail');
    const foreign = await createTestProject(env.db, other.id, 'status-race-foreign');
    let race: (() => Promise<void>) | undefined;
    stubCustomerCf({
      zones,
      on: {
        routingRulesGet: async () => {
          const run = race;
          race = undefined;
          await run?.();
        },
      },
    });
    for (const domain of ['gone.example.com', 'moved.example.com']) {
      expect(
        (
          await call(project.id, owner.jwt, 'POST', '/domains', {
            domain,
            apiToken: token,
          })
        ).status,
      ).toBe(200);
    }

    race = async () => {
      await env.db
        .delete(emailDomainRoutes)
        .where(eq(emailDomainRoutes.domain, 'gone.example.com'));
    };
    const removed = await call(project.id, owner.jwt, 'GET', '/domains/gone.example.com');
    expect(removed.status).toBe(404);
    expect(await removed.json()).toEqual({ error: 'email domain not found' });

    race = async () => {
      await env.db
        .update(emailDomainRoutes)
        .set({ project_id: foreign.id })
        .where(eq(emailDomainRoutes.domain, 'moved.example.com'));
    };
    const reassigned = await call(project.id, owner.jwt, 'GET', '/domains/moved.example.com');
    expect(reassigned.status).toBe(404);
    expect(await reassigned.json()).toEqual({ error: 'email domain not found' });
  });

  it('rejects unauthenticated, foreign-owner, malformed and OAuth requests before Cloudflare writes', async () => {
    const owner = await createTestUser(env.db, 'domain-owner'),
      other = await createTestUser(env.db, 'domain-other');
    const project = await createTestProject(env.db, owner.id, 'owned-mail');
    const stub = stubCustomerCf({ zones });
    expect((await call(project.id, '', 'GET', '/domains')).status).toBe(401);
    expect(
      (
        await call(project.id, other.jwt, 'POST', '/domains', {
          domain: 'mail.example.com',
          apiToken: token,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(project.id, owner.jwt, 'POST', '/domains', {
          domain: 'bad domain',
          apiToken: token,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(project.id, owner.jwt, 'POST', '/domains', {
          domain: 'mail.example.com',
          refreshToken: 'oauth-grant',
        })
      ).status,
    ).toBe(400);
    expect(stub.calls).toHaveLength(0);
  });

  it('stores connection-scoped token ciphertext and returns operation/readiness without secret material', async () => {
    const owner = await createTestUser(env.db, 'registered-owner');
    const project = await createTestProject(env.db, owner.id, 'registered-mail');
    stubCustomerCf({ zones });
    const response = await call(project.id, owner.jwt, 'POST', '/domains', {
      domain: 'Mail.Example.COM',
      apiToken: token,
      attemptId: 'stable-add',
    });
    expect(response.status).toBe(200);
    const body = await response.json<{
      operationId: string;
      attemptId: string;
      readiness: { inbound: { status: string } };
      domain: string;
    }>();
    expect(body.domain).toBe('mail.example.com');
    expect(body.attemptId).toBe('stable-add');
    expect(body.operationId).toMatch(/^eop/);
    expect(body.readiness.inbound.status).toBe('ready');
    expect(JSON.stringify(body)).not.toContain(token);
    const credential = (await env.db.select().from(emailCredentials))[0];
    expect(credential.kind).toBe('api_token');
    expect(credential.ciphertext).not.toContain(token);
    expect(credential.account_id).toBe('customer-account');
    const status = await call(project.id, owner.jwt, 'GET', '/operations/stable-add');
    expect(status.status).toBe(200);
    expect((await status.json<{ operationId: string }>()).operationId).toBe(body.operationId);
    const replay = await call(project.id, owner.jwt, 'POST', '/domains', {
      domain: 'mail.example.com',
      apiToken: token,
      attemptId: 'stable-add',
    });
    expect((await replay.json<{ operationId: string }>()).operationId).toBe(body.operationId);
    const conflict = await call(project.id, owner.jwt, 'POST', '/domains', {
      domain: 'mail.example.com',
      apiToken: 'another-token',
      attemptId: 'stable-add',
    });
    expect(conflict.status).toBe(409);
    expect(await env.db.select().from(emailOperations)).toHaveLength(1);
    const rotation = await call(
      project.id,
      owner.jwt,
      'POST',
      '/domains/mail.example.com/rotate-secret',
      {
        attemptId: 'stable-rotation',
      },
    );
    expect(rotation.status).toBe(200);
    const rotated = await rotation.json<{ operationId: string }>();
    const recoveredRotation = await call(
      project.id,
      owner.jwt,
      'GET',
      '/operations/stable-rotation',
    );
    expect(recoveredRotation.status).toBe(200);
    expect(await recoveredRotation.json()).toMatchObject({
      operationId: rotated.operationId,
      status: 'completed',
    });
  });

  it('leases only an exact active route for the signed owning project', async () => {
    const owner = await createTestUser(env.db, 'lease-owner'),
      other = await createTestUser(env.db, 'lease-other');
    const project = await createTestProject(env.db, owner.id, 'lease-mail');
    const foreign = await createTestProject(env.db, other.id, 'foreign-mail');
    stubCustomerCf({ zones });
    expect(
      (
        await call(project.id, owner.jwt, 'POST', '/domains', {
          domain: 'lease.example.com',
          apiToken: token,
        })
      ).status,
    ).toBe(200);
    const lease = async (projectId: string, domain: string, signatureDomain = domain) =>
      app.fetch(
        new Request('http://localhost/internal/email/domain-credential', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-void-internal': await hmacSignState(
              `email-lease-v1\n${projectId}\n${signatureDomain}`,
              EMAIL_SIGNING_SECRET,
            ),
          },
          body: JSON.stringify({ domain, projectId }),
        }),
        runtime(),
      );
    const valid = await lease(project.id, 'lease.example.com');
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({
      kind: 'api_token',
      token,
      accountId: 'customer-account',
    });
    expect((await lease(foreign.id, 'lease.example.com')).status).toBe(404);
    expect((await lease(project.id, 'lease.example.com', 'other.example.com')).status).toBe(403);
    const signed = await hmacSignState(
      `email-lease-v1\n${project.id}\nlease.example.com`,
      EMAIL_SIGNING_SECRET,
    );
    const oversized = await app.fetch(
      new Request('http://localhost/internal/email/domain-credential', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-void-internal': signed },
        body: JSON.stringify({
          domain: 'lease.example.com',
          projectId: project.id,
          padding: 'x'.repeat(5000),
        }),
      }),
      runtime(),
    );
    expect(oversized.status).toBe(413);
    const malformed = await app.fetch(
      new Request('http://localhost/internal/email/domain-credential', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-void-internal': signed },
        body: 'null',
      }),
      runtime(),
    );
    expect(malformed.status).toBe(400);
    const unsigned = await app.fetch(
      new Request('http://localhost/internal/email/domain-credential', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'null',
      }),
      runtime(),
    );
    expect(unsigned.status).toBe(403);
    const list = await call(project.id, other.jwt, 'GET', '/domains');
    expect(list.status).toBe(403);
  });
});
