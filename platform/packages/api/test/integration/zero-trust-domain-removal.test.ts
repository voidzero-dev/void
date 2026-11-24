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
import type { ApiEnv } from '../../src/env.ts';
import { app, cleanupStalePendingDomains } from '../../src/index.ts';
import { setPlatformSetting } from '../../src/platform-settings.ts';
import { domains } from '../../src/schema.ts';
import { configurePlatformZeroTrust } from '../../src/zero-trust/installation.ts';
import { PLATFORM_UNINSTALL_SETTING } from '../../src/zero-trust/lock.ts';
import { reconcilePendingProjectZeroTrust } from '../../src/zero-trust/maintenance.ts';
import { reconcileProjectZeroTrustDomains } from '../../src/zero-trust/project.ts';
import { getProjectZeroTrustState } from '../../src/zero-trust/state.ts';
import {
  clearTables,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

vi.mock('../../src/zero-trust/project.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/zero-trust/project.ts')>();
  return {
    ...original,
    reconcileProjectZeroTrustDomains: vi.fn(original.reconcileProjectZeroTrustDomains),
  };
});

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
  vi.unstubAllGlobals();
});

function bindings(): ApiEnv['Bindings'] {
  return {
    ...env,
    SITE_DOMAIN: 'apps.example.com',
    PLATFORM_INSTALLATION_ID: 'installation-test',
  } as unknown as ApiEnv['Bindings'];
}

