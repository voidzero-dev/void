import { hashOriginalUrl } from '@void/isr';
import { eq } from 'drizzle-orm';
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from 'vite-plus/test';
import { hmacSignState } from '../../src/auth/hmac.ts';
import app from '../../src/index.ts';
import { createIsrStore } from '../../src/isr-store.ts';
import { domains, projectMembers } from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  createTestDeployment,
  mockCfApi,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;

// Current (`v3`) host-scoped key: `<proj>/isr/v3/<D>/<host>/<normalizedPath>`.
function isrKey(
  projectId: string,
  deploymentId: string,
  host: string,
  normalizedPath: string,
): string {
  return `${projectId}/isr/v3/${deploymentId}/${host}/${normalizedPath}`;
}

// A pre-host-scoping legacy (`v2`) key: no `<host>` segment between the
// deployment id and the normalized path, and a DIFFERENT key version. These
// entries were written before ISR keys were host-scoped and still persist (ISR
// puts set no `expirationTtl`), so revalidation must sweep the `v2` namespace
// during the rollout. The version segment (`v2` vs `v3`) keeps the legacy sweep
// disjoint from the host-scoped one — no runtime heuristic on the first
// segment. See @void/isr `ISR_LEGACY_CACHE_KEY_VERSION`.
function legacyIsrKey(projectId: string, deploymentId: string, normalizedPath: string): string {
  return `${projectId}/isr/v2/${deploymentId}/${normalizedPath}`;
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
});

