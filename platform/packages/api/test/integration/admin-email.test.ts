import { eq } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vite-plus/test';
import { getPlatformCapabilities } from '../../src/capabilities.ts';
import { getEmailDestinationsByProjectId } from '../../src/db.ts';
import type { Db } from '../../src/db.ts';
import { emailMonthlyUsage, emailProjectControls } from '../../src/email/admission-schema.ts';
import { pruneEmailActionHistory } from '../../src/email/admission.ts';
import { setProjectEmailLimits, setProjectEmailSuspended } from '../../src/email/admission.ts';
import { emailDomainRoutes, emailZoneConnections } from '../../src/email/connection-schema.ts';
import { generateId } from '../../src/id.ts';
import { app } from '../../src/index.ts';
import { emailDestinationCleanups, emailDestinations, operatorEvents } from '../../src/schema.ts';
import { stubCustomerCf, callsByTag } from './email-domain-cf-stub.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import { CF_ACCOUNT_ID } from './helpers.ts';

let env: TestEnv;

function visibleMarkup(html: string): string {
  return html.replaceAll('<!-- -->', '');
}

async function seedVerifiedDestination(db: Db, projectId: string, address: string, cfId: string) {
  const [row] = await db
    .insert(emailDestinations)
    .values({
      id: generateId('edst'),
      project_id: projectId,
      address,
      cf_destination_id: cfId,
      status: 'verified',
      verified_at: new Date().toISOString(),
    })
    .returning();
  return row;
}

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
  Object.assign(env, { EMAIL_GATEWAY_ORIGIN: 'https://email-gateway.example.test' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Records the Cloudflare Email Routing calls the route makes and answers each
 * one with a success envelope, so a test can assert whether the account-level
 * destination was deleted upstream.
 */
function recordCfCalls(): Array<string> {
  const calls: Array<string> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    return Response.json({ success: true, errors: [], result: { tag: 'cf-tag' } });
  });
  return calls;
}

/** UTC `YYYY-MM`, the bucket `admin/routes/email.tsx` and the proxy both use. */
function monthBucket(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function get(path: string, cookie: string): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      headers: { Cookie: `admin_token=${cookie}` },
      redirect: 'manual',
    }),
    env,
  );
}

/**
 * A same-origin admin form post. `Origin` is what a real browser sends and what
 * the admin auth middleware checks, so every legitimate write in these tests
 * carries it — the cross-origin cases below build their requests by hand.
 */
async function post(
  path: string,
  cookie: string,
  fields: Record<string, string> = {},
  origin: string | null = 'http://localhost',
): Promise<Response> {
  const headers: Record<string, string> = {
    Cookie: `admin_token=${cookie}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (origin !== null) {
    headers.Origin = origin;
  }
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers,
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    }),
    env,
  );
}

async function seedAdminAndProject(): Promise<{
  adminJwt: string;
  projectId: string;
  slug: string;
}> {
  const admin = await createTestUser(env.db, 'admin-email', 'github', undefined, 'free', 'admin');
  const owner = await createTestUser(env.db, 'email-owner');
  const project = await createTestProject(env.db, owner.id);
  return { adminJwt: admin.adminJwt, projectId: project.id, slug: project.slug };
}

function withoutEmail(): TestEnv {
  return {
    ...env,
    PLATFORM_CAPABILITIES: JSON.stringify({ ...getPlatformCapabilities(env), email: false }),
  };
}

describe('email disabled on this platform', () => {
  test('renders the disabled state inside the admin layout for document and page-object visits', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    const bindings = withoutEmail();
    const headers = { Cookie: `admin_token=${adminJwt}` };

    const document = await app.fetch(
      new Request('http://localhost/admin/email', { headers }),
      bindings,
    );
    expect(document.status).toBe(200);
    const html = await document.text();
    expect(html).toContain('void-admin-content');
    expect(html).toContain('Authentication');
    expect(html).toContain('Email is not enabled on this platform.');
    expect(html).toContain(
      'https://void.cloud/guide/platform/installation/credentials#enable-email',
    );

    for (const path of ['/admin/email', `/admin/email/${projectId}`]) {
      const page = await app.fetch(
        new Request(`http://localhost${path}`, {
          headers: { ...headers, 'X-VoidPages': 'true' },
        }),
        bindings,
      );
      expect(page.status).toBe(200);
      expect(await page.json()).toMatchObject({
        component: 'email',
        props: { emailEnabled: false, platformName: expect.any(String) },
      });
    }
  });

  test('still rejects email mutations', async () => {
    const { adminJwt } = await seedAdminAndProject();
    const response = await app.fetch(
      new Request('http://localhost/admin/email/policy', {
        method: 'POST',
        headers: {
          Cookie: `admin_token=${adminJwt}`,
          Origin: 'http://localhost',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'mode=any',
      }),
      withoutEmail(),
    );
    expect(response.status).toBe(501);
  });
});

