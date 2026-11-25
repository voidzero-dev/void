import {
  platformProjectWorkersDevHostname,
  platformWorkersDevAliasKey,
  PLATFORM_APPLICATION_KEY,
  resolvePlatformApplicationEnvironment,
} from '@void/platform';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Env } from '../../src/env.ts';
import app from '../../src/index.ts';
import { applicationEdgeCache, resolveProjectHostname } from '../../src/project-hostname.ts';

const project = { id: 'proj_123456abcdef', slug: 'kitchen-sink' };
const workersDev = { subdomain: 'test', installationId: 'team-123456abcdef' };
const application = {
  baseDomain: 'test.workers.dev',
  zoneName: '',
  dedicatedZone: false,
  workersDev,
};
const hostname = platformProjectWorkersDevHostname(project, workersDev);
function fixture() {
  const values = new Map([[platformWorkersDevAliasKey(hostname), JSON.stringify(project)]]);
  const env = {
    PLATFORM_APPLICATION: JSON.stringify(application),
    BASE_HOSTNAME: application.baseDomain,
    ROUTING: { get: vi.fn(async (key: string) => values.get(key) ?? null) },
  } as unknown as Env;
  return { env, values };
}
afterEach(() => vi.unstubAllGlobals());
describe('workers.dev routing', () => {
  it('never invokes a private Worker on the public dispatcher, including a lost privacy marker', async () => {
    const { env, values } = fixture();
    const privateProject = { ...project, slug: 'preview-app' };
    const privateHost = platformProjectWorkersDevHostname(privateProject, workersDev);
    values.set(platformWorkersDevAliasKey(privateHost), JSON.stringify(privateProject));
    values.set(
      'preview:' + privateProject.slug,
      JSON.stringify({ projectId: project.id, workerName: 'private-app' }),
    );
    const worker = vi.fn();
    Object.assign(env, { DISPATCH: { get: worker } });
    expect(
      (await app.fetch(new Request('https://' + privateHost), env, {} as ExecutionContext)).status,
    ).toBe(404);
    expect(worker).not.toHaveBeenCalled();
    values.set(
      'preview:' + privateProject.slug,
      JSON.stringify({ projectId: project.id, workerName: 'private-app', privatePreview: true }),
    );
    const authorize = vi.fn(async (req: Request) => {
      expect(req.url).toBe('https://preview.invalid/oauth/preview-serve/' + project.id);
      expect(req.headers.get('X-Void-Preview-URL')).toBe('https://' + privateHost + '/');
      expect(req.headers.has('Authorization')).toBe(false);
      return new Response('authorization required', { status: 401 });
    });
    Object.assign(env, { PREVIEW_API: { fetch: authorize } });
    expect(
      (
        await app.fetch(
          new Request('https://' + privateHost, {
            headers: {
              Authorization: 'spoofed',
              'X-Void-Preview-URL': 'https://spoofed.example.com',
            },
          }),
          env,
          {} as ExecutionContext,
        )
      ).status,
    ).toBe(401);
    expect(authorize).toHaveBeenCalledOnce();
    expect(worker).not.toHaveBeenCalled();
  });
  it('keeps the old alias and routes the new domain to the same project after activation', async () => {
    const { env, values } = fixture();
    values.set(
      PLATFORM_APPLICATION_KEY,
      JSON.stringify({ ...application, baseDomain: 'example.com', zoneName: 'example.com' }),
    );
    const active = await resolvePlatformApplicationEnvironment(env);
    expect(active).not.toBe(env);
    expect(env.BASE_HOSTNAME).toBe('test.workers.dev');
    expect(await resolveProjectHostname(hostname, active)).toMatchObject({
      slug: project.slug,
      projectId: project.id,
    });
    expect(await resolveProjectHostname('kitchen-sink.example.com', active)).toEqual({
      slug: project.slug,
      workersDev: false,
    });
  });
  it('serves the new domain and the old alias through dispatch after activation', async () => {
    const { env, values } = fixture();
    values.set(
      PLATFORM_APPLICATION_KEY,
      JSON.stringify({ ...application, baseDomain: 'example.com', zoneName: 'example.com' }),
    );
    values.set(project.slug, JSON.stringify({ projectId: project.id, workerName: 'user-app' }));
    const workerFetch = vi.fn(async (request: Request) =>
      Response.json({ origin: new URL(request.url).origin }),
    );
    const getWorker = vi.fn(() => ({ fetch: workerFetch }));
    Object.assign(env, {
      DISPATCH: { get: getWorker },
      ANALYTICS: { writeDataPoint: () => {} },
    });
    const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
    const post = (host: string) =>
      app.fetch(
        new Request(`https://${host}/api/state`, { method: 'POST', body: 'preserved' }),
        env,
        ctx,
      );
    const domainResponse = await post('kitchen-sink.example.com');
    expect(domainResponse.status).toBe(200);
    expect(await domainResponse.json()).toEqual({ origin: 'https://kitchen-sink.example.com' });
    expect((await post(hostname)).status).toBe(200);
    expect(getWorker).toHaveBeenCalledWith('user-app');
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });
  it('refuses a saved configuration belonging to a different installation', async () => {
    const { env, values } = fixture();
    values.set(
      PLATFORM_APPLICATION_KEY,
      JSON.stringify({ ...application, workersDev: { ...workersDev, installationId: 'other' } }),
    );
    await expect(resolvePlatformApplicationEnvironment(env)).rejects.toThrow('another platform');
  });
  it.each(['[', '{"id":"invalid","slug":"kitchen-sink"}'])(
    'treats invalid alias data as a missing project (%s)',
    async (raw) => {
      const { env, values } = fixture();
      values.set(platformWorkersDevAliasKey(hostname), raw);
      expect(await resolveProjectHostname(hostname, env)).toEqual({ slug: null, workersDev: true });
    },
  );
  it('fails closed when an existing route carries malformed Access policy', async () => {
    const { env, values } = fixture();
    values.set(
      project.slug,
      JSON.stringify({
        projectId: project.id,
        workerName: 'user-app',
        zeroTrust: { teamDomain: 'access.example.com' },
      }),
    );
    const worker = vi.fn();
    Object.assign(env, { DISPATCH: { get: worker } });
    const response = await app.fetch(
      new Request(`https://${hostname}/`),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(worker).not.toHaveBeenCalled();
  });
  it('does not let a recreated project inherit an old workers.dev URL', async () => {
    const { env, values } = fixture();
    values.set(
      project.slug,
      JSON.stringify({ projectId: 'proj_replacement', workerName: 'other' }),
    );
    const response = await app.fetch(
      new Request(`https://${hostname}/`),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(404);
  });
  it('honors the existing project suspension on the alias', async () => {
    const { env, values } = fixture();
    values.set(
      project.slug,
      JSON.stringify({ projectId: project.id, workerName: 'app', suspended: 'admin_suspended' }),
    );
    const response = await app.fetch(
      new Request(`https://${hostname}/`),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(429);
  });
  it('skips unpurgeable edge entries while keeping custom-domain cache behavior', async () => {
    const cache = { match: vi.fn(), put: vi.fn(), delete: vi.fn() };
    vi.stubGlobal('caches', { default: cache });
    const request = new Request(`https://${hostname}/page`);
    await applicationEdgeCache.match(request);
    await applicationEdgeCache.put(request, new Response('body'));
    await applicationEdgeCache.delete(request);
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
    expect(cache.delete).not.toHaveBeenCalled();
    await applicationEdgeCache.match(new Request('https://kitchen-sink.example.com/page'));
    expect(cache.match).toHaveBeenCalledTimes(1);
  });
});