describe('POST /projects/:id/revalidate', () => {
  it.each([false, true])('purges R2 pages and legacy KV edge variants (all=%s)', async (all) => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const host = `${project.slug}.void.app`;
    const direct = isrKey(project.id, deployment.id, host, 'docs');
    const variant = `${direct}#rw=${hashOriginalUrl(`https://${host}/old-docs`)}`;
    const legacy = `${legacyIsrKey(project.id, deployment.id, 'docs')}#rw=${hashOriginalUrl(`https://${host}/legacy-docs`)}`;
    const cache = createIsrStore(env.STATIC_ASSETS_R2);
    for (const key of [direct, variant]) {
      await cache.put(key, new ArrayBuffer(4), {
        metadata: { s: 200, c: Date.now(), t: 600, p: 3 },
      });
    }
    await env.ISR_CACHE.put(legacy, 'legacy body');
    const fetchMock = mockCfApi();
    const response = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(all ? { all: true } : { paths: ['/docs'] }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ purged: 1 });
    expect((await cache.getWithMetadata(direct)).value).toBeNull();
    expect((await cache.getWithMetadata(variant)).value).toBeNull();
    expect(await env.ISR_CACHE.get(legacy)).toBeNull();
    const urls = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/purge_cache'))
      .flatMap(([, options]) => JSON.parse(options!.body as string).files as Array<string>);
    expect(urls).toContain(`https://${host}/docs?__void_isr=${deployment.id}`);
    expect(urls).toContain(
      `https://${host}/docs?__void_isr=${deployment.id}&__void_orig=${hashOriginalUrl(`https://${host}/old-docs`)}`,
    );
    expect(urls).toContain(
      `https://${host}/docs?__void_isr=${deployment.id}&__void_orig=${hashOriginalUrl(`https://${host}/legacy-docs`)}`,
    );
  });

  it.each([false, true])(
    'continues edge purging when legacy KV cleanup fails (all=%s)',
    async (all) => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id);
      const deployment = await createTestDeployment(env.db, project.id, 'live');
      const host = `${project.slug}.void.app`;
      const direct = isrKey(project.id, deployment.id, host, 'docs');
      const token = hashOriginalUrl(`https://${host}/old-docs`);
      const legacy = `${legacyIsrKey(project.id, deployment.id, 'docs')}#rw=${token}`;
      const cache = createIsrStore(env.STATIC_ASSETS_R2);
      await cache.put(direct, new ArrayBuffer(4), {
        metadata: { s: 200, c: Date.now(), t: 600, p: 3 },
      });
      await env.ISR_CACHE.put(legacy, 'stale legacy HTML');
      const failure = new Error('Legacy KV unavailable');
      const remove = vi.spyOn(env.ISR_CACHE, 'delete').mockRejectedValue(failure);
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchMock = mockCfApi();

      const response = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/revalidate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(all ? { all: true } : { paths: ['/docs'] }),
        }),
        env,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ purged: 1 });
      expect((await cache.getWithMetadata(direct)).value).toBeNull();
      expect(await env.ISR_CACHE.get(legacy)).toBe('stale legacy HTML');
      expect(remove).toHaveBeenCalledWith(legacy);
      expect(warning).toHaveBeenCalledWith('[api] Legacy ISR KV cleanup failed.', failure);
      const urls = fetchMock.mock.calls
        .filter(([url]) => String(url).includes('/purge_cache'))
        .flatMap(([, options]) => JSON.parse(options!.body as string).files as Array<string>);
      expect(urls).toEqual(
        expect.arrayContaining([
          `https://${host}/docs?__void_isr=${deployment.id}`,
          `https://${host}/docs?__void=json&__void_isr=${deployment.id}`,
          `https://${host}/docs?__void_isr=${deployment.id}&__void_orig=${token}`,
          `https://${host}/docs?__void=json&__void_isr=${deployment.id}&__void_orig=${token}`,
        ]),
      );
    },
  );

  it('returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_fake/revalidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 for nonexistent project', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects/proj_nonexistent/revalidate', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ all: true }),
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 for non-owner', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const other = await createTestUser(env.db, 'other');
    const project = await createTestProject(env.db, owner.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${other.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ all: true }),
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('rechecks deploy access after body parsing before purging cache state', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const collaborator = await createTestUser(env.db, 'collaborator');
    const project = await createTestProject(env.db, owner.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: collaborator.id,
      role: 'collaborator',
      added_by_user_id: owner.id,
    });
    const key = isrKey(project.id, deployment.id, `${project.slug}.void.app`, 'cached');
    await env.ISR_CACHE.put(key, 'cached');
    const fetchMock = mockCfApi();
    const bodyStream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = bodyStream.writable.getWriter();
    const request = new Request(`http://localhost/projects/${project.id}/revalidate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${collaborator.jwt}`,
        'Content-Type': 'application/json',
      },
      body: bodyStream.readable,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const responsePromise = app.fetch(request, env);
    await writer.write(new TextEncoder().encode(JSON.stringify({ paths: ['/cached'] })));
    // The initial deploy-capability check has already passed. A downgrade
    // committed while the body is read must prevent both R2 and edge purges.
    await env.db
      .update(projectMembers)
      .set({ role: 'reader' })
      .where(eq(projectMembers.user_id, collaborator.id));
    await writer.close();
    const res = await responsePromise;

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: expect.stringMatching(/Ask (a project admin or owner|the owner)/),
    });
    expect(await env.ISR_CACHE.get(key)).toBe('cached');
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/purge_cache')),
    ).toHaveLength(0);
  });

  it('returns 400 without paths or all', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('purges rewrite-variant KV entries and edge URLs for the requested path', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // Direct-hit and rewrite-variant entries for the same pathname.
    const directKey = isrKey(project.id, deployment.id, `${project.slug}.void.app`, 'en/docs');
    // Token computed with the same hash dispatch uses (FNV-1a 64-bit hex).
    // Purger only knows the hashed token; original URL is not recoverable.
    const originalUrl = `https://${project.slug}.void.app/docs`;
    const token = hashOriginalUrl(originalUrl);
    const variantKey = `${directKey}#rw=${token}`;
    await env.ISR_CACHE.put(directKey, 'direct');
    await env.ISR_CACHE.put(variantKey, 'rewritten');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/en/docs'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await env.ISR_CACHE.get(directKey)).toBeNull();
    expect(await env.ISR_CACHE.get(variantKey)).toBeNull();

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    // Direct-hit edge URLs (html + json).
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/en/docs?__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/en/docs?__void=json&__void_isr=${deployment.id}`,
    );
    // Rewrite-variant edge URLs (reconstructed from the decoded token).
    expect(
      purgedFiles.some((u) =>
        u.startsWith(
          `https://${project.slug}.void.app/en/docs?__void_isr=${deployment.id}&__void_orig=`,
        ),
      ),
    ).toBe(true);
  });

  it('purges a legacy hostless rewrite-variant KV entry and edge URL for the requested path', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // Pre-host-scoping rewrite variant: `<proj>/isr/v2/<D>/en/docs#rw=<token>`
    // (NO `<host>` segment). Written before ISR keys were host-scoped; still
    // persists (ISR puts set no expirationTtl). The host-scoped variant scan
    // cannot see it, so only the legacy scan can recover its token and purge
    // the stale edge entry.
    const originalUrl = `https://${project.slug}.void.app/docs`;
    const token = hashOriginalUrl(originalUrl);
    const legacyVariantKey = `${legacyIsrKey(project.id, deployment.id, 'en/docs')}#rw=${token}`;
    await env.ISR_CACHE.put(legacyVariantKey, 'legacy-rewritten');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/en/docs'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    // The orphaned legacy KV key must be deleted (dead-weight cleanup).
    expect(await env.ISR_CACHE.get(legacyVariantKey)).toBeNull();

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    // The stale edge variant URL must be purged for the hostname carrying this
    // deployment, reconstructed from the recovered token (html + json).
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/en/docs?__void_isr=${deployment.id}&__void_orig=${token}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/en/docs?__void=json&__void_isr=${deployment.id}&__void_orig=${token}`,
    );
  });

  it('does not mistake a host-scoped rewrite-variant key for a legacy one', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // Only a HOST-SCOPED (v3) variant key exists:
    // `<proj>/isr/v3/<D>/<slug>.void.app/en/docs#rw=<token>`. The v3 scan must
    // delete + purge it. The legacy hostless scan (prefix
    // `<proj>/isr/v2/<D>/en/docs#rw=`) must NOT match it — the v2/v3 version
    // segment keeps the two namespaces disjoint — so no phantom duplicate purge
    // is emitted.
    const originalUrl = `https://${project.slug}.void.app/docs`;
    const token = hashOriginalUrl(originalUrl);
    const directKey = isrKey(project.id, deployment.id, `${project.slug}.void.app`, 'en/docs');
    const hostScopedVariantKey = `${directKey}#rw=${token}`;
    await env.ISR_CACHE.put(hostScopedVariantKey, 'host-scoped-rewritten');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/en/docs'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    // Host-scoped variant is still purged.
    expect(await env.ISR_CACHE.get(hostScopedVariantKey)).toBeNull();

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    const variantUrls = purgedFiles.filter((u) => u.includes('__void_orig='));
    // Exactly the html + json variant URLs for the single host-scoped key —
    // the legacy scan found nothing, so there is no phantom third URL.
    expect(variantUrls).toContain(
      `https://${project.slug}.void.app/en/docs?__void_isr=${deployment.id}&__void_orig=${token}`,
    );
    expect(variantUrls).toContain(
      `https://${project.slug}.void.app/en/docs?__void=json&__void_isr=${deployment.id}&__void_orig=${token}`,
    );
    expect(variantUrls).toHaveLength(2);
  });

  it('purges a legacy hostless direct key (v2) for the requested path', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // Pre-host-scoping direct-hit key: `<proj>/isr/v2/<D>/about` (no host
    // segment, prior key version). The v3 scan can't see it; the transition-only
    // v2 legacy sweep must reap it. Its edge URL is the same host+path+id URL the
    // v3 direct-hit purge already queues for the resolved hostname.
    const legacyDirectKey = legacyIsrKey(project.id, deployment.id, 'about');
    await env.ISR_CACHE.put(legacyDirectKey, 'legacy-about');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/about'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    // The orphaned legacy direct key must be deleted (dead-weight cleanup).
    expect(await env.ISR_CACHE.get(legacyDirectKey)).toBeNull();

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    // The edge URL for the resolved hostname (html + json) — covered by the v3
    // direct-hit purge (the edge URL carries no key version).
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void=json&__void_isr=${deployment.id}`,
    );
  });

  it('paths: a v3 host-scoped key and a v2 legacy dotted-path key are handled independently', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // example.com is a resolved (attached) hostname.
    await env.db.insert(domains).values({
      id: 'dom_collision_paths',
      project_id: project.id,
      hostname: 'example.com',
      cf_hostname_id: 'ch-collision-paths',
      status: 'active',
    });

    // Two keys that would ALIAS under a single key version:
    //   v3 host-scoped: (host=example.com, /about) -> `<proj>/isr/v3/<D>/example.com/about`
    //   v2 legacy page /example.com/about          -> `<proj>/isr/v2/<D>/example.com/about`
    const v3Key = isrKey(project.id, deployment.id, 'example.com', 'about');
    const v2Key = legacyIsrKey(project.id, deployment.id, 'example.com/about');
    await env.ISR_CACHE.put(v3Key, 'v3-host-scoped');
    await env.ISR_CACHE.put(v2Key, 'v2-legacy-dotted');

    // Request ONLY the legacy path. The v2 sweep must reap the v2 key but must
    // NOT touch the v3 key — proving the two are handled independently.
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/example.com/about'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    // v2 legacy key deleted...
    expect(await env.ISR_CACHE.get(v2Key)).toBeNull();
    // ...and the v3 host-scoped key SURVIVES (not caught by the legacy scan).
    expect(await env.ISR_CACHE.get(v3Key)).toBe('v3-host-scoped');

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    // The legacy key's edge purge targets `https://<host>/example.com/about?...`
    // (the real path under each resolved hostname) — NOT the mis-parsed
    // `https://example.com/about?...` that would treat the leading segment as a host.
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/example.com/about?__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://example.com/example.com/about?__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).not.toContain(`https://example.com/about?__void_isr=${deployment.id}`);
  });

  it('purges specific paths from KV and edge cache', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // Seed ISR cache entries
    await env.ISR_CACHE.put(
      isrKey(project.id, deployment.id, `${project.slug}.void.app`, '__index__'),
      'home',
    );
    await env.ISR_CACHE.put(
      isrKey(project.id, deployment.id, `${project.slug}.void.app`, 'about'),
      'about',
    );
    await env.ISR_CACHE.put(
      isrKey(project.id, deployment.id, `${project.slug}.void.app`, 'blog/hello'),
      'blog post',
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/', '/about'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged: number };
    expect(body.purged).toBe(2);

    // Verify purged entries are gone
    const home = await env.ISR_CACHE.get(
      isrKey(project.id, deployment.id, `${project.slug}.void.app`, '__index__'),
    );
    expect(home).toBeNull();
    const about = await env.ISR_CACHE.get(
      isrKey(project.id, deployment.id, `${project.slug}.void.app`, 'about'),
    );
    expect(about).toBeNull();
    // blog/hello should still exist
    const blog = await env.ISR_CACHE.get(
      isrKey(project.id, deployment.id, `${project.slug}.void.app`, 'blog/hello'),
    );
    expect(blog).not.toBeNull();

    // Verify edge cache purge was called with correct URLs
    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    expect(purgedFiles).toContain(`https://${project.slug}.void.app/?__void_isr=${deployment.id}`);
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/?__void=json&__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void=json&__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toHaveLength(4);
  });

  it('also purges the database active deployment when routing KV is stale', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const previousDeployment = await createTestDeployment(env.db, project.id, 'live');
    const activeDeployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    await env.ROUTING.put(project.slug, JSON.stringify({ version: previousDeployment.id }));
    await env.ISR_CACHE.put(
      isrKey(project.id, previousDeployment.id, `${project.slug}.void.app`, 'about'),
      'previous',
    );
    await env.ISR_CACHE.put(
      isrKey(project.id, activeDeployment.id, `${project.slug}.void.app`, 'about'),
      'active',
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/about'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    // `purged` reflects the caller's unique path entries, not the raw count of
    // KV keys deleted across drift-hedge namespaces.
    const driftBody = (await res.json()) as { purged: number };
    expect(driftBody.purged).toBe(1);
    expect(
      await env.ISR_CACHE.get(
        isrKey(project.id, activeDeployment.id, `${project.slug}.void.app`, 'about'),
      ),
    ).toBeNull();
    expect(
      await env.ISR_CACHE.get(
        isrKey(project.id, previousDeployment.id, `${project.slug}.void.app`, 'about'),
      ),
    ).toBeNull();

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void_isr=${activeDeployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void_isr=${previousDeployment.id}`,
    );
    // Both deployment ids are also purged with the __void=json variant
    // (pages protocol edge cache key).
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void=json&__void_isr=${activeDeployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void=json&__void_isr=${previousDeployment.id}`,
    );
  });

  it('also purges the routing deployment when the database active deployment is stale', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const databaseActiveDeployment = await createTestDeployment(env.db, project.id, 'live');
    const routingDeployment = await createTestDeployment(env.db, project.id, 'failed');
    const fetchMock = mockCfApi();

    await env.ROUTING.put(project.slug, JSON.stringify({ version: routingDeployment.id }));
    await env.ISR_CACHE.put(
      isrKey(project.id, databaseActiveDeployment.id, `${project.slug}.void.app`, 'about'),
      'database',
    );
    await env.ISR_CACHE.put(
      isrKey(project.id, routingDeployment.id, `${project.slug}.void.app`, 'about'),
      'routing',
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/about'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const driftBody = (await res.json()) as { purged: number };
    expect(driftBody.purged).toBe(1);
    expect(
      await env.ISR_CACHE.get(
        isrKey(project.id, databaseActiveDeployment.id, `${project.slug}.void.app`, 'about'),
      ),
    ).toBeNull();
    expect(
      await env.ISR_CACHE.get(
        isrKey(project.id, routingDeployment.id, `${project.slug}.void.app`, 'about'),
      ),
    ).toBeNull();

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void_isr=${databaseActiveDeployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void_isr=${routingDeployment.id}`,
    );
  });

  it('purges all ISR entries with all: true', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // Seed ISR cache entries
    await env.ISR_CACHE.put(
      isrKey(project.id, deployment.id, `${project.slug}.void.app`, '__index__'),
      'home',
    );
    await env.ISR_CACHE.put(
      isrKey(project.id, deployment.id, `${project.slug}.void.app`, 'about'),
      'about',
    );
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ all: true }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged: number };
    expect(body.purged).toBe(2);

    // Verify all ISR entries are gone
    const home = await env.ISR_CACHE.get(
      isrKey(project.id, deployment.id, `${project.slug}.void.app`, '__index__'),
    );
    expect(home).toBeNull();
    const about = await env.ISR_CACHE.get(
      isrKey(project.id, deployment.id, `${project.slug}.void.app`, 'about'),
    );
    expect(about).toBeNull();

    // Verify edge cache purge with correct pathnames derived from KV keys
    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    expect(purgedFiles).toContain(`https://${project.slug}.void.app/?__void_isr=${deployment.id}`);
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/?__void=json&__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void=json&__void_isr=${deployment.id}`,
    );
  });

  it('purges a single-segment legacy (hostless) key on all: true', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // Genuine pre-host-scoping key: `<proj>/isr/v2/<D>/about` (no host segment).
    const key = legacyIsrKey(project.id, deployment.id, 'about');
    await env.ISR_CACHE.put(key, 'legacy-about');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ all: true }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged: number };
    expect(body.purged).toBe(1);

    // The legacy KV key must be deleted.
    expect(await env.ISR_CACHE.get(key)).toBeNull();

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    // Edge purge must be issued for the resolved hostname carrying this
    // deployment (html + json), reconstructed from the bare path.
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void=json&__void_isr=${deployment.id}`,
    );
  });

  it('purges a nested legacy (hostless) key on all: true without mis-parsing the host', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // Genuine nested pre-host-scoping key: `<proj>/isr/v2/<D>/blog/post`.
    // Splitting on the first slash would mis-parse host=`blog`, path=`/post`
    // and purge garbage `https://blog/post?...`.
    const key = legacyIsrKey(project.id, deployment.id, 'blog/post');
    await env.ISR_CACHE.put(key, 'legacy-blog-post');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ all: true }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged: number };
    expect(body.purged).toBe(1);

    expect(await env.ISR_CACHE.get(key)).toBeNull();

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    // The real path is purged under the resolved hostname...
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/blog/post?__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/blog/post?__void=json&__void_isr=${deployment.id}`,
    );
    // ...and the garbage host-as-`blog` URL is NOT purged.
    expect(purgedFiles.some((u) => u.includes('://blog/'))).toBe(false);
  });

  it('still parses a host-scoped key whose first segment is a resolved hostname on all: true', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // First segment IS the resolved slug hostname — must be treated as
    // host-scoped, not mistaken for a legacy nested path.
    await env.ISR_CACHE.put(
      isrKey(project.id, deployment.id, `${project.slug}.void.app`, 'blog/post'),
      'host-scoped',
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ all: true }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged: number };
    expect(body.purged).toBe(1);

    expect(
      await env.ISR_CACHE.get(
        isrKey(project.id, deployment.id, `${project.slug}.void.app`, 'blog/post'),
      ),
    ).toBeNull();

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/blog/post?__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/blog/post?__void=json&__void_isr=${deployment.id}`,
    );
  });

  it('purges a legacy hostless rewrite-variant key (v2) on all: true', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // Pre-host-scoping rewrite variant: `<proj>/isr/v2/<D>/en/docs#rw=<token>`
    // (hostless, prior key version). The transition-only v2 legacy scan must
    // recover the token and edge-purge the stale `__void_orig` URL.
    const originalUrl = `https://${project.slug}.void.app/docs`;
    const token = hashOriginalUrl(originalUrl);
    const legacyVariantKey = `${legacyIsrKey(project.id, deployment.id, 'en/docs')}#rw=${token}`;
    await env.ISR_CACHE.put(legacyVariantKey, 'legacy-rewritten');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ all: true }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged: number };
    expect(body.purged).toBe(1);
    // The orphaned legacy variant key must be deleted.
    expect(await env.ISR_CACHE.get(legacyVariantKey)).toBeNull();

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    // The stale edge variant URL, reconstructed from the recovered token, is
    // purged for the resolved hostname (html + json).
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/en/docs?__void_isr=${deployment.id}&__void_orig=${token}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/en/docs?__void=json&__void_isr=${deployment.id}&__void_orig=${token}`,
    );
  });

  it('all: a v3 host-scoped key and a v2 legacy dotted-path key are purged independently', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    await env.db.insert(domains).values({
      id: 'dom_collision_all',
      project_id: project.id,
      hostname: 'example.com',
      cf_hostname_id: 'ch-collision-all',
      status: 'active',
    });

    // Same aliasing pair as the paths collision test:
    //   v3 host-scoped: (host=example.com, /about) -> `<proj>/isr/v3/<D>/example.com/about`
    //   v2 legacy page /example.com/about          -> `<proj>/isr/v2/<D>/example.com/about`
    const v3Key = isrKey(project.id, deployment.id, 'example.com', 'about');
    const v2Key = legacyIsrKey(project.id, deployment.id, 'example.com/about');
    await env.ISR_CACHE.put(v3Key, 'v3-host-scoped');
    await env.ISR_CACHE.put(v2Key, 'v2-legacy-dotted');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ all: true }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    // Two DISTINCT pathnames counted independently: /about (from the v3 key) and
    // /example.com/about (from the v2 key).
    const body = (await res.json()) as { purged: number };
    expect(body.purged).toBe(2);

    // Each key is deleted by its own version's scan (disjoint prefixes).
    expect(await env.ISR_CACHE.get(v3Key)).toBeNull();
    expect(await env.ISR_CACHE.get(v2Key)).toBeNull();

    // The v3 and v2 scans flush separately (per-page), so aggregate across calls.
    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    const purgedFiles = purgeCalls.flatMap(
      (call) => JSON.parse(call[1]!.body as string).files as Array<string>,
    );
    // v3 key -> host=example.com, path=/about.
    expect(purgedFiles).toContain(`https://example.com/about?__void_isr=${deployment.id}`);
    // v2 legacy key -> path=/example.com/about, fanned across resolved hostnames.
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/example.com/about?__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://example.com/example.com/about?__void_isr=${deployment.id}`,
    );
  });

  it('includes custom domain URLs in edge cache purge', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // Add a custom domain
    await env.db.insert(domains).values({
      id: 'dom_test1',
      project_id: project.id,
      hostname: 'example.com',
      cf_hostname_id: 'ch-test-id',
      status: 'active',
    });

    await env.ISR_CACHE.put(
      isrKey(project.id, deployment.id, `${project.slug}.void.app`, 'about'),
      'about',
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/about'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    // slug domain + custom domain, HTML + JSON each = 4 URLs
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void=json&__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toContain(`https://example.com/about?__void_isr=${deployment.id}`);
    expect(purgedFiles).toContain(
      `https://example.com/about?__void=json&__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toHaveLength(4);
  });

  it('batches purge requests for >100 URLs', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // Create 51 paths × 2 variants (HTML+JSON) = 102 URLs → needs 2 batches
    const paths: Array<string> = [];
    for (let i = 0; i < 51; i++) {
      const path = `/page-${i}`;
      paths.push(path);
      await env.ISR_CACHE.put(
        isrKey(project.id, deployment.id, `${project.slug}.void.app`, `page-${i}`),
        `content-${i}`,
      );
    }

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths }),
      }),
      env,
    );

    expect(res.status).toBe(200);

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    // 51 paths × 2 variants = 102 URLs → 2 batches (100 + 2)
    expect(purgeCalls.length).toBe(2);

    const batch1 = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    const batch2 = JSON.parse(purgeCalls[1][1]!.body as string).files as Array<string>;
    expect(batch1).toHaveLength(100);
    expect(batch2).toHaveLength(2);
  });

  it('logs edge cache purge failures after deleting the KV entry', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    mockCfApi({
      purgeCache: () =>
        Response.json({ success: false, errors: [{ code: 1000, message: 'fail' }] }),
    });

    await env.ISR_CACHE.put(
      isrKey(project.id, deployment.id, `${project.slug}.void.app`, 'about'),
      'about',
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/about'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);

    const about = await env.ISR_CACHE.get(
      isrKey(project.id, deployment.id, `${project.slug}.void.app`, 'about'),
    );
    expect(about).toBeNull();
    expect(error).toHaveBeenCalledWith(
      '[api] ISR edge cache purge failed; stale entries may remain until their TTL expires.',
      expect.any(Error),
    );
  });

  it('purges each hostname under its own routing version', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const oldDeployment = await createTestDeployment(env.db, project.id, 'live');
    const newDeployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // slug moved to NEW, active_deployment_id is NEW (set by the second
    // `createTestDeployment` call). The domain:* routing entry is stuck
    // on OLD — this mirrors the partial-failure deploy branch in
    // `deploy.ts` where the slug routing write succeeded but the
    // per-domain routing loop failed and the deploy stayed "live".
    await env.ROUTING.put(project.slug, JSON.stringify({ version: newDeployment.id }));
    await env.ROUTING.put('domain:example.com', JSON.stringify({ version: oldDeployment.id }));
    await env.db.insert(domains).values({
      id: 'dom_drift',
      project_id: project.id,
      hostname: 'example.com',
      cf_hostname_id: 'ch-drift',
      status: 'active',
    });

    await env.ISR_CACHE.put(
      isrKey(project.id, newDeployment.id, `${project.slug}.void.app`, 'about'),
      'new',
    );
    await env.ISR_CACHE.put(isrKey(project.id, oldDeployment.id, 'example.com', 'about'), 'old');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/about'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const driftBody = (await res.json()) as { purged: number };
    expect(driftBody.purged).toBe(1);

    // Both deployment namespaces are scanned and deleted in KV
    expect(
      await env.ISR_CACHE.get(
        isrKey(project.id, newDeployment.id, `${project.slug}.void.app`, 'about'),
      ),
    ).toBeNull();
    expect(
      await env.ISR_CACHE.get(isrKey(project.id, oldDeployment.id, 'example.com', 'about')),
    ).toBeNull();

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;

    // Slug hostname uses NEW version (both HTML + JSON variants)
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void_isr=${newDeployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void=json&__void_isr=${newDeployment.id}`,
    );
    // Custom domain uses OLD version
    expect(purgedFiles).toContain(`https://example.com/about?__void_isr=${oldDeployment.id}`);
    expect(purgedFiles).toContain(
      `https://example.com/about?__void=json&__void_isr=${oldDeployment.id}`,
    );
    // Custom domain also picks up the active_deployment_id hedge (NEW)
    expect(purgedFiles).toContain(`https://example.com/about?__void_isr=${newDeployment.id}`);
    expect(purgedFiles).toContain(
      `https://example.com/about?__void=json&__void_isr=${newDeployment.id}`,
    );
  });

  it('purges a routed but still-pending custom domain (activation crash window)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // Activation writes the `domain:<host>` KV route BEFORE flipping the DB row
    // to `active` (`activate-domain.ts` — `ROUTING.put` then
    // `updateDomainStatus`). A crash in that window strands a `pending` row that
    // dispatch already serves — and ISR-caches — under its own host-scoped keys.
    // The targeted purge must still reach it; an active-only target filter would
    // miss the pending host entirely.
    await env.ROUTING.put(project.slug, JSON.stringify({ version: deployment.id }));
    await env.ROUTING.put('domain:pending.example.com', JSON.stringify({ version: deployment.id }));
    await env.db.insert(domains).values({
      id: 'dom_pending_routed',
      project_id: project.id,
      hostname: 'pending.example.com',
      cf_hostname_id: 'ch-pending-routed',
      status: 'pending',
    });

    await env.ISR_CACHE.put(
      isrKey(project.id, deployment.id, 'pending.example.com', 'about'),
      'pending-host',
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/about'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    // The pending host's host-scoped ISR key must be deleted.
    expect(
      await env.ISR_CACHE.get(isrKey(project.id, deployment.id, 'pending.example.com', 'about')),
    ).toBeNull();

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    // The pending host's edge URL must be purged (html + json).
    expect(purgedFiles).toContain(`https://pending.example.com/about?__void_isr=${deployment.id}`);
    expect(purgedFiles).toContain(
      `https://pending.example.com/about?__void=json&__void_isr=${deployment.id}`,
    );
  });

  it('falls back to the legacy namespace for versionless routing entries', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const activeDeployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // Versionless routing entry (pre-v2 legacy shape).
    await env.ROUTING.put(project.slug, JSON.stringify({ projectId: project.id }));
    await env.ISR_CACHE.put(
      isrKey(project.id, 'legacy', `${project.slug}.void.app`, 'about'),
      'legacy-hit',
    );
    await env.ISR_CACHE.put(
      isrKey(project.id, activeDeployment.id, `${project.slug}.void.app`, 'about'),
      'active',
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/about'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    // Both the 'legacy' namespace (matching dispatch's `?? 'legacy'`)
    // and the active_deployment_id hedge are purged from KV.
    expect(
      await env.ISR_CACHE.get(isrKey(project.id, 'legacy', `${project.slug}.void.app`, 'about')),
    ).toBeNull();
    expect(
      await env.ISR_CACHE.get(
        isrKey(project.id, activeDeployment.id, `${project.slug}.void.app`, 'about'),
      ),
    ).toBeNull();

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    expect(purgedFiles).toContain(`https://${project.slug}.void.app/about?__void_isr=legacy`);
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void_isr=${activeDeployment.id}`,
    );
  });

  it('matches dispatch nullish semantics when routing.version is an empty string', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const fetchMock = mockCfApi();

    // Dispatch's `routing.version ?? 'legacy'` yields `''` (not `'legacy'`)
    // when `version` is the empty string — nullish coalescing only catches
    // null/undefined. Dispatch would write ISR under
    // `<projectId>/isr/v3//<host>/<path>` (the empty deployment-id segment yields
    // the `v3//` double slash).
    await env.ROUTING.put(project.slug, JSON.stringify({ version: '' }));
    await env.ISR_CACHE.put(
      isrKey(project.id, '', `${project.slug}.void.app`, 'about'),
      'stored-under-empty-id',
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/about'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged: number };
    expect(body.purged).toBe(1);
    // The empty-deployment-id key must be deleted — this is the key dispatch
    // actually wrote, so the resolver + prefix logic must target it exactly.
    expect(
      await env.ISR_CACHE.get(isrKey(project.id, '', `${project.slug}.void.app`, 'about')),
    ).toBeNull();

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    // Edge cache purge uses `__void_isr=` (empty value) for the empty-id set,
    // matching the cache key dispatch would have used when serving.
    expect(purgedFiles).toContain(`https://${project.slug}.void.app/about?__void_isr=`);
    expect(purgedFiles).toContain(`https://${project.slug}.void.app/about?__void=json&__void_isr=`);
  });
});

