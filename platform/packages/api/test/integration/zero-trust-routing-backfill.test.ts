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
import * as database from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { scheduled } from '../../src/index.ts';
import { transferOperatorProjectOwner } from '../../src/operator/tenant-service.ts';
import { setProjectsRoutingSuspension } from '../../src/routing.ts';
import { domains, projects, projectZeroTrust, users } from '../../src/schema.ts';
import { configurePlatformZeroTrust } from '../../src/zero-trust/installation.ts';
import { setProjectZeroTrustProtection } from '../../src/zero-trust/project.ts';
import { getProjectZeroTrustState } from '../../src/zero-trust/state.ts';
import {
  clearTables,
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
    SITE_DOMAIN: 'apps.example.com',
    PLATFORM_INSTALLATION_ID: 'installation-test',
    PLATFORM_CAPABILITIES: JSON.stringify({
      email: false,
      customDomains: false,
      managedBuilds: false,
      ai: false,
      githubActions: false,
      githubOAuth: false,
      googleOAuth: false,
      sandbox: false,
    }),
  } as unknown as ApiEnv['Bindings'];
}

function runHourly() {
  return scheduled(
    { cron: '0 * * * *', scheduledTime: Date.now() } as ScheduledController,
    bindings(),
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
}

async function seedRoutes(project: { id: string; slug: string }) {
  const domainKey = 'domain:backfill.example.com';
  await env.db.insert(domains).values({
    id: 'dom_backfill',
    project_id: project.id,
    hostname: 'backfill.example.com',
    cf_hostname_id: 'cf-backfill',
    status: 'active',
  });
  const route = JSON.stringify({
    workerName: 'live-worker',
    projectId: project.id,
    version: 'live-deployment',
    suspended: 'admin_suspended',
  });
  await env.ROUTING.put(project.slug, route);
  await env.ROUTING.put(domainKey, route);
  return { domainKey, route };
}

function providerError(message: string, status: number): Response {
  return Response.json({ success: false, errors: [{ message }] }, { status });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function accessApi() {
  const applications = new Map<string, Record<string, unknown>>();
  let nextApplication = 1;
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const path = url.pathname.split('/access/')[1] ?? '';
    if (path === 'organizations') {
      return Response.json({
        success: true,
        result: { auth_domain: 'company.cloudflareaccess.com' },
      });
    }
    if (path === 'identity_providers/idp-1' || path === 'identity_providers/idp-2') {
      return Response.json({ success: true, result: { id: path.split('/').at(-1) } });
    }
    if (path === 'policies/policy-1' || path === 'policies/policy-2') {
      return Response.json({
        success: true,
        result: {
          id: path.split('/').at(-1),
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
      const page = Number(url.searchParams.get('page') ?? '1');
      const perPage = Number(url.searchParams.get('per_page') ?? '100');
      const start = (page - 1) * perPage;
      return Response.json({
        success: true,
        result: [...applications.values()].slice(start, start + perPage),
      });
    }
    const match = path.match(/^apps\/([^/]+)$/);
    if (match) {
      const id = match[1]!;
      const previous = applications.get(id);
      if (!previous) {
        return providerError('application not found', 404);
      }
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const application = { ...body, id, aud: previous.aud };
        applications.set(id, application);
        return Response.json({ success: true, result: application });
      }
      if (init?.method === 'DELETE') {
        applications.delete(id);
        return Response.json({ success: true, result: { id } });
      }
      return Response.json({ success: true, result: previous });
    }
    throw new Error(`unexpected Cloudflare request: ${url}`);
  });
  return { applications, fetcher };
}

describe('legacy routing owner backfill', () => {
  it.each([
    { operation: 'backfill', protectedState: true },
    { operation: 'backfill', protectedState: false },
    { operation: 'suspension', protectedState: true },
    { operation: 'suspension', protectedState: false },
    { operation: 'ownership transfer', protectedState: true },
    { operation: 'ownership transfer', protectedState: false },
    { operation: 'suspension', protectedState: 'pending' },
  ] as const)(
    'uses database protection=$protectedState during $operation despite stale route reads',
    async ({ operation, protectedState }) => {
      const owner = await createTestUser(env.db, 'stale-route-owner');
      const newOwner = await createTestUser(env.db, 'stale-route-new-owner');
      const project = await createTestProject(env.db, owner.id, 'stale-route-project');
      const { domainKey, route } = await seedRoutes(project);
      const cloudflare = accessApi();
      vi.stubGlobal('fetch', cloudflare.fetcher);
      await configurePlatformZeroTrust(bindings(), env.db, {
        apiToken: 'test-token',
        identityProviderIds: ['idp-1'],
        policyIds: ['policy-1'],
        protectNewProjects: Boolean(protectedState),
        existingProjects: protectedState ? 'protected' : 'public',
      });
      const completedProtection = JSON.parse((await env.ROUTING.get(project.slug))!).zeroTrust;
      if (protectedState === 'pending') {
        await env.db
          .update(projectZeroTrust)
          .set({ status: 'reconciling', effective_protected: false })
          .where(eq(projectZeroTrust.project_id, project.id));
      }
      const stale = JSON.stringify({
        ...JSON.parse(route),
        ...(!protectedState
          ? { zeroTrust: { teamDomain: 'stale.cloudflareaccess.com', audiences: [] } }
          : {}),
      });
      const get = env.ROUTING.get.bind(env.ROUTING);
      const staleRead = vi.spyOn(env.ROUTING, 'get').mockImplementation((async (
        key: string,
        ...args: Array<unknown>
      ) => {
        if (key === project.slug || key === domainKey) {
          return stale;
        }
        return Reflect.apply(get, env.ROUTING, [key, ...args]);
      }) as typeof env.ROUTING.get);
      try {
        if (operation === 'backfill') {
          await runHourly();
        } else if (operation === 'suspension') {
          await setProjectsRoutingSuspension(
            env.ROUTING,
            env.db,
            [{ ...project, user_id: owner.id }],
            { op: 'unsuspend', matchReason: null },
          );
        } else {
          await transferOperatorProjectOwner(
            {
              env: bindings(),
              get: (key: string) => (key === 'db' ? env.db : { id: owner.id }),
            } as never,
            project.id,
            newOwner.id,
          );
        }
      } finally {
        staleRead.mockRestore();
      }
      for (const key of [project.slug, domainKey]) {
        const published = JSON.parse((await env.ROUTING.get(key))!);
        expect(published).toMatchObject({
          workerName: 'live-worker',
          projectId: project.id,
          version: 'live-deployment',
        });
        expect(published.zeroTrust).toEqual(
          protectedState === 'pending' ? { teamDomain: '', audiences: [] } : completedProtection,
        );
        if (operation === 'backfill') {
          expect(published.userId).toBe(owner.id);
        } else if (operation === 'ownership transfer') {
          expect(published.userId).toBe(newOwner.id);
        } else {
          expect(published.suspended).toBeUndefined();
        }
      }
    },
  );

  it.each(['slug', 'domain'] as const)(
    'serializes the %s backfill with a concurrent protection change',
    async (surface) => {
      const owner = await createTestUser(env.db, 'backfill-owner');
      await env.db
        .update(users)
        .set({ suspended_reason: 'admin_suspended' })
        .where(eq(users.id, owner.id));
      const project = await createTestProject(env.db, owner.id, 'backfill-project');
      const { domainKey } = await seedRoutes(project);
      const cloudflare = accessApi();
      vi.stubGlobal('fetch', cloudflare.fetcher);
      await configurePlatformZeroTrust(bindings(), env.db, {
        apiToken: 'test-token',
        identityProviderIds: ['idp-1'],
        policyIds: ['policy-1'],
        protectNewProjects: true,
        existingProjects: 'public',
      });
      // Configuration republishes authoritative ownership. Seed legacy
      // entries explicitly so this scheduled run exercises the backfill.
      for (const key of [project.slug, domainKey]) {
        const legacy = JSON.parse((await env.ROUTING.get(key))!);
        delete legacy.userId;
        await env.ROUTING.put(key, JSON.stringify(legacy));
      }

      let transactionDepth = 0;
      const transaction = env.db.transaction.bind(env.db);
      vi.spyOn(env.db, 'transaction').mockImplementation((callback, options) =>
        transaction(async (tx) => {
          transactionDepth++;
          try {
            return await callback(tx);
          } finally {
            transactionDepth--;
          }
        }, options),
      );
      const entered = deferred();
      const release = deferred();
      const targetKey = surface === 'slug' ? project.slug : domainKey;
      const originalPut = env.ROUTING.put.bind(env.ROUTING);
      let paused = false;
      vi.spyOn(env.ROUTING, 'put').mockImplementation(async (key, value, options) => {
        if (
          !paused &&
          key === targetKey &&
          typeof value === 'string' &&
          JSON.parse(value).userId === owner.id
        ) {
          paused = true;
          entered.resolve();
          await release.promise;
        }
        return originalPut(key, value, options);
      });
      const rollover = runHourly();
      await entered.promise;
      const depthAtBackfillWrite = transactionDepth;
      let protectionSettled = false;
      const protection = setProjectZeroTrustProtection(
        bindings(),
        env.db,
        project.id,
        true,
      ).finally(() => {
        protectionSettled = true;
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
      const settledBeforeRelease = protectionSettled;
      release.resolve();
      await Promise.all([rollover, protection]);

      expect(depthAtBackfillWrite).toBe(1);
      expect(settledBeforeRelease).toBe(false);
      expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
        effective_protected: true,
        status: 'ready',
        desired_protected: true,
      });
      for (const key of [project.slug, domainKey]) {
        const route = JSON.parse((await env.ROUTING.get(key))!);
        expect(route).toMatchObject({
          workerName: 'live-worker',
          projectId: project.id,
          userId: owner.id,
          version: 'live-deployment',
          suspended: 'admin_suspended',
        });
        expect(route.zeroTrust).toBeDefined();
      }
    },
  );

  it.each(['transfer', 'deletion'] as const)(
    'leaves slug and domain routes unchanged after a %s before the claim',
    async (change) => {
      const owner = await createTestUser(env.db, 'backfill-stale-owner');
      const newOwner = await createTestUser(env.db, 'backfill-new-owner');
      const project = await createTestProject(env.db, owner.id, 'backfill-stale-project');
      const { domainKey, route } = await seedRoutes(project);
      const getBatch = database.getUsersWithProjectsBatch;
      let changed = false;
      vi.spyOn(database, 'getUsersWithProjectsBatch').mockImplementation(async (...args) => {
        const batch = await getBatch(...args);
        if (!changed && batch.some((item) => item.projects.some((p) => p.id === project.id))) {
          changed = true;
          // The scheduled job has its old ownership snapshot, but no project lock yet.
          await env.db
            .update(projects)
            .set(change === 'transfer' ? { user_id: newOwner.id } : { status: 'deleting' })
            .where(eq(projects.id, project.id));
        }
        return batch;
      });
      await runHourly();
      expect(changed).toBe(true);
      expect(await env.ROUTING.get(project.slug)).toBe(route);
      expect(await env.ROUTING.get(domainKey)).toBe(route);
    },
  );
});
