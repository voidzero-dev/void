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
import { signJwt } from '../../src/auth/jwt.ts';
import { createResource } from '../../src/db.ts';
import app from '../../src/index.ts';
import {
  deriveProxyInternalAuth,
  deriveProxyToken,
  type ProxyInternalRoute,
} from '../../src/proxy-token.ts';
import { deployments, projects } from '../../src/schema.ts';
import {
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  JWT_SECRET,
  mockCfApi,
  setupEnv,
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
});

/**
 * A login JWT signs `header.body` with the same key and algorithm as the
 * project token, so its parts look like a project id and its token.
 */
async function loginJwtAsProjectToken(): Promise<{ projectId: string; token: string }> {
  const jwt = await signJwt({ sub: 'user_attacker', login: 'attacker', aud: 'api' }, JWT_SECRET);
  const [header, body, signature] = jwt.split('.');
  const projectId = `${header}.${body}`;
  expect(await hmacSignState(projectId, JWT_SECRET)).toBe(signature);
  return { projectId, token: signature };
}

async function internalRequest(
  route: string,
  projectId: string,
  token: string | Record<string, string>,
  body: unknown = {},
): Promise<Response> {
  const auth = typeof token === 'string' ? { 'x-void-internal': token } : token;
  return app.fetch(
    new Request(`http://localhost/internal/${route}/${projectId}`, {
      method: route === 'ai-logging' ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      ...(route === 'ai-logging' ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
}

async function clearProxyTokenStateCache(): Promise<void> {
  const moduleUrl = new URL('../../../proxy/src/proxy-token.ts', import.meta.url).href;
  const proxyToken = (await import(/* @vite-ignore */ moduleUrl)) as {
    clearProxyTokenStateCache(): void;
  };
  proxyToken.clearProxyTokenStateCache();
}

async function proxyRequest(projectId: string, aiToken: string) {
  const proxyModuleUrl = new URL('../../../proxy/src/index.ts', import.meta.url).href;
  const proxyWorker = (
    (await import(/* @vite-ignore */ proxyModuleUrl)) as {
      default: { fetch(request: Request, env: unknown): Promise<Response> };
    }
  ).default;
  const run = vi.fn(async () => ({ response: 'ok' }));
  const response = await proxyWorker.fetch(
    new Request('https://ai-proxy/ai/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, aiToken, model: 'test-model', inputs: {} }),
    }),
    {
      ...env,
      AI: {
        run,
        models: vi.fn(async () => []),
        toMarkdown: vi.fn(async () => ({ markdown: '' })),
        gateway: vi.fn(),
      },
      API: {
        fetch: (input: string | Request, init?: RequestInit) =>
          app.fetch(new Request(input, init), env),
      },
    } as never,
  );
  return { response, run };
}

describe('per-project token checks', () => {
  it('rejects a login JWT presented as a project id and token at the proxy', async () => {
    const forged = await loginJwtAsProjectToken();
    const { response, run } = await proxyRequest(forged.projectId, forged.token);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'invalid project token' });
    expect(run).not.toHaveBeenCalled();
  });

  it('accepts a generated project id with its token at the proxy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const { response, run } = await proxyRequest(
      project.id,
      await hmacSignState(project.id, JWT_SECRET),
    );
    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledOnce();
  });

  it('rejects a login JWT presented as a project id and token at /internal/revalidate', async () => {
    const forged = await loginJwtAsProjectToken();
    const response = await internalRequest('revalidate', forged.projectId, forged.token);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'invalid internal auth' });
  });

  it.each(['resolve-resource', 'resolve-worker', 'verify-prerender-build'])(
    'rejects a login JWT presented as a project id and credential at /internal/%s',
    async (route) => {
      const forged = await loginJwtAsProjectToken();
      const asProxy = await internalRequest(route, forged.projectId, {
        'x-void-proxy-internal': forged.token,
      });
      expect(asProxy.status).toBe(403);
      expect(await asProxy.json()).toEqual({ error: 'invalid internal auth' });

      const asProject = await internalRequest(route, forged.projectId, forged.token);
      expect(asProject.status).toBe(401);
      expect(await asProject.json()).toEqual({ error: 'missing internal auth' });
    },
  );

  it('accepts a generated project id at every internal route', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await createResource(env.db, project.id, 'kv', 'cf-kv-id', 'CACHE');
    await env.ROUTING.put(project.slug, JSON.stringify({ version: deployment.id }));
    mockCfApi();
    const token = await hmacSignState(project.id, JWT_SECRET);
    const proxyAuth = async (route: ProxyInternalRoute) => ({
      'x-void-proxy-internal': await deriveProxyInternalAuth(JWT_SECRET, route, project.id),
    });

    const revalidated = await internalRequest('revalidate', project.id, token, {
      paths: ['/about'],
    });
    expect(revalidated.status).toBe(200);

    const resource = await internalRequest(
      'resolve-resource',
      project.id,
      await proxyAuth('resolve-resource'),
      { type: 'kv', binding: 'CACHE' },
    );
    expect(resource.status).toBe(200);
    expect(await resource.json()).toEqual({ cf_id: 'cf-kv-id' });

    const worker = await internalRequest(
      'resolve-worker',
      project.id,
      await proxyAuth('resolve-worker'),
    );
    expect(worker.status).toBe(200);
    expect(await worker.json()).toEqual({
      workerName: `user-${project.slug}-${deployment.id}`,
      deploymentId: deployment.id,
      proxyTokenGen: 0,
    });

    const prerender = await internalRequest(
      'verify-prerender-build',
      project.id,
      await proxyAuth('verify-prerender-build'),
      { userId: user.id },
    );
    expect(prerender.status).toBe(200);
    expect(await prerender.json()).toEqual({ ok: true });
  });
});

