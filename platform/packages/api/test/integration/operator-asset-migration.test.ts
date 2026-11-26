import { Buffer } from 'node:buffer';
import { eq, sql } from 'drizzle-orm';
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
import type { Env as DispatchEnv } from '../../../dispatch/src/env.ts';
import { computeAssetHash, KV_THRESHOLD } from '../../src/assets.ts';
import { getDeployment, getProject } from '../../src/db.ts';
import { app } from '../../src/index.ts';
import { deployments, projects } from '../../src/schema.ts';
import {
  clearTables,
  createOperatorToken,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;
let owner: Awaited<ReturnType<typeof createTestUser>>;
let token: string;
let memoryR2Get: TestEnv['STATIC_ASSETS_R2']['get'];
let memoryR2Put: TestEnv['STATIC_ASSETS_R2']['put'];
let r2Metadata: Map<string, R2HTTPMetadata>;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await teardownEnv();
});
beforeEach(async () => {
  memoryR2Get = env.STATIC_ASSETS_R2.get.bind(env.STATIC_ASSETS_R2);
  r2Metadata = new Map();
  memoryR2Put = env.STATIC_ASSETS_R2.put.bind(env.STATIC_ASSETS_R2);
  vi.spyOn(env.STATIC_ASSETS_R2, 'put').mockImplementation(async (key, value, options) => {
    const result = await memoryR2Put(key, value, options);
    if (result && options?.httpMetadata && !(options.httpMetadata instanceof Headers)) {
      r2Metadata.set(key, options.httpMetadata);
    }
    return result;
  });
  streamingR2(undefined, false);
  await clearTables(env.db);
  owner = await createTestUser(env.db, 'asset-operator', 'github', undefined, 'free', 'admin');
  token = await createOperatorToken(env.db, owner);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Asset = { hash: string; size: number; bytes: ArrayBuffer; path: string; store?: 'kv' | 'r2' };
type Result = {
  dryRun?: boolean;
  action?: string;
  target?: string;
  expected?: unknown;
  complete: boolean;
  nextCursor: string | null;
};

function asset(
  path = '/index.html',
  contents: string | Uint8Array = 'Hello from the existing app',
  store?: 'kv' | 'r2',
): Asset {
  const bytes = (
    typeof contents === 'string' ? new TextEncoder().encode(contents) : contents
  ).slice().buffer;
  return {
    path,
    bytes,
    hash: computeAssetHash(bytes, path),
    size: bytes.byteLength,
    ...(store ? { store } : {}),
  };
}
function metadata(entries: Array<Asset>) {
  return Object.fromEntries(
    entries.map(({ path, hash, size, store }) => [
      path,
      { hash, size, ...(store ? { store } : {}) },
    ]),
  );
}
function streamingR2(contentType: string | undefined = 'text/html; charset=utf-8', strict = true) {
  const arrayBuffer = vi.fn(async (): Promise<ArrayBuffer> => {
    throw new Error('The production path must stream R2 bodies');
  });
  const get = vi.spyOn(env.STATIC_ASSETS_R2, 'get').mockImplementation(async (key, options) => {
    const object = await memoryR2Get(key);
    if (!object) {
      return null;
    }
    const condition = options?.onlyIf as { etagMatches?: string } | undefined;
    if (condition?.etagMatches && condition.etagMatches !== object.etag) {
      return null;
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    let offset = 0;
    let nextSize = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.byteLength) {
          controller.close();
          return;
        }
        const chunks = strict ? [1, 2, 5] : [64 * 1024];
        const end = Math.min(offset + chunks[nextSize++ % chunks.length], bytes.byteLength);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
    });
    return {
      ...object,
      body,
      arrayBuffer: strict ? arrayBuffer : async () => bytes.slice().buffer,
      httpEtag: `"${object.etag}"`,
      httpMetadata: strict ? { contentType } : (r2Metadata.get(key) ?? {}),
      writeHttpMetadata(headers: Headers) {
        const type = strict ? contentType : r2Metadata.get(key)?.contentType;
        if (type) {
          headers.set('Content-Type', type);
        }
      },
    };
  });
  return { get, arrayBuffer };
}
async function serveAsset(project: { slug: string }, entry: Asset) {
  // The dispatch Worker has its own compiler globals. Exercise its actual
  // runtime without merging them into the API's typechecking context.
  const { default: dispatch } = (await import(
    new URL('../../../dispatch/src/index.ts', import.meta.url).href
  )) as {
    default: {
      fetch(request: Request, env: DispatchEnv, ctx: ExecutionContext): Promise<Response>;
    };
  };
  vi.stubGlobal('caches', {
    default: {
      match: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => false),
    },
  });
  const pending: Array<Promise<unknown>> = [];
  const response = await dispatch.fetch(
    new Request(`https://${project.slug}.void.app${entry.path}`),
    {
      ...env,
      BASE_HOSTNAME: 'void.app',
      ANALYTICS: { writeDataPoint: vi.fn() },
      LOGS: { writeDataPoint: vi.fn() },
      USAGE_QUEUE: { send: vi.fn(async () => undefined) },
    } as unknown as DispatchEnv,
    {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(entry.bytes));
  await Promise.allSettled(pending);
}
async function fixture(
  entries: Array<Asset>,
  options: {
    serving?: boolean;
    manifestVersion?: 2;
    status?: 'live' | 'failed';
    active?: boolean;
  } = {},
) {
  const project = await createTestProject(env.db, owner.id);
  const deployment = await createTestDeployment(env.db, project.id, options.status ?? 'live');
  await env.db
    .update(projects)
    .set({ type: 'static', active_deployment_id: options.active === false ? null : deployment.id })
    .where(eq(projects.id, project.id));
  await env.db
    .update(deployments)
    .set({
      retained: true,
      deployed_at: sql`now()`,
      manifest: JSON.stringify({
        version: 4,
        type: 'static',
        bindings: {},
        ...(options.manifestVersion ? { assetManifestVersion: options.manifestVersion } : {}),
      }),
      asset_hashes: JSON.stringify(metadata(entries)),
    })
    .where(eq(deployments.id, deployment.id));
  await env.ROUTING.put(
    project.slug,
    JSON.stringify({
      projectId: project.id,
      userId: owner.id,
      type: 'static',
      staticDeploymentId: deployment.id,
      deploymentId: deployment.id,
    }),
  );
  if (options.serving !== false) {
    await env.ROUTING.put(
      `manifest:${deployment.id}`,
      JSON.stringify(
        Object.fromEntries(
          entries.flatMap(({ path, hash, store, size }) =>
            !path.startsWith('/.void-deploy/')
              ? [[path, store === 'r2' || (!store && size >= KV_THRESHOLD) ? `!${hash}` : hash]]
              : [],
          ),
        ),
      ),
    );
  }
  return { project, deployment };
}
function request(id: string, body: Record<string, unknown>) {
  return app.fetch(
    new Request(`http://localhost/operator/v1/deployments/${id}/migrate-assets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
}
function inventory(query = '') {
  return app.fetch(
    new Request(`http://localhost/operator/v1/system/asset-migrations${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
  );
}
async function preview(id: string, cursor?: string): Promise<Result> {
  const response = await request(id, { dryRun: true, ...(cursor ? { cursor } : {}) });
  expect(response.status, await response.clone().text()).toBe(200);
  const result = await response.json<Result>();
  expect(result).toMatchObject({ dryRun: true, action: 'deployment.migrate-assets', target: id });
  expect(result.expected).toBeDefined();
  return result;
}
async function apply(id: string, cursor?: string) {
  const plan = await preview(id, cursor);
  return request(id, { dryRun: false, expected: plan.expected, ...(cursor ? { cursor } : {}) });
}
async function assertMigrated(id: string, projectId: string, entries: Array<Asset>) {
  const row = await getDeployment(env.db, id);
  const persisted = JSON.parse(row!.asset_hashes!);
  const serving = (await env.ROUTING.get(`manifest:${id}`, 'json')) as Record<string, string>;
  for (const entry of entries) {
    expect(persisted[entry.path]).toMatchObject({
      hash: entry.hash,
      size: entry.size,
      store: 'r2',
    });
    expect(serving[entry.path]).toBe(`!${entry.hash}`);
    const object = await env.STATIC_ASSETS_R2.get(`assets/${projectId}/${entry.hash}`);
    // Compare every byte without Vitest walking millions of typed-array keys
    // in the historical 2 MiB boundary case on a shared CI runner.
    expect(
      (Buffer as BufferConstructor).compare(
        (Buffer as BufferConstructor).from(await object!.arrayBuffer()),
        (Buffer as BufferConstructor).from(entry.bytes),
      ),
    ).toBe(0);
  }
}

describe('operator deployment asset migration', () => {
  test.each(['scoped', 'unscoped'] as const)(
    'copies %s KV assets without changing routing, active identity, or source',
    async (source) => {
      const entry = asset('/index.html', 'Existing KV app', 'kv');
      const { project, deployment } = await fixture([entry]);
      const key =
        source === 'scoped' ? `assets/${project.id}/${entry.hash}` : `assets/${entry.hash}`;
      await env.STATIC_ASSETS.put(key, entry.bytes);
      const routing = await env.ROUTING.get(project.slug);
      const plan = await preview(deployment.id);
      expect((await getDeployment(env.db, deployment.id))!.asset_hashes).toBe(
        JSON.stringify(metadata([entry])),
      );
      expect(await env.STATIC_ASSETS_R2.get(`assets/${project.id}/${entry.hash}`)).toBeNull();
      const response = await request(deployment.id, { dryRun: false, expected: plan.expected });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ complete: true, nextCursor: null });
      await assertMigrated(deployment.id, project.id, [entry]);
      expect(await env.STATIC_ASSETS.get(key, 'arrayBuffer')).toEqual(entry.bytes);
      expect(await env.ROUTING.get(project.slug)).toBe(routing);
      expect((await getProject(env.db, project.id))!.active_deployment_id).toBe(deployment.id);
    },
  );

  test('copies unscoped R2 and preserves its original object', async () => {
    const entry = asset('/app.js', 'export default 1', 'r2');
    const { project, deployment } = await fixture([entry]);
    await env.STATIC_ASSETS_R2.put(`assets/${entry.hash}`, entry.bytes);
    const response = await apply(deployment.id);
    expect(response.status, await response.clone().text()).toBe(200);
    await assertMigrated(deployment.id, project.id, [entry]);
    expect(await env.STATIC_ASSETS_R2.get(`assets/${entry.hash}`)).not.toBeNull();
  });

  test('streams R2 verification, pins the transferred source ETag, and verifies the destination stream', async () => {
    const entry = asset(
      '/index.html',
      'Streaming preserves immutable R2 bytes across irregular chunk boundaries',
      'r2',
    );
    const { project, deployment } = await fixture([entry]);
    const sourceKey = `assets/${entry.hash}`;
    await env.STATIC_ASSETS_R2.put(sourceKey, entry.bytes);
    const original = await env.STATIC_ASSETS_R2.head(sourceKey);
    const streams = streamingR2();
    const put = vi.spyOn(env.STATIC_ASSETS_R2, 'put');
    const response = await apply(deployment.id);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(streams.get).toHaveBeenCalledWith(sourceKey, {
      onlyIf: { etagMatches: original!.etag },
    });
    expect(put).toHaveBeenCalledWith(
      `assets/${project.id}/${entry.hash}`,
      expect.any(ReadableStream),
      {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'text/html; charset=utf-8' },
      },
    );
    expect(streams.arrayBuffer).not.toHaveBeenCalled();
    expect(await env.STATIC_ASSETS_R2.head(sourceKey)).not.toBeNull();
    vi.spyOn(env.STATIC_ASSETS, 'get').mockRejectedValue(new Error('Legacy KV reads are disabled'));
    vi.spyOn(env.STATIC_ASSETS, 'getWithMetadata').mockRejectedValue(
      new Error('Legacy KV reads are disabled'),
    );
    await serveAsset(project, entry);
  });

  test('serves migrated KV bytes through the actual dispatch Worker without reading KV assets', async () => {
    const entry = asset(
      '/index.html',
      'The existing app still serves after migrating KV to R2',
      'kv',
    );
    const { project, deployment } = await fixture([entry]);
    await env.STATIC_ASSETS.put(`assets/${entry.hash}`, entry.bytes, {
      metadata: { ct: 'text/html; charset=utf-8' },
    });
    const response = await apply(deployment.id);
    expect(response.status, await response.clone().text()).toBe(200);
    const streams = streamingR2();
    vi.spyOn(env.STATIC_ASSETS, 'get').mockRejectedValue(new Error('Legacy KV reads are disabled'));
    vi.spyOn(env.STATIC_ASSETS, 'getWithMetadata').mockRejectedValue(
      new Error('Legacy KV reads are disabled'),
    );
    await serveAsset(project, entry);
    expect(streams.get).toHaveBeenCalledWith(`assets/${project.id}/${entry.hash}`);
    expect(streams.get).not.toHaveBeenCalledWith(`assets/${entry.hash}`);
  });

  test('preserves the existing KV content type and migrates same-extension aliases together', async () => {
    const entry = asset('/app.js', 'export default 6', 'kv');
    const alias = { ...entry, path: '/alias.js' };
    const { project, deployment } = await fixture([entry, alias]);
    await env.STATIC_ASSETS.put(`assets/${entry.hash}`, entry.bytes, {
      metadata: { ct: 'text/javascript; charset=utf-8' },
    });
    const put = vi.spyOn(env.STATIC_ASSETS_R2, 'put');
    const response = await apply(deployment.id);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(`assets/${project.id}/${entry.hash}`, entry.bytes, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'text/javascript; charset=utf-8' },
    });
    await assertMigrated(deployment.id, project.id, [entry, alias]);
  });

  test('uses actual serving placement for small R2 assets recorded before placement metadata', async () => {
    const entry = asset('/app.js', 'export default 2');
    const { project, deployment } = await fixture([entry]);
    await env.ROUTING.put(
      `manifest:${deployment.id}`,
      JSON.stringify({ [entry.path]: `!${entry.hash}` }),
    );
    await env.STATIC_ASSETS_R2.put(`assets/${entry.hash}`, entry.bytes);
    const kvGet = vi.spyOn(env.STATIC_ASSETS, 'get');
    const response = await apply(deployment.id);
    expect(response.status, await response.clone().text()).toBe(200);
    await assertMigrated(deployment.id, project.id, [entry]);
    expect(kvGet).not.toHaveBeenCalled();
  });

  test('reconstructs historical placement with the original 2 MiB boundary', async () => {
    const small = asset('/index.html', 'Small historical asset');
    const large = asset('/archive.bin', new Uint8Array(KV_THRESHOLD).fill(97));
    const { project, deployment } = await fixture([small, large], { serving: false });
    await env.STATIC_ASSETS.put(`assets/${small.hash}`, small.bytes);
    await env.STATIC_ASSETS_R2.put(`assets/${large.hash}`, large.bytes);
    const response = await apply(deployment.id);
    expect(response.status, await response.clone().text()).toBe(200);
    await assertMigrated(deployment.id, project.id, [small, large]);
  });

  test('rejects a v2 row with neither persisted nor serving placement', async () => {
    const entry = asset();
    const { project, deployment } = await fixture([entry], { manifestVersion: 2, serving: false });
    await env.STATIC_ASSETS.put(`assets/${entry.hash}`, entry.bytes);
    const response = await request(deployment.id, { dryRun: true });
    expect(response.status).toBe(409);
    expect(await env.STATIC_ASSETS_R2.get(`assets/${project.id}/${entry.hash}`)).toBeNull();
    expect((await getDeployment(env.db, deployment.id))!.asset_hashes).toBe(
      JSON.stringify(metadata([entry])),
    );
  });

  test('converges a stale persisted store using verified bytes from the serving store', async () => {
    const entry = asset('/app.js', 'export default 3', 'r2');
    const { project, deployment } = await fixture([entry]);
    await env.ROUTING.put(
      `manifest:${deployment.id}`,
      JSON.stringify({ [entry.path]: entry.hash }),
    );
    await env.STATIC_ASSETS.put(`assets/${entry.hash}`, entry.bytes);
    const response = await apply(deployment.id);
    expect(response.status, await response.clone().text()).toBe(200);
    await assertMigrated(deployment.id, project.id, [entry]);
    expect(await env.STATIC_ASSETS.get(`assets/${entry.hash}`, 'arrayBuffer')).toEqual(entry.bytes);
  });

  test.each(['scoped', 'unscoped', 'destination'] as const)(
    'rejects corrupt %s bytes without publishing placement',
    async (source) => {
      const entry = asset('/index.html', 'Correct immutable asset', 'kv');
      const { project, deployment } = await fixture([entry]);
      await env.STATIC_ASSETS.put(`assets/${entry.hash}`, entry.bytes);
      if (source === 'destination') {
        await env.STATIC_ASSETS_R2.put(
          `assets/${project.id}/${entry.hash}`,
          'Wrong immutable content',
        );
      } else {
        await env.STATIC_ASSETS.put(
          source === 'scoped' ? `assets/${project.id}/${entry.hash}` : `assets/${entry.hash}`,
          'Wrong immutable content',
        );
      }
      const before = await getDeployment(env.db, deployment.id);
      const serving = await env.ROUTING.get(`manifest:${deployment.id}`);
      const response = await apply(deployment.id);
      expect(response.status).toBe(409);
      expect((await getDeployment(env.db, deployment.id))!.asset_hashes).toBe(before!.asset_hashes);
      expect(await env.ROUTING.get(`manifest:${deployment.id}`)).toBe(serving);
      expect(await env.STATIC_ASSETS.get(`assets/${entry.hash}`)).not.toBeNull();
    },
  );

  test('checks hash and size for every path sharing a hash', async () => {
    const entry = asset('/app.js', 'export default 4', 'kv');
    const same = { ...entry, path: '/other.js', size: entry.size + 1 };
    const { deployment } = await fixture([entry, same]);
    await env.STATIC_ASSETS.put(`assets/${entry.hash}`, entry.bytes);
    const response = await request(deployment.id, { dryRun: true });
    expect(response.status).toBe(409);
  });

  test('requires matching content hashes for different extensions sharing a persisted hash', async () => {
    const entry = asset('/app.js', 'export default 5', 'kv');
    const differentExtension = { ...entry, path: '/app.css' };
    const { deployment } = await fixture([entry, differentExtension]);
    await env.STATIC_ASSETS.put(`assets/${entry.hash}`, entry.bytes);
    const response = await apply(deployment.id);
    expect(response.status).toBe(409);
  });

  test('bounds work to eight unique hashes, resumes, and retries a completed chunk safely', async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      asset(`/page-${i}.html`, `Page ${i}`, 'kv'),
    );
    const { project, deployment } = await fixture(entries);
    for (const entry of entries) {
      await env.STATIC_ASSETS.put(`assets/${entry.hash}`, entry.bytes);
    }
    const first = await apply(deployment.id);
    expect(first.status, await first.clone().text()).toBeGreaterThanOrEqual(200);
    expect(first.status).toBeLessThan(300);
    const firstResult = await first.json<Result>();
    expect(firstResult).toMatchObject({
      complete: false,
      nextCursor: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    const firstObjects = await env.STATIC_ASSETS_R2.list({ prefix: `assets/${project.id}/` });
    expect(firstObjects.objects).toHaveLength(8);
    const retried = await apply(deployment.id);
    expect(await retried.json()).toMatchObject({
      complete: false,
      nextCursor: firstResult.nextCursor,
    });
    expect(
      (await env.STATIC_ASSETS_R2.list({ prefix: `assets/${project.id}/` })).objects,
    ).toHaveLength(8);
    const second = await apply(deployment.id, firstResult.nextCursor!);
    expect(second.status, await second.clone().text()).toBe(200);
    expect(await second.json()).toMatchObject({ complete: true, nextCursor: null });
    await assertMigrated(deployment.id, project.id, entries);
    for (const entry of entries) {
      expect(await env.STATIC_ASSETS.get(`assets/${entry.hash}`)).not.toBeNull();
    }
  });

  test('preserves a verified first page when KV returns its older serving manifest', async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      asset(`/cached-${i}.html`, `Cached page ${i}`, 'kv'),
    );
    const { project, deployment } = await fixture(entries);
    const previousServing = await env.ROUTING.get(`manifest:${deployment.id}`);
    for (const entry of entries) {
      await env.STATIC_ASSETS.put(`assets/${entry.hash}`, entry.bytes);
    }
    const first = await apply(deployment.id);
    expect(first.status, await first.clone().text()).toBe(200);
    const result = await first.json<Result>();
    expect(result.complete).toBe(false);
    // Model a second operator request seeing a stale KV replica after the
    // first page committed its verified scoped placement in PostgreSQL.
    await env.ROUTING.put(`manifest:${deployment.id}`, previousServing!);
    const second = await apply(deployment.id, result.nextCursor!);
    expect(second.status, await second.clone().text()).toBe(200);
    expect(await second.json()).toMatchObject({ complete: true });
    await assertMigrated(deployment.id, project.id, entries);
  });

  test.each(['missing', 'partial'] as const)(
    'keeps every route available after the first page when the serving manifest is %s',
    async (state) => {
      const entries = Array.from({ length: 10 }, (_, i) =>
        asset(`/retained-${i}.html`, `Retained page ${i}`, 'kv'),
      ).sort((a, b) => a.hash.localeCompare(b.hash));
      const { project, deployment } = await fixture(entries, { serving: false });
      if (state === 'partial') {
        await env.ROUTING.put(
          `manifest:${deployment.id}`,
          JSON.stringify({ [entries[0].path]: entries[0].hash }),
        );
      }
      for (const entry of entries) {
        await env.STATIC_ASSETS.put(`assets/${entry.hash}`, entry.bytes);
      }
      const response = await apply(deployment.id);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ complete: false });
      const serving = (await env.ROUTING.get(`manifest:${deployment.id}`, 'json')) as Record<
        string,
        string
      >;
      expect(Object.keys(serving)).toHaveLength(10);
      for (const [index, entry] of entries.entries()) {
        expect(serving[entry.path]).toBe(index < 8 ? `!${entry.hash}` : entry.hash);
        expect(await env.STATIC_ASSETS.get(`assets/${entry.hash}`, 'arrayBuffer')).toEqual(
          entry.bytes,
        );
        if (index >= 8) {
          expect(await env.STATIC_ASSETS_R2.get(`assets/${project.id}/${entry.hash}`)).toBeNull();
        }
      }
    },
  );

  test('rejects cursors not present in this deployment rather than silently skipping data', async () => {
    const entry = asset('/index.html', 'Present asset', 'kv');
    const { deployment } = await fixture([entry]);
    for (const cursor of ['garbage', 'f'.repeat(32)]) {
      expect((await request(deployment.id, { dryRun: true, cursor })).status).toBe(400);
    }
  });

  test('rejects a real cursor that skips an unverified first page', async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      asset(`/old-${i}.html`, `Old page ${i}`, 'kv'),
    );
    const { project, deployment } = await fixture(entries);
    for (const entry of entries) {
      await env.STATIC_ASSETS.put(`assets/${entry.hash}`, entry.bytes);
    }
    const plan = await preview(deployment.id);
    expect(plan.nextCursor).toMatch(/^[0-9a-f]{32}$/);
    const put = vi.spyOn(env.STATIC_ASSETS_R2, 'put');
    for (const dryRun of [true, false]) {
      const response = await request(deployment.id, {
        dryRun,
        cursor: plan.nextCursor,
        expected: plan.expected,
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'invalid_cursor' });
    }
    expect(put).not.toHaveBeenCalled();
    expect(
      (await env.STATIC_ASSETS_R2.list({ prefix: `assets/${project.id}/` })).objects,
    ).toHaveLength(0);
    expect((await getDeployment(env.db, deployment.id))!.asset_hashes).toBe(
      JSON.stringify(metadata(entries)),
    );
  });

  test('skips deployment cache-busters and permits an idempotent all-R2 rerun', async () => {
    const entry = asset('/index.html', 'Already current', 'r2');
    const buster = asset('/.void-deploy/marker.txt', 'Worker upload cache-buster');
    const { project, deployment } = await fixture([entry, buster], { manifestVersion: 2 });
    await env.STATIC_ASSETS_R2.put(`assets/${project.id}/${entry.hash}`, entry.bytes);
    const put = vi.spyOn(env.STATIC_ASSETS_R2, 'put');
    put.mockClear();
    const response = await apply(deployment.id);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ complete: true });
    expect(put).not.toHaveBeenCalled();
    expect(
      JSON.parse((await getDeployment(env.db, deployment.id))!.asset_hashes!)[buster.path],
    ).toEqual({ hash: buster.hash, size: buster.size });
    const again = await apply(deployment.id);
    expect(again.status, await again.clone().text()).toBe(200);
    await assertMigrated(deployment.id, project.id, [entry]);
  });

  test.each(['cutover', 'compensating', 'rollback', 'deleting'] as const)(
    'keeps %s projects fenced',
    async (busy) => {
      const entry = asset('/index.html', 'Protected app', 'kv');
      const { project, deployment } = await fixture([entry]);
      await env.STATIC_ASSETS.put(`assets/${entry.hash}`, entry.bytes);
      if (busy === 'deleting') {
        await env.db
          .update(projects)
          .set({ status: 'deleting' })
          .where(eq(projects.id, project.id));
      } else {
        const candidate = await createTestDeployment(
          env.db,
          project.id,
          'pending',
          busy === 'rollback' ? 'rollback-lease' : undefined,
        );
        if (busy !== 'rollback') {
          await env.db
            .update(deployments)
            .set({ status: busy })
            .where(eq(deployments.id, candidate.id));
        }
      }
      const put = vi.spyOn(env.STATIC_ASSETS_R2, 'put');
      const response = await request(deployment.id, { dryRun: true });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'project_busy' });
      expect(put).not.toHaveBeenCalled();
    },
  );

  test('refuses a stale reviewed plan before copying any assets', async () => {
    const entry = asset('/index.html', 'Reviewed app', 'kv');
    const { project, deployment } = await fixture([entry]);
    await env.STATIC_ASSETS.put(`assets/${entry.hash}`, entry.bytes);
    const plan = await preview(deployment.id);
    await env.db
      .update(deployments)
      .set({ asset_hashes: JSON.stringify(metadata([{ ...entry, size: entry.size + 1 }])) })
      .where(eq(deployments.id, deployment.id));
    const put = vi.spyOn(env.STATIC_ASSETS_R2, 'put');
    const response = await request(deployment.id, { dryRun: false, expected: plan.expected });
    expect(response.status).toBe(409);
    expect(put).not.toHaveBeenCalled();
    expect(await env.STATIC_ASSETS_R2.get(`assets/${project.id}/${entry.hash}`)).toBeNull();
  });

  test('revalidates the active pointer after copying and preserves old metadata on a lineage change', async () => {
    const entry = asset('/index.html', 'Serving before concurrent rollback', 'kv');
    const { project, deployment } = await fixture([entry]);
    await env.STATIC_ASSETS.put(`assets/${entry.hash}`, entry.bytes);
    const replacement = await createTestDeployment(env.db, project.id, 'failed');
    const put = memoryR2Put;
    vi.spyOn(env.STATIC_ASSETS_R2, 'put').mockImplementation(async (...args) => {
      const result = await put(...args);
      await env.db
        .update(projects)
        .set({ active_deployment_id: replacement.id })
        .where(eq(projects.id, project.id));
      return result;
    });
    const oldMetadata = (await getDeployment(env.db, deployment.id))!.asset_hashes;
    const oldServing = await env.ROUTING.get(`manifest:${deployment.id}`);
    const response = await apply(deployment.id);
    expect(response.status).toBe(409);
    expect((await getDeployment(env.db, deployment.id))!.asset_hashes).toBe(oldMetadata);
    expect(await env.ROUTING.get(`manifest:${deployment.id}`)).toBe(oldServing);
    expect(await env.STATIC_ASSETS.get(`assets/${entry.hash}`)).not.toBeNull();
  });

  test('preserves legacy reads and metadata if the serving manifest write fails', async () => {
    const entry = asset('/index.html', 'App must keep serving on KV failure', 'kv');
    const { project, deployment } = await fixture([entry]);
    await env.STATIC_ASSETS.put(`assets/${entry.hash}`, entry.bytes);
    const plan = await preview(deployment.id);
    const put = env.ROUTING.put.bind(env.ROUTING);
    vi.spyOn(env.ROUTING, 'put').mockImplementation(async (...args) => {
      if (args[0] === `manifest:${deployment.id}`) {
        throw new Error('Routing KV unavailable');
      }
      return put(...args);
    });
    const response = await request(deployment.id, { dryRun: false, expected: plan.expected });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(
      JSON.parse((await getDeployment(env.db, deployment.id))!.asset_hashes!)[entry.path].store,
    ).toBe('kv');
    expect(await env.ROUTING.get(`manifest:${deployment.id}`, 'json')).toEqual({
      [entry.path]: entry.hash,
    });
    expect(await env.STATIC_ASSETS.get(`assets/${entry.hash}`, 'arrayBuffer')).toEqual(entry.bytes);
    expect((await getProject(env.db, project.id))!.active_deployment_id).toBe(deployment.id);
  });

  test('converges a KV publication whose following database transaction rolls back', async () => {
    const entry = asset('/index.html', 'Verified app survives failed database commit', 'kv');
    const { project, deployment } = await fixture([entry]);
    await env.STATIC_ASSETS.put(`assets/${entry.hash}`, entry.bytes);
    const plan = await preview(deployment.id);
    const transaction = env.db.transaction.bind(env.db);
    const failedCommit = vi.spyOn(env.db, 'transaction').mockImplementation(async (callback) =>
      transaction(async (tx) => {
        await callback(tx);
        throw new Error('Database transaction cannot commit');
      }),
    );
    const response = await request(deployment.id, { dryRun: false, expected: plan.expected });
    expect(response.status).toBe(500);
    failedCommit.mockRestore();
    expect(
      JSON.parse((await getDeployment(env.db, deployment.id))!.asset_hashes!)[entry.path].store,
    ).toBe('kv');
    expect(await env.ROUTING.get(`manifest:${deployment.id}`, 'json')).toEqual({
      [entry.path]: `!${entry.hash}`,
    });
    expect(await env.STATIC_ASSETS.get(`assets/${entry.hash}`, 'arrayBuffer')).toEqual(entry.bytes);
    const retry = await apply(deployment.id);
    expect(retry.status, await retry.clone().text()).toBe(200);
    await assertMigrated(deployment.id, project.id, [entry]);
  });

  test('does not publish a partly copied page when a later asset is missing', async () => {
    const entries = [
      asset('/first.html', 'Existing first asset', 'kv'),
      asset('/second.html', 'Missing second asset', 'kv'),
    ].sort((a, b) => a.hash.localeCompare(b.hash));
    const { project, deployment } = await fixture(entries);
    await env.STATIC_ASSETS.put(`assets/${entries[0].hash}`, entries[0].bytes);
    const oldServing = await env.ROUTING.get(`manifest:${deployment.id}`);
    const oldMetadata = (await getDeployment(env.db, deployment.id))!.asset_hashes;
    const response = await apply(deployment.id);
    expect(response.status).toBe(409);
    expect(
      (await env.STATIC_ASSETS_R2.list({ prefix: `assets/${project.id}/` })).objects,
    ).toHaveLength(1);
    expect((await getDeployment(env.db, deployment.id))!.asset_hashes).toBe(oldMetadata);
    expect(await env.ROUTING.get(`manifest:${deployment.id}`)).toBe(oldServing);
    expect(await env.STATIC_ASSETS.get(`assets/${entries[0].hash}`, 'arrayBuffer')).toEqual(
      entries[0].bytes,
    );
    await env.STATIC_ASSETS.put(`assets/${entries[1].hash}`, entries[1].bytes);
    const retry = await apply(deployment.id);
    expect(retry.status, await retry.clone().text()).toBe(200);
    await assertMigrated(deployment.id, project.id, entries);
  });

  test('migrates a retained failed rollback target while preserving its history and the current app', async () => {
    const entry = asset('/index.html', 'Old retained rollback app', 'kv');
    const { project, deployment } = await fixture([entry], { status: 'failed' });
    await env.STATIC_ASSETS.put(`assets/${entry.hash}`, entry.bytes);
    const current = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        retained: true,
        manifest: JSON.stringify({ version: 4, type: 'static', bindings: {} }),
      })
      .where(eq(deployments.id, current.id));
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({
        projectId: project.id,
        type: 'static',
        staticDeploymentId: current.id,
        deploymentId: current.id,
      }),
    );
    const response = await apply(deployment.id);
    expect(response.status, await response.clone().text()).toBe(200);
    await assertMigrated(deployment.id, project.id, [entry]);
    expect((await getDeployment(env.db, deployment.id))!.status).toBe('failed');
    expect((await getDeployment(env.db, deployment.id))!.retained).toBe(true);
    expect((await getProject(env.db, project.id))!.active_deployment_id).toBe(current.id);
    const rollback = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: deployment.id }),
      }),
      env,
    );
    expect(rollback.status, await rollback.clone().text()).toBe(200);
    expect((await getProject(env.db, project.id))!.active_deployment_id).toBe(deployment.id);
    expect(await env.ROUTING.get(project.slug, 'json')).toMatchObject({
      staticDeploymentId: deployment.id,
    });
    await assertMigrated(deployment.id, project.id, [entry]);
    streamingR2();
    vi.spyOn(env.STATIC_ASSETS, 'get').mockRejectedValue(new Error('Legacy KV reads are disabled'));
    vi.spyOn(env.STATIC_ASSETS, 'getWithMetadata').mockRejectedValue(
      new Error('Legacy KV reads are disabled'),
    );
    await serveAsset(project, entry);
  });

  test('migrates an authoritative active pointer even when the historical row is failed', async () => {
    const entry = asset('/index.html', 'Historical rollback target now active', 'kv');
    const { project, deployment } = await fixture([entry], { status: 'failed' });
    await env.STATIC_ASSETS.put(`assets/${entry.hash}`, entry.bytes);
    const response = await apply(deployment.id);
    expect(response.status, await response.clone().text()).toBe(200);
    await assertMigrated(deployment.id, project.id, [entry]);
    expect((await getProject(env.db, project.id))!.active_deployment_id).toBe(deployment.id);
    expect((await getDeployment(env.db, deployment.id))!.status).toBe('failed');
  });
});