describe('admin write guard (cross-origin)', () => {
  test('rejects a write with no Origin and no Referer', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    const res = await post(
      `/admin/email/${projectId}/suspend`,
      adminJwt,
      { state: 'suspended' },
      null,
    );

    expect(res.status).toBe(403);
    expect(await res.json<{ error: string }>()).toEqual({
      error: 'cross-site request blocked',
      message: 'Refresh the dashboard and try again.',
    });
    // The guard must run before the handler, not merely alongside it.
    expect(await env.ROUTING.get(`email-suspended:${projectId}`)).toBeNull();
  });

  test('rejects a write whose Origin is another site', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    const res = await post(
      `/admin/email/${projectId}/suspend`,
      adminJwt,
      { state: 'suspended' },
      'https://evil.example.com',
    );

    expect(res.status).toBe(403);
    expect(await env.ROUTING.get(`email-suspended:${projectId}`)).toBeNull();
  });

  test('accepts a write whose Referer is same-origin (no Origin header)', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    const res = await app.fetch(
      new Request(`http://localhost/admin/email/${projectId}/suspend`, {
        method: 'POST',
        headers: {
          Cookie: `admin_token=${adminJwt}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: `http://localhost/admin/email/${projectId}`,
        },
        body: 'state=suspended',
        redirect: 'manual',
      }),
      env,
    );

    expect(res.status).toBe(302);
    expect(
      (
        await env.db
          .select()
          .from(emailProjectControls)
          .where(eq(emailProjectControls.project_id, projectId))
      )[0]?.suspended_at,
    ).not.toBeNull();
    expect(await env.db.select().from(operatorEvents)).toEqual([
      expect.objectContaining({
        action: `email/projects/${projectId}/suspend`,
        target: JSON.stringify({ project: projectId, suspended: true }),
        status: 'success',
        http_status: 302,
      }),
    ]);
  });

  test('leaves reads alone', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    const res = await get(`/admin/email/${projectId}`, adminJwt);

    expect(res.status).toBe(200);
  });
});

describe('GET /admin/email/:projectId', () => {
  test('renders usage, the platform defaults, and the destination list', async () => {
    const { adminJwt, projectId, slug } = await seedAdminAndProject();
    const month = monthBucket();
    await env.db
      .insert(emailMonthlyUsage)
      .values({ project_id: projectId, month, recipient_attempts: 7, inbound_receipts: 3 });
    await pruneEmailActionHistory(env.db);

    const res = await get(`/admin/email/${projectId}`, adminJwt);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(slug);
    expect(visibleMarkup(html)).toContain('7 / 200');
    expect(html).toContain('Outbound recipient attempts');
    expect(html).toMatch(/Inbound \(received\)<\/th><td[^>]*>3<\/td>/);
    expect(visibleMarkup(html)).toContain('(default)');
    expect(html).toContain('Suspend email');
    expect(html).toContain('No destinations yet.');
  });

  test('labels an override as such and shows the suspended state', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    await setProjectEmailLimits(env.db, projectId, { monthly: 1000 });
    await setProjectEmailSuspended(env.db, projectId, true);

    const html = await (await get(`/admin/email/${projectId}`, adminJwt)).text();

    expect(visibleMarkup(html)).toContain('0 / 1000');
    expect(visibleMarkup(html)).toContain('(override)');
    expect(html).toContain('SUSPENDED');
    expect(html).toContain('Unsuspend email');
  });

  test('404s for an unknown project', async () => {
    const admin = await createTestUser(env.db, 'admin-404', 'github', undefined, 'free', 'admin');

    const res = await get('/admin/email/proj_does_not_exist', admin.adminJwt);

    expect(res.status).toBe(404);
  });
});