function cloudflareApi() {
  const applications = new Map<string, Record<string, unknown>>();
  let nextApplication = 1;
  const fetcher = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
    const url = new URL(request.toString());
    if (url.pathname.includes('/custom_hostnames/')) {
      const id = url.pathname.split('/').at(-1);
      if (init?.method === 'DELETE') {
        return Response.json({ success: true, result: { id } });
      }
      // Hostnames that never finished validation.
      return Response.json({
        success: true,
        result: { id, status: 'pending', ssl: { status: 'pending_validation', method: 'http' } },
      });
    }
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

describe('Zero Trust custom domain removal', () => {
  it('lets maintenance remove a deleted hostname from Access when the follow-up reconcile never ran', async () => {
    const cloudflare = cloudflareApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const owner = await createTestUser(env.db, 'domain-removal-owner');
    const project = await createTestProject(env.db, owner.id, 'domain-removal');
    const hostnames = ['kept.customer.test', 'removed.customer.test'];
    await env.db.insert(domains).values(
      hostnames.map((hostname, index) => ({
        id: `dom_removal_${index}`,
        project_id: project.id,
        hostname,
        cf_hostname_id: `ch-removal-${index}`,
        status: 'active' as const,
      })),
    );
    for (const key of [project.slug, ...hostnames.map((hostname) => `domain:${hostname}`)]) {
      await env.ROUTING.put(
        key,
        JSON.stringify({ workerName: 'user-domain-removal', projectId: project.id }),
      );
    }
    await configurePlatformZeroTrust(bindings(), env.db, {
      apiToken: 'access-management-token',
      identityProviderIds: ['idp-1'],
      policyIds: ['policy-1'],
      protectNewProjects: true,
      existingProjects: 'protected',
    });
    const before = await getProjectZeroTrustState(env.db, project.id);
    expect(before).toMatchObject({ status: 'ready', effective_protected: true });
    const customDomainApplication = () =>
      cloudflare.applications.get(before!.protected_application_id!) as {
        destinations: Array<{ uri: string }>;
      };
    expect(customDomainApplication().destinations.map((entry) => entry.uri)).toEqual(hostnames);

    // The request stops after the domain deletion commits, before the
    // reconciliation that would rewrite the custom domain application.
    vi.mocked(reconcileProjectZeroTrustDomains).mockRejectedValueOnce(new Error('Worker stopped'));
    const removed = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_removal_1`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${owner.jwt}` },
      }),
      bindings(),
    );
    expect(removed.status).toBe(200);
    expect(await env.ROUTING.get('domain:removed.customer.test')).toBeNull();
    expect(customDomainApplication().destinations.map((entry) => entry.uri)).toEqual(hostnames);

    await reconcilePendingProjectZeroTrust(bindings(), env.db);

    expect(customDomainApplication().destinations.map((entry) => entry.uri)).toEqual([
      'kept.customer.test',
    ]);
    expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
      status: 'ready',
      effective_protected: true,
    });
  });

  it('lets maintenance remove an expired pending hostname from Access when the follow-up reconcile failed', async () => {
    const cloudflare = cloudflareApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const owner = await createTestUser(env.db, 'stale-domain-owner');
    const project = await createTestProject(env.db, owner.id, 'stale-domain');
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await env.db.insert(domains).values([
      {
        id: 'dom_stale_kept',
        project_id: project.id,
        hostname: 'kept.customer.test',
        cf_hostname_id: 'ch-stale-kept',
        status: 'active',
      },
      {
        id: 'dom_stale_expired',
        project_id: project.id,
        hostname: 'expired.customer.test',
        cf_hostname_id: 'ch-stale-expired',
        status: 'pending',
        created_at: eightDaysAgo,
      },
    ]);
    for (const key of [project.slug, 'domain:kept.customer.test']) {
      await env.ROUTING.put(
        key,
        JSON.stringify({ workerName: 'user-stale-domain', projectId: project.id }),
      );
    }
    // Configuring protects every hostname of the project, including one still
    // waiting for validation.
    await configurePlatformZeroTrust(bindings(), env.db, {
      apiToken: 'access-management-token',
      identityProviderIds: ['idp-1'],
      policyIds: ['policy-1'],
      protectNewProjects: true,
      existingProjects: 'protected',
    });
    const before = await getProjectZeroTrustState(env.db, project.id);
    expect(before).toMatchObject({ status: 'ready', effective_protected: true });
    const customDomainApplication = () =>
      cloudflare.applications.get(before!.protected_application_id!) as {
        destinations: Array<{ uri: string }>;
      };
    expect(customDomainApplication().destinations.map((entry) => entry.uri)).toEqual([
      'expired.customer.test',
      'kept.customer.test',
    ]);

    vi.mocked(reconcileProjectZeroTrustDomains).mockRejectedValueOnce(
      new Error('Access API unavailable'),
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await cleanupStalePendingDomains(bindings(), env.db, Date.now());
    errors.mockRestore();
    expect(await env.db.select().from(domains).where(eq(domains.id, 'dom_stale_expired'))).toEqual(
      [],
    );
    expect(customDomainApplication().destinations.map((entry) => entry.uri)).toEqual([
      'expired.customer.test',
      'kept.customer.test',
    ]);

    await reconcilePendingProjectZeroTrust(bindings(), env.db);

    expect(customDomainApplication().destinations.map((entry) => entry.uri)).toEqual([
      'kept.customer.test',
    ]);
    expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
      status: 'ready',
      effective_protected: true,
    });
  });

  describe('while the platform is being uninstalled', () => {
    async function seedDomain(status: 'active' | 'pending') {
      const owner = await createTestUser(env.db, 'uninstall-domain-owner');
      const project = await createTestProject(env.db, owner.id, 'uninstall-domain');
      await env.db.insert(domains).values({
        id: 'dom_uninstall',
        project_id: project.id,
        hostname: 'fenced.customer.test',
        cf_hostname_id: 'ch-uninstall',
        status,
        created_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      });
      await env.ROUTING.put(
        'domain:fenced.customer.test',
        JSON.stringify({ workerName: 'user-uninstall-domain', projectId: project.id }),
      );
      await setPlatformSetting(env.db, PLATFORM_UNINSTALL_SETTING, { startedAt: 'now' });
      return { owner, project };
    }

    async function expectDomainUntouched(fetcher: ReturnType<typeof cloudflareApi>['fetcher']) {
      expect(
        fetcher.mock.calls.filter(
          ([request, init]) =>
            request.toString().includes('/custom_hostnames/') && init?.method === 'DELETE',
        ),
      ).toEqual([]);
      expect(await env.ROUTING.get('domain:fenced.customer.test')).not.toBeNull();
      expect(
        await env.db.select().from(domains).where(eq(domains.id, 'dom_uninstall')),
      ).toHaveLength(1);
    }

    it('refuses a domain removal before deleting its hostname or route', async () => {
      const cloudflare = cloudflareApi();
      vi.stubGlobal('fetch', cloudflare.fetcher);
      const { owner, project } = await seedDomain('active');

      const removed = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/domains/dom_uninstall`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${owner.jwt}` },
        }),
        bindings(),
      );

      await expectDomainUntouched(cloudflare.fetcher);
      expect(removed.status).toBe(409);
      expect(await removed.json()).toEqual({
        error: expect.stringContaining('The platform is being uninstalled'),
      });
    });

    it('leaves an expired pending domain in place', async () => {
      const cloudflare = cloudflareApi();
      vi.stubGlobal('fetch', cloudflare.fetcher);
      await seedDomain('pending');

      await expect(cleanupStalePendingDomains(bindings(), env.db, Date.now())).rejects.toThrow(
        'The platform is being uninstalled',
      );
      await expectDomainUntouched(cloudflare.fetcher);
    });
  });
});
