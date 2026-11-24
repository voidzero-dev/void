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
import { computeAssetHash } from '../../src/assets.ts';
import { getProject } from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import app from '../../src/index.ts';
import { deployments, domains, projects } from '../../src/schema.ts';
import { configurePlatformZeroTrust } from '../../src/zero-trust/installation.ts';
import { setProjectZeroTrustProtection } from '../../src/zero-trust/project.ts';
import { getProjectZeroTrustState } from '../../src/zero-trust/state.ts';
import {
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  mockCfApi,
  readAllEvents,
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

function accessApi() {
  const applications = new Map<string, Record<string, unknown>>();
  let nextApplication = 1;
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const path = url.pathname.split('/access/')[1] ?? '';
    if (path === 'organizations') {
      return Response.json({
        success: true,
        result: { auth_domain: 'company.cloudflareaccess.com' },
      });
    }
    if (path === 'identity_providers/idp-1') {
      return Response.json({ success: true, result: { id: 'idp-1' } });
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
    if (match) {
      const id = match[1];
      const previous = applications.get(id);
      if (!previous) {
        return Response.json(
          { success: false, errors: [{ message: 'application not found' }] },
          { status: 404 },
        );
      }
      if (init?.method === 'PUT') {
        const application = { ...JSON.parse(String(init.body)), id, aud: previous.aud };
        applications.set(id, application);
        return Response.json({ success: true, result: application });
      }
      if (init?.method === 'DELETE') {
        applications.delete(id);
        return Response.json({ success: true, result: { id } });
      }
      return Response.json({ success: true, result: previous });
    }
    throw new Error(`unexpected Access request: ${url}`);
  };
}

async function deployRequest(projectId: string, jwt: string, type: 'static' | 'worker') {
  const bytes = new TextEncoder().encode('doomed replacement');
  const hash = computeAssetHash(bytes.buffer, '/index.html');
  await env.STATIC_ASSETS_R2.put(`assets/${projectId}/${hash}`, bytes.buffer);
  return new Request(`http://localhost/projects/${projectId}/deploy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      manifest: {
        version: 3,
        assetManifestVersion: 2,
        bindings: {},
        ...(type === 'static'
          ? { type: 'static', assetConfig: { not_found_handling: '404-page' } }
          : {}),
      },
      assetManifest: { '/index.html': { blake3: hash, md5: hash, size: bytes.length } },
      ...(type === 'worker'
        ? {
            workerFiles: {
              'index.js': btoa("export default { fetch() { return new Response('ok'); } }"),
            },
          }
        : {}),
    }),
  });
}

describe('deployment compensation during Zero Trust changes', () => {
  it.each(
    [
      { type: 'static' as const, protectedAfter: true },
      { type: 'static' as const, protectedAfter: false },
      { type: 'worker' as const, protectedAfter: true },
      { type: 'worker' as const, protectedAfter: false },
    ].flatMap((testCase) => [
      { ...testCase, staleRead: false },
      { ...testCase, staleRead: true },
    ]),
  )(
    'restores a $type deployment with protection=$protectedAfter and stale KV=$staleRead',
    async ({ type, protectedAfter, staleRead }) => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'compensation-protection');
      const source = await createTestDeployment(env.db, project.id, 'live');
      const sourceWorkerName = `user-${project.slug}-${source.id}`;
      await env.db
        .update(deployments)
        .set({
          retained: true,
          manifest: JSON.stringify({
            version: 3,
            type: type === 'static' ? 'static' : 'void',
            bindings: {},
          }),
        })
        .where(eq(deployments.id, source.id));
      await env.db
        .update(projects)
        .set({ type: type === 'static' ? 'static' : 'void' })
        .where(eq(projects.id, project.id));
      const sourceRoute = JSON.stringify({
        ...(type === 'static'
          ? { staticDeploymentId: source.id }
          : { workerName: sourceWorkerName }),
        projectId: project.id,
        userId: user.id,
      });
      const domainKey = 'domain:compensation.example.com';
      await env.db.insert(domains).values({
        id: 'dom_compensation',
        project_id: project.id,
        hostname: 'compensation.example.com',
        cf_hostname_id: 'cf-compensation',
        status: 'active',
      });
      await env.ROUTING.put(project.slug, sourceRoute);
      await env.ROUTING.put(domainKey, sourceRoute);

      const cloudflare = mockCfApi();
      if (type === 'worker') {
        cloudflare.seedHostScript({ scriptName: sourceWorkerName });
      }
      const workerFetch = globalThis.fetch;
      const access = accessApi();
      vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
        new URL(input.toString()).pathname.includes('/access/')
          ? access(input, init)
          : workerFetch(input, init),
      );
      const platform = {
        ...env,
        SITE_DOMAIN: 'void.app',
        PLATFORM_INSTALLATION_ID: 'installation-test',
      } as unknown as ApiEnv['Bindings'];
      await configurePlatformZeroTrust(platform, env.db, {
        apiToken: 'test-token',
        identityProviderIds: ['idp-1'],
        policyIds: ['policy-1'],
        protectNewProjects: !protectedAfter,
        existingProjects: protectedAfter ? 'public' : 'protected',
      });

      const originalPut = env.ROUTING.put.bind(env.ROUTING);
      let changed = false;
      let failedWorkerName: string | undefined;
      let latestProtection: unknown;
      let staleProtection: unknown;
      let serveStaleReads = false;
      let staleReads = 0;
      const deploymentPlatform = {
        ...platform,
        ROUTING: new Proxy(env.ROUTING, {
          get(target, property, receiver) {
            if (property !== 'get') {
              return Reflect.get(target, property, receiver);
            }
            return async (...args: Array<unknown>) => {
              const raw: unknown = await Reflect.apply(target.get, target, args);
              if (
                serveStaleReads &&
                typeof raw === 'string' &&
                (args[0] === project.slug || args[0] === domainKey)
              ) {
                staleReads += 1;
                const route = JSON.parse(raw);
                route.zeroTrust = staleProtection;
                return JSON.stringify(route);
              }
              return raw;
            };
          },
        }),
      };
      vi.spyOn(env.ROUTING, 'put').mockImplementation(async (key, value, options) => {
        // The cutover releases its project fence before publishing this checkpoint.
        if (key.startsWith('cutover-ready:') && !changed) {
          changed = true;
          const route = JSON.parse((await env.ROUTING.get(project.slug))!);
          failedWorkerName = route.workerName;
          staleProtection = route.zeroTrust;
          await setProjectZeroTrustProtection(platform, env.db, project.id, protectedAfter);
          latestProtection = JSON.parse((await env.ROUTING.get(project.slug))!).zeroTrust;
          serveStaleReads = staleRead;
          throw new Error('injected post-cutover failure');
        }
        return originalPut(key, value, options);
      });

      const response = await app.fetch(
        await deployRequest(project.id, user.jwt, type),
        deploymentPlatform,
      );
      const events = await readAllEvents(response);
      expect(events.at(-1)).toMatchObject({
        event: 'error',
        message: 'injected post-cutover failure',
      });
      expect(changed).toBe(true);
      expect(staleReads > 0).toBe(staleRead);
      expect((await getProject(env.db, project.id))?.active_deployment_id).toBe(source.id);
      expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
        desired_protected: protectedAfter,
        effective_protected: protectedAfter,
      });
      for (const key of [project.slug, domainKey]) {
        const route = JSON.parse((await env.ROUTING.get(key))!);
        expect(route.zeroTrust).toEqual(latestProtection);
        if (type === 'static') {
          expect(route.staticDeploymentId).toBe(source.id);
        } else {
          expect(route.workerName).toBe(sourceWorkerName);
        }
      }
      if (type === 'worker') {
        expect(failedWorkerName).toBeDefined();
        expect(failedWorkerName).not.toBe(sourceWorkerName);
        expect(cloudflare.state.hostScripts.has(failedWorkerName!)).toBe(false);
        expect(cloudflare.state.hostScripts.has(sourceWorkerName)).toBe(true);
      }
    },
  );
});