describe('POST /admin/email/:projectId/suspend', () => {
  test('suspending sets the kill-switch key', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    const res = await post(`/admin/email/${projectId}/suspend`, adminJwt, { state: 'suspended' });

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`/admin/email/${projectId}`);
    expect(
      (
        await env.db
          .select()
          .from(emailProjectControls)
          .where(eq(emailProjectControls.project_id, projectId))
      )[0]?.suspended_at,
    ).not.toBeNull();
  });

  test('unsuspending clears it', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    await setProjectEmailSuspended(env.db, projectId, true);

    const res = await post(`/admin/email/${projectId}/suspend`, adminJwt, { state: 'active' });

    expect(res.status).toBe(302);
    expect(
      (
        await env.db
          .select()
          .from(emailProjectControls)
          .where(eq(emailProjectControls.project_id, projectId))
      )[0]?.suspended_at,
    ).toBeNull();
    expect(await env.db.select().from(operatorEvents)).toEqual([
      expect.objectContaining({
        action: `email/projects/${projectId}/suspend`,
        target: JSON.stringify({ project: projectId, suspended: false }),
        status: 'success',
        http_status: 302,
      }),
    ]);
  });

  test('suspending twice is idempotent, not a toggle', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    await post(`/admin/email/${projectId}/suspend`, adminJwt, { state: 'suspended' });
    await post(`/admin/email/${projectId}/suspend`, adminJwt, { state: 'suspended' });

    expect(
      (
        await env.db
          .select()
          .from(emailProjectControls)
          .where(eq(emailProjectControls.project_id, projectId))
      )[0]?.suspended_at,
    ).not.toBeNull();
  });

  test('rejects a state that is neither terminal value', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    const res = await post(`/admin/email/${projectId}/suspend`, adminJwt, { state: 'toggle' });

    expect(res.status).toBe(400);
    expect(await env.ROUTING.get(`email-suspended:${projectId}`)).toBeNull();
  });
});

describe('POST /admin/email/:projectId/limit', () => {
  test('sets a monthly override', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    const res = await post(`/admin/email/${projectId}/limit`, adminJwt, { limit: '5000' });

    expect(res.status).toBe(302);
    expect(
      (
        await env.db
          .select()
          .from(emailProjectControls)
          .where(eq(emailProjectControls.project_id, projectId))
      )[0]?.monthly_limit,
    ).toBe(5000);
    expect(await env.db.select().from(operatorEvents)).toEqual([
      expect.objectContaining({
        action: `email/projects/${projectId}/limit`,
        target: JSON.stringify({ project: projectId, monthly: '5000' }),
        status: 'success',
        http_status: 302,
      }),
    ]);
  });

  test('a blank value drops the override back to the platform default', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    await setProjectEmailLimits(env.db, projectId, { monthly: 5000 });

    const res = await post(`/admin/email/${projectId}/limit`, adminJwt, { limit: '  ' });

    expect(res.status).toBe(302);
    expect(
      (
        await env.db
          .select()
          .from(emailProjectControls)
          .where(eq(emailProjectControls.project_id, projectId))
      )[0]?.monthly_limit,
    ).toBe(200);
  });

  test('rejects a value the proxy would not honour', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    for (const limit of ['0', '-5', 'lots']) {
      const res = await post(`/admin/email/${projectId}/limit`, adminJwt, { limit });
      expect(res.status).toBe(400);
    }
    expect(await env.ROUTING.get(`email-limit:${projectId}`)).toBeNull();
  });

  test('sets and clears the burst override on its own key', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();

    await post(`/admin/email/${projectId}/burst-limit`, adminJwt, { burstLimit: '60' });
    expect(
      (
        await env.db
          .select()
          .from(emailProjectControls)
          .where(eq(emailProjectControls.project_id, projectId))
      )[0]?.burst_limit,
    ).toBe(60);
    expect(await env.ROUTING.get(`email-limit:${projectId}`)).toBeNull();

    await post(`/admin/email/${projectId}/burst-limit`, adminJwt, { burstLimit: '' });
    expect(
      (
        await env.db
          .select()
          .from(emailProjectControls)
          .where(eq(emailProjectControls.project_id, projectId))
      )[0]?.burst_limit,
    ).toBe(10);
    const recorded = (await env.db.select().from(operatorEvents)).map((event) => ({
      action: event.action,
      target: event.target,
      status: event.status,
      httpStatus: event.http_status,
    }));
    expect(recorded).toHaveLength(2);
    expect(recorded).toEqual(
      expect.arrayContaining([
        {
          action: `email/projects/${projectId}/limit`,
          target: JSON.stringify({ project: projectId, burst: '60' }),
          status: 'success',
          httpStatus: 302,
        },
        {
          action: `email/projects/${projectId}/limit`,
          target: JSON.stringify({ project: projectId, burst: 'default' }),
          status: 'success',
          httpStatus: 302,
        },
      ]),
    );
  });
});

