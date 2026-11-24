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
import { deployments, securityScans } from '../../src/schema.ts';
import {
  noteSecurityRuntimeCopyOutcome,
  prepareSecurityRuntimeCopy,
} from '../../src/security/runtime-copy.ts';
import {
  cfError,
  cfSuccess,
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestProjectSecret,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

// M30: making a scan's runtime copy against the database, R2 and a small fake
// Cloudflare API. The copy runs the raw bundle, so a stored secret in it means no copy,
// and a copy made for an attempt that ended meanwhile is deleted at once.

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SECRET = 'sk_live_Abc123Xyz789';

type Call = { method: string; path: string };

/** Answers the calls a copy makes; `onUpload` runs when the script is uploaded. */
function fakeCloudflare(onUpload: () => Promise<void> = async () => {}) {
  const calls: Array<Call> = [];
  let metadata: { bindings?: Array<Record<string, unknown>> } | null = null;
  const names = new Map<string, string>();
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(`/client/v4/accounts/${env.CF_ACCOUNT_ID}`, '');
    calls.push({ method, path });
    if (method === 'POST' && path === '/d1/database') {
      const name = (JSON.parse(String(init?.body)) as { name: string }).name;
      names.set(`uuid-${name}`, name);
      return cfSuccess({ uuid: `uuid-${name}` });
    }
    if (method === 'PUT' && path.includes('/workers/dispatch/namespaces/')) {
      const form = init?.body as FormData;
      metadata = JSON.parse(await (form.get('metadata') as Blob).text());
      await onUpload();
      return cfSuccess({ id: 'x' });
    }
    if (method === 'GET' && path.endsWith('/settings')) {
      return metadata ? cfSuccess({ bindings: metadata.bindings }) : cfError('none', 404);
    }
    if (method === 'GET' && path.startsWith('/d1/database/')) {
      const name = names.get(path.slice('/d1/database/'.length));
      return name ? cfSuccess({ name }) : cfError('none', 404);
    }
    if (method === 'DELETE') {
      return cfSuccess(null);
    }
    return cfError(`unexpected ${method} ${path}`, 404);
  });
  vi.stubGlobal('fetch', fetch);
  return { calls };
}

/** A running Engine B scan of a Worker app with one D1 binding and a bundle in R2. */
async function setup(bundle: string) {
  const user = await createTestUser(env.db, `owner-${crypto.randomUUID()}`);
  const project = await createTestProject(env.db, user.id);
  const deployment = await createTestDeployment(env.db, project.id, 'live');
  await env.db
    .update(deployments)
    .set({
      manifest: JSON.stringify({
        version: 5,
        type: 'void',
        workerMain: 'index.js',
        bindings: { d1: ['DB'] },
      }),
    })
    .where(eq(deployments.id, deployment.id));
  await createTestProjectSecret(env.db, env, project.id, 'STRIPE_KEY', SECRET);
  const prefix = `security-scans/${project.id}/scan_copy/`;
  const moduleKey = `${prefix}m/0`;
  await env.STATIC_ASSETS_R2.put(moduleKey, bundle);
  await env.STATIC_ASSETS_R2.put(
    `${prefix}modules.json`,
    JSON.stringify({
      version: 1,
      modules: [
        {
          name: 'index.js',
          type: 'application/javascript+module',
          size: new TextEncoder().encode(bundle).length,
          key: moduleKey,
        },
      ],
    }),
  );
  await env.db.insert(securityScans).values({
    id: 'scan_copy',
    project_id: project.id,
    deployment_id: deployment.id,
    status: 'running',
    trigger: 'deploy',
    attempt: 1,
    lease_until: new Date(Date.now() + 60 * 60_000).toISOString(),
    model_requested: '@cf/zai-org/glm-5.3',
    model_used: '@cf/zai-org/glm-5.3',
    engine: 'void_loop',
    input_r2_key: prefix,
    first_queued_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
  });
  return { project };
}

async function meter(): Promise<number> {
  const [row] = await env.db
    .select({ nano: securityScans.metered_nano_usd })
    .from(securityScans)
    .where(eq(securityScans.id, 'scan_copy'));
  return Number(row.nano);
}

describe('prepareSecurityRuntimeCopy', () => {
  it('makes the copy and charges the running attempt', async () => {
    await setup('export default { fetch() { return new Response("ok") } }');
    const cf = fakeCloudflare();
    const outcome = await prepareSecurityRuntimeCopy(env, env.db, 'scan_copy', 1);
    expect(outcome).toMatchObject({ ok: true });
    expect(cf.calls.some((call) => call.method === 'PUT')).toBe(true);
    expect(cf.calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(await meter()).toBeGreaterThan(0);
  });

  it('makes no copy when the bundle holds a stored secret value (spec §7.3)', async () => {
    await setup(`const key = "${SECRET}"; export default { fetch() { return new Response(key) } }`);
    const cf = fakeCloudflare();
    expect(await prepareSecurityRuntimeCopy(env, env.db, 'scan_copy', 1)).toEqual({
      ok: false,
      reason: 'secret_in_bundle',
    });
    expect(cf.calls).toEqual([]);
  });

  it('deletes a copy whose attempt ended while it was made, and charges nothing', async () => {
    await setup('export default {}');
    const cf = fakeCloudflare(async () => {
      // A cancel lands during the upload.
      await env.db
        .update(securityScans)
        .set({ status: 'canceled' })
        .where(eq(securityScans.id, 'scan_copy'));
    });
    expect(await prepareSecurityRuntimeCopy(env, env.db, 'scan_copy', 1)).toEqual({
      ok: false,
      reason: 'fence',
    });
    const deleted = cf.calls.filter((call) => call.method === 'DELETE').map((call) => call.path);
    expect(deleted).toHaveLength(2);
    expect(deleted[0]).toContain('/workers/dispatch/namespaces/');
    expect(deleted[1].startsWith('/d1/database/uuid-void-sec-copy-')).toBe(true);
    expect(await meter()).toBe(0);
  });

  it('notes a copy that was wanted and not made on the running attempt, once (C7)', async () => {
    await setup('export default {}');
    const notes = async () => {
      const [row] = await env.db
        .select({ notes: securityScans.coverage_notes })
        .from(securityScans)
        .where(eq(securityScans.id, 'scan_copy'));
      return row.notes;
    };
    await env.db
      .update(securityScans)
      .set({ coverage_notes: ['no-commit'] })
      .where(eq(securityScans.id, 'scan_copy'));
    const failed = { ok: false, reason: 'create_failed' } as const;
    await noteSecurityRuntimeCopyOutcome(env.db, 'scan_copy', 1, failed);
    await noteSecurityRuntimeCopyOutcome(env.db, 'scan_copy', 1, failed);
    // Not a failure: no copy by design, or the attempt is over.
    await noteSecurityRuntimeCopyOutcome(env.db, 'scan_copy', 1, { ok: false, reason: 'static' });
    await noteSecurityRuntimeCopyOutcome(env.db, 'scan_copy', 1, { ok: false, reason: 'fence' });
    // An older attempt writes nothing.
    await noteSecurityRuntimeCopyOutcome(env.db, 'scan_copy', 2, {
      ok: false,
      reason: 'input_missing',
    });
    expect(await notes()).toEqual(['no-commit', 'runtime-copy-not-made (create_failed)']);
  });
});