describe('project token generations', () => {
  async function liveProject() {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.ROUTING.put(project.slug, JSON.stringify({ version: deployment.id }));
    mockCfApi();
    return project;
  }

  async function setFloor(projectId: string, value: string) {
    await env.ROUTING.put(`proxy-token:${projectId}`, value);
  }

  beforeEach(async () => {
    await clearProxyTokenStateCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('accepts tokens at or above the floor at the proxy and rejects the legacy token', async () => {
    const project = await liveProject();
    await setFloor(project.id, '{"gen":1}');
    for (const gen of [1, 2]) {
      const { response } = await proxyRequest(
        project.id,
        await deriveProxyToken(JWT_SECRET, project.id, gen),
      );
      expect(response.status).toBe(200);
    }
    const { response, run } = await proxyRequest(
      project.id,
      await hmacSignState(project.id, JWT_SECRET),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'invalid project token' });
    expect(run).not.toHaveBeenCalled();
  });

  it('accepts the legacy and generation 1 tokens at /internal/revalidate while no floor is set', async () => {
    const project = await liveProject();
    for (const gen of [0, 1]) {
      const response = await internalRequest(
        'revalidate',
        project.id,
        await deriveProxyToken(JWT_SECRET, project.id, gen),
        { paths: ['/about'] },
      );
      expect(response.status).toBe(200);
    }
  });

  it('applies the floor at /internal/revalidate', async () => {
    const project = await liveProject();
    await setFloor(project.id, '{"gen":1}');
    for (const gen of [1, 2]) {
      const response = await internalRequest(
        'revalidate',
        project.id,
        await deriveProxyToken(JWT_SECRET, project.id, gen),
        { paths: ['/about'] },
      );
      expect(response.status).toBe(200);
    }
    const legacy = await internalRequest(
      'revalidate',
      project.id,
      await hmacSignState(project.id, JWT_SECRET),
      { paths: ['/about'] },
    );
    expect(legacy.status).toBe(403);
    expect(await legacy.json()).toEqual({ error: 'invalid internal auth' });
  });

  it('fails closed at /internal/revalidate when the floor is malformed', async () => {
    const project = await liveProject();
    await setFloor(project.id, 'not json');
    const response = await internalRequest(
      'revalidate',
      project.id,
      await hmacSignState(project.id, JWT_SECRET),
      { paths: ['/about'] },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'project token state unavailable' });
  });
});