describe('POST /internal/revalidate/:id', () => {
  it('purges each hostname under its own routing version (HMAC auth)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const oldDeployment = await createTestDeployment(env.db, project.id, 'live');
    const newDeployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    await env.ROUTING.put(project.slug, JSON.stringify({ version: newDeployment.id }));
    await env.ROUTING.put('domain:example.com', JSON.stringify({ version: oldDeployment.id }));
    await env.db.insert(domains).values({
      id: 'dom_internal_drift',
      project_id: project.id,
      hostname: 'example.com',
      cf_hostname_id: 'ch-internal-drift',
      status: 'active',
    });

    await env.ISR_CACHE.put(
      isrKey(project.id, newDeployment.id, `${project.slug}.void.app`, 'about'),
      'new',
    );
    await env.ISR_CACHE.put(isrKey(project.id, oldDeployment.id, 'example.com', 'about'), 'old');

    const token = await hmacSignState(project.id, env.JWT_SECRET);
    const res = await app.fetch(
      new Request(`http://localhost/internal/revalidate/${project.id}`, {
        method: 'POST',
        headers: {
          'x-void-internal': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/about'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const hmacBody = (await res.json()) as { purged: number };
    expect(hmacBody.purged).toBe(1);
    expect(
      await env.ISR_CACHE.get(
        isrKey(project.id, newDeployment.id, `${project.slug}.void.app`, 'about'),
      ),
    ).toBeNull();
    expect(
      await env.ISR_CACHE.get(isrKey(project.id, oldDeployment.id, 'example.com', 'about')),
    ).toBeNull();

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void_isr=${newDeployment.id}`,
    );
    expect(purgedFiles).toContain(`https://example.com/about?__void_isr=${oldDeployment.id}`);
  });
});