describe('operator asset migration inventory', () => {
  test('paginates the union of active pointers, retained targets, and stored bundles without status guesses', async () => {
    const { project, deployment } = await fixture([], { status: 'failed' });
    await env.db
      .update(deployments)
      .set({ retained: false })
      .where(eq(deployments.id, deployment.id));
    const retained = await createTestDeployment(env.db, project.id, 'failed');
    await env.db.update(deployments).set({ retained: true }).where(eq(deployments.id, retained.id));
    const bundled = await createTestDeployment(env.db, project.id, 'failed');
    await env.db
      .update(deployments)
      .set({ bundle_stored: true })
      .where(eq(deployments.id, bundled.id));
    const unprotected = await createTestDeployment(env.db, project.id, 'failed');
    const firstResponse = await inventory('?limit=2&page=1');
    expect(firstResponse.status, await firstResponse.clone().text()).toBe(200);
    const first = await firstResponse.json<{
      deployments: Array<{ id: string; active: boolean; retained: boolean; bundleStored: boolean }>;
      pagination: unknown;
    }>();
    const secondResponse = await inventory('?limit=2&page=2');
    expect(secondResponse.status, await secondResponse.clone().text()).toBe(200);
    const second = await secondResponse.json<typeof first>();
    expect(first.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(second.pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
    expect(first.deployments).toHaveLength(2);
    expect(second.deployments).toHaveLength(1);
    const rows = [...first.deployments, ...second.deployments];
    expect(new Set(rows.map(({ id }) => id))).toEqual(
      new Set([deployment.id, retained.id, bundled.id]),
    );
    expect(rows.some(({ id }) => id === unprotected.id)).toBe(false);
    expect(rows.find(({ id }) => id === deployment.id)).toMatchObject({
      active: true,
      retained: false,
      bundleStored: false,
    });
    expect(rows.find(({ id }) => id === retained.id)).toMatchObject({
      active: false,
      retained: true,
      bundleStored: false,
    });
    expect(rows.find(({ id }) => id === bundled.id)).toMatchObject({
      active: false,
      retained: false,
      bundleStored: true,
    });
  });

  test('reports unverified R2 placement, ignores cache-busters, and clears the migration count only after verification', async () => {
    const entry = asset('/index.html', 'Old R2 app', 'r2');
    const buster = asset('/.void-deploy/marker.txt', 'CF cache-buster');
    const { project, deployment } = await fixture([entry, buster]);
    await env.STATIC_ASSETS_R2.put(`assets/${entry.hash}`, entry.bytes);
    const get = vi.spyOn(env.STATIC_ASSETS_R2, 'get');
    const put = vi.spyOn(env.STATIC_ASSETS_R2, 'put');
    put.mockClear();
    const original = (await getDeployment(env.db, deployment.id))!.asset_hashes;
    const firstResponse = await inventory();
    expect(firstResponse.status, await firstResponse.clone().text()).toBe(200);
    expect(await firstResponse.json()).toMatchObject({
      deployments: [
        {
          id: deployment.id,
          projectId: project.id,
          slug: project.slug,
          assets: 1,
          needsMigration: 1,
          invalid: false,
        },
      ],
    });
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect((await getDeployment(env.db, deployment.id))!.asset_hashes).toBe(original);
    const migrated = await apply(deployment.id);
    expect(migrated.status, await migrated.clone().text()).toBe(200);
    const afterResponse = await inventory();
    expect(await afterResponse.json()).toMatchObject({
      deployments: [{ id: deployment.id, assets: 1, needsMigration: 0, invalid: false }],
    });
  });

  test.each(['persisted-json', 'serving-json', 'serving-hash', 'unrecorded-path'] as const)(
    'surfaces %s metadata errors without hiding the protected deployment',
    async (corruption) => {
      const entry = asset('/index.html', 'Inventory must expose invalid metadata', 'kv');
      const { deployment } = await fixture([entry]);
      if (corruption === 'persisted-json') {
        await env.db
          .update(deployments)
          .set({ asset_hashes: '{' })
          .where(eq(deployments.id, deployment.id));
      } else {
        await env.ROUTING.put(
          `manifest:${deployment.id}`,
          corruption === 'serving-json'
            ? '{'
            : JSON.stringify(
                corruption === 'serving-hash'
                  ? { [entry.path]: 'a'.repeat(32) }
                  : { [entry.path]: entry.hash, '/unrecorded.js': entry.hash },
              ),
        );
      }
      const response = await inventory();
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({
        deployments: [{ id: deployment.id, active: true, invalid: true }],
        pagination: { total: 1 },
      });
    },
  );

  test.each(['relative-path', 'conflicting-size', 'conflicting-store'] as const)(
    'flags %s metadata as invalid',
    async (corruption) => {
      const entry = asset('/index.html', 'Invalid inventory shape', 'kv');
      const alias = {
        ...entry,
        path: corruption === 'relative-path' ? 'relative.html' : '/alias.html',
        ...(corruption === 'conflicting-size' ? { size: entry.size + 1 } : {}),
        ...(corruption === 'conflicting-store' ? { store: 'r2' as const } : {}),
      };
      const { deployment } = await fixture([entry, alias]);
      const response = await inventory();
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({
        deployments: [{ id: deployment.id, invalid: true }],
      });
    },
  );

  test('reports a missing serving route even when durable R2 placement was already marked', async () => {
    const entry = asset('/index.html', 'The serving route still needs restoring', 'r2');
    const { deployment } = await fixture([entry], { serving: false });
    await env.db
      .update(deployments)
      .set({
        asset_hashes: JSON.stringify({
          [entry.path]: { hash: entry.hash, size: entry.size, store: 'r2', scope: 'project' },
        }),
      })
      .where(eq(deployments.id, deployment.id));
    const response = await inventory();
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      deployments: [{ id: deployment.id, assets: 1, needsMigration: 1, invalid: false }],
    });
  });
});