describe('proxy credential on the metadata routes', () => {
  const routes: ReadonlyArray<ProxyInternalRoute> = [
    'resolve-worker',
    'resolve-resource',
    'verify-prerender-build',
    'ai-logging',
  ];

  async function liveProject() {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await createResource(env.db, project.id, 'kv', 'cf-kv-id', 'CACHE');
    const bodies: Record<ProxyInternalRoute, unknown> = {
      'resolve-worker': {},
      'resolve-resource': { type: 'kv', binding: 'CACHE' },
      'verify-prerender-build': { userId: user.id },
      'ai-logging': {},
    };
    const expected: Record<ProxyInternalRoute, unknown> = {
      'resolve-worker': {
        workerName: `user-${project.slug}-${deployment.id}`,
        deploymentId: deployment.id,
        proxyTokenGen: 0,
      },
      'resolve-resource': { cf_id: 'cf-kv-id' },
      'verify-prerender-build': { ok: true },
      'ai-logging': { mode: 'inherit' },
    };
    return { project, deployment, bodies, expected };
  }

  function floorReads(get: { mock: { calls: Array<Array<unknown>> } }) {
    return get.mock.calls.filter(([key]) => String(key).startsWith('proxy-token:'));
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it.each(routes)(
    'accepts the proxy credential at /internal/%s without a floor read',
    async (route) => {
      const { project, bodies, expected } = await liveProject();
      const get = vi.spyOn(env.ROUTING, 'get');
      const response = await internalRequest(
        route,
        project.id,
        { 'x-void-proxy-internal': await deriveProxyInternalAuth(JWT_SECRET, route, project.id) },
        bodies[route],
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected[route]);
      expect(floorReads(get)).toEqual([]);
    },
  );

  async function resolvedGeneration(projectId: string): Promise<unknown> {
    const response = await internalRequest(
      'resolve-worker',
      projectId,
      {
        'x-void-proxy-internal': await deriveProxyInternalAuth(
          JWT_SECRET,
          'resolve-worker',
          projectId,
        ),
      },
      {},
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { proxyTokenGen?: unknown }).proxyTokenGen;
  }

  async function setGenerations(
    projectId: string,
    issued: number,
    held: Readonly<Record<string, number>>,
  ): Promise<void> {
    await env.db
      .update(projects)
      .set({ proxy_token_gen: issued })
      .where(eq(projects.id, projectId));
    for (const [deploymentId, gen] of Object.entries(held)) {
      await env.db
        .update(deployments)
        .set({ proxy_token_gen: gen })
        .where(eq(deployments.id, deploymentId));
    }
  }

  it('reports the generation the active Worker holds from /internal/resolve-worker', async () => {
    const { project, deployment } = await liveProject();
    await setGenerations(project.id, 3, { [deployment.id]: 3 });
    expect(await resolvedGeneration(project.id)).toBe(3);
  });

  it('reports the held generation, not the issued one, when they differ', async () => {
    const { project, deployment } = await liveProject();
    await setGenerations(project.id, 2, { [deployment.id]: 0 });
    expect(await resolvedGeneration(project.id)).toBe(0);
  });

  it('reports generation 0 after a rollback to a Worker that still holds the legacy token', async () => {
    const { project, deployment: older } = await liveProject();
    const newer = await createTestDeployment(env.db, project.id, 'live');
    await setGenerations(project.id, 1, { [older.id]: 0, [newer.id]: 1 });
    expect(await resolvedGeneration(project.id)).toBe(1);

    await env.db
      .update(projects)
      .set({ active_deployment_id: older.id })
      .where(eq(projects.id, project.id));
    expect(await resolvedGeneration(project.id)).toBe(0);
  });

  it.each(routes)(
    'rejects a proxy credential made for another route at /internal/%s',
    async (route) => {
      const { project, bodies } = await liveProject();
      const other = routes.find((candidate) => candidate !== route)!;
      const response = await internalRequest(
        route,
        project.id,
        { 'x-void-proxy-internal': await deriveProxyInternalAuth(JWT_SECRET, other, project.id) },
        bodies[route],
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'invalid internal auth' });
    },
  );

  it.each(routes)(
    'does not fall back to a valid project token after a bad proxy credential at /internal/%s',
    async (route) => {
      const { project, bodies } = await liveProject();
      const response = await internalRequest(
        route,
        project.id,
        {
          'x-void-proxy-internal': await deriveProxyInternalAuth(
            JWT_SECRET,
            route,
            'proj_000000000999',
          ),
          'x-void-internal': await hmacSignState(project.id, JWT_SECRET),
        },
        bodies[route],
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'invalid internal auth' });
    },
  );

  it.each(routes)('requires the proxy credential at /internal/%s', async (route) => {
    const { project, bodies } = await liveProject();
    const missing = await internalRequest(route, project.id, {}, bodies[route]);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'missing internal auth' });

    const get = vi.spyOn(env.ROUTING, 'get');
    for (const token of [
      await hmacSignState(project.id, JWT_SECRET),
      await deriveProxyToken(JWT_SECRET, project.id, 1),
    ]) {
      const projectToken = await internalRequest(route, project.id, token, bodies[route]);
      expect(projectToken.status).toBe(401);
      expect(await projectToken.json()).toEqual({ error: 'missing internal auth' });
    }
    expect(floorReads(get)).toEqual([]);
  });
});