describe('POST /admin/email/:projectId/destinations/:destId/delete', () => {
  test('removes the row and drops an unreferenced CF address', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    const destination = await seedVerifiedDestination(
      env.db,
      projectId,
      'ops@example.com',
      'cf-tag-ops',
    );
    const cfCalls = recordCfCalls();

    const res = await post(
      `/admin/email/${projectId}/destinations/${destination.id}/delete`,
      adminJwt,
    );

    expect(res.status).toBe(302);
    expect(cfCalls).toEqual([
      'DELETE https://api.cloudflare.com/client/v4/accounts/test-account-id/email/routing/addresses/cf-tag-ops',
    ]);
    expect(await getEmailDestinationsByProjectId(env.db, projectId)).toEqual([]);
    expect(await env.db.select().from(emailDestinationCleanups)).toEqual([
      expect.objectContaining({ cf_destination_id: 'cf-tag-ops', status: 'completed' }),
    ]);
    const events = await env.db.select().from(operatorEvents);
    expect(events).toEqual([
      expect.objectContaining({
        action: `email/projects/${projectId}/destinations/${destination.id}/remove`,
        target: JSON.stringify({ project: projectId, destinationId: destination.id }),
        status: 'success',
        http_status: 302,
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain('ops@example.com');
  });

  test('leaves the CF address alone while another project still references it', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    const sibling = await createTestProject(env.db, (await createTestUser(env.db)).id);
    const destination = await seedVerifiedDestination(
      env.db,
      projectId,
      'shared@example.com',
      'cf-tag-shared',
    );
    await seedVerifiedDestination(env.db, sibling.id, 'shared@example.com', 'cf-tag-shared');
    const cfCalls = recordCfCalls();

    const res = await post(
      `/admin/email/${projectId}/destinations/${destination.id}/delete`,
      adminJwt,
    );

    expect(res.status).toBe(302);
    expect(cfCalls).toEqual([]);
  });

  test('404s for a destination that belongs to another project', async () => {
    const { adminJwt, projectId } = await seedAdminAndProject();
    const sibling = await createTestProject(env.db, (await createTestUser(env.db)).id);
    const destination = await seedVerifiedDestination(
      env.db,
      sibling.id,
      'elsewhere@example.com',
      'cf-tag-elsewhere',
    );
    const cfCalls = recordCfCalls();

    const res = await post(
      `/admin/email/${projectId}/destinations/${destination.id}/delete`,
      adminJwt,
    );

    expect(res.status).toBe(404);
    expect(cfCalls).toEqual([]);
  });
});

describe('admin email domain controls', () => {
  test('reports durable incomplete outcomes for add, rotate, and remove operations', async () => {
    const { adminJwt } = await seedAdminAndProject();
    const failures: NonNullable<Parameters<typeof stubCustomerCf>[0]>['failOn'] = {};
    stubCustomerCf({
      zones: {
        'unknown.example.com': {
          id: 'zone-unknown',
          name: 'unknown.example.com',
          accountId: CF_ACCOUNT_ID,
        },
        'blocked.example.net': {
          id: 'zone-blocked',
          name: 'blocked.example.net',
          accountId: CF_ACCOUNT_ID,
        },
        'rotate.example.org': {
          id: 'zone-rotate',
          name: 'rotate.example.org',
          accountId: CF_ACCOUNT_ID,
        },
        'remove.example.dev': {
          id: 'zone-remove',
          name: 'remove.example.dev',
          accountId: CF_ACCOUNT_ID,
        },
      },
      failOn: failures,
    });
    const project = async (slug: string) =>
      createTestProject(env.db, (await createTestUser(env.db, `${slug}-owner`)).id, slug);

    const unknownProject = await project('unknown-add');
    failures.routingDns = { message: 'routing outcome unavailable', status: 408 };
    const unknownAdd = await post(`/admin/email/${unknownProject.id}/domains/add`, adminJwt, {
      domain: 'unknown.example.com',
    });
    expect({ status: unknownAdd.status, html: await unknownAdd.text() }).toMatchObject({
      status: 409,
      html: expect.stringContaining('unknown'),
    });
    delete failures.routingDns;

    const blockedProject = await project('blocked-add');
    failures.routingDns = { message: 'routing permission denied', status: 403 };
    const blockedAdd = await post(`/admin/email/${blockedProject.id}/domains/add`, adminJwt, {
      domain: 'blocked.example.net',
    });
    expect(blockedAdd.status).toBe(409);
    expect(await blockedAdd.text()).toContain('blocked');
    delete failures.routingDns;

    const rotateProject = await project('blocked-rotate');
    expect(
      (
        await post(`/admin/email/${rotateProject.id}/domains/add`, adminJwt, {
          domain: 'rotate.example.org',
        })
      ).status,
    ).toBe(302);
    failures.secretPut = { message: 'secret permission denied', status: 403 };
    const blockedRotate = await post(
      `/admin/email/${rotateProject.id}/domains/rotate.example.org/rotate-secret`,
      adminJwt,
    );
    expect(blockedRotate.status).toBe(409);
    expect(await blockedRotate.text()).toContain('blocked');
    delete failures.secretPut;

    const removeProject = await project('unknown-remove');
    expect(
      (
        await post(`/admin/email/${removeProject.id}/domains/add`, adminJwt, {
          domain: 'remove.example.dev',
        })
      ).status,
    ).toBe(302);
    failures.scriptDelete = { message: 'delete outcome unavailable', status: 504 };
    const unknownRemove = await post(
      `/admin/email/${removeProject.id}/domains/remove.example.dev/revoke`,
      adminJwt,
      { confirm: removeProject.slug },
    );
    expect(unknownRemove.status).toBe(409);
    expect(await unknownRemove.text()).toContain('unknown');

    const failedEvents = (await env.db.select().from(operatorEvents))
      .filter((event) => event.status === 'failed')
      .map((event) => ({
        action: event.action,
        status: event.http_status,
        target: JSON.parse(event.target),
      }));
    expect(failedEvents).toHaveLength(4);
    expect(failedEvents).toEqual(
      expect.arrayContaining([
        {
          action: 'email/domains',
          status: 409,
          target: { domain: 'unknown.example.com', project: unknownProject.id },
        },
        {
          action: 'email/domains',
          status: 409,
          target: { domain: 'blocked.example.net', project: blockedProject.id },
        },
        {
          action: 'email/domains/rotate.example.org/rotate-secret',
          status: 409,
          target: { domain: 'rotate.example.org' },
        },
        {
          action: 'email/domains/remove.example.dev/remove',
          status: 409,
          target: { domain: 'remove.example.dev', force: false },
        },
      ]),
    );
  });

  test('registers, rotates and removes an exact route without exposing credential material', async () => {
    const { adminJwt, projectId, slug } = await seedAdminAndProject();
    const stub = stubCustomerCf({
      zones: {
        'example.com': { id: 'zone-platform', name: 'example.com', accountId: CF_ACCOUNT_ID },
      },
    });
    const add = await post(`/admin/email/${projectId}/domains/add`, adminJwt, {
      domain: 'example.com',
    });
    expect(add.status).toBe(302);
    const html = await (await get(`/admin/email/${projectId}`, adminJwt)).text();
    expect(html).toContain('example.com');
    expect(html).toContain('Rotate secret');
    expect(html).not.toContain(env.CF_API_TOKEN);
    expect(await env.db.select().from(emailZoneConnections)).toHaveLength(1);
    const rotate = await post(
      `/admin/email/${projectId}/domains/example.com/rotate-secret`,
      adminJwt,
    );
    expect(rotate.status).toBe(302);
    expect(callsByTag(stub.calls, 'secretPut')).toHaveLength(2);
    const unconfirmed = await post(
      `/admin/email/${projectId}/domains/example.com/revoke`,
      adminJwt,
      { confirm: 'wrong' },
    );
    expect(unconfirmed.status).toBe(400);
    expect((await env.db.select().from(emailDomainRoutes))[0]?.desired_state).toBe('active');
    const removed = await post(`/admin/email/${projectId}/domains/example.com/revoke`, adminJwt, {
      confirm: slug,
    });
    expect(removed.status).toBe(302);
    expect((await env.db.select().from(emailDomainRoutes))[0]?.desired_state).toBe('removed');
  });
});
