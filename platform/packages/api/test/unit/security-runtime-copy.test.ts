import { afterEach, expect, it, vi } from 'vite-plus/test';
import { runtimeCopyPrefix, runtimeCopyScriptName } from '../../src/security/runtime-copy-names.ts';
import {
  planSecurityRuntimeCopy,
  securityRuntimeCopyMetadata,
} from '../../src/security/runtime-copy-plan.ts';
import type { SecurityCopyPlan } from '../../src/security/runtime-copy-plan.ts';
import { createSecurityRuntimeCopy, SecurityCopySkipped } from '../../src/security/runtime-copy.ts';
import type { SecurityCopyTarget } from '../../src/security/runtime-copy.ts';
import type { DeployManifest } from '../../src/types.ts';

const PREFIX = runtimeCopyPrefix('abc123def456');
const SCRIPT = runtimeCopyScriptName(PREFIX, 'scan_01', 1);
const TARGET: SecurityCopyTarget = {
  accountId: 'acct',
  apiToken: 'token-not-printed',
  namespace: 'void-security-copies-abc123def456',
  sandbox: 'void-security-copy-sandbox-abc123def456',
  prefix: PREFIX,
};
const LIVE_SECRET = 'live-secret-value-never-copied';

function plan(): SecurityCopyPlan {
  const made = planSecurityRuntimeCopy(
    {
      version: 5,
      workerMain: 'index.js',
      bindings: { d1: ['DB'], kv: ['CACHE'], r2: ['FILES'], hyperdrive: ['PG'] },
      queues: [{ name: 'jobs', bindingName: 'JOBS' }],
      vars: { PUBLIC_URL: 'https://app.example', STRIPE_KEY: LIVE_SECRET, API_SECRET: 'x' },
    } as Partial<DeployManifest> as DeployManifest,
    { engine: 'void_loop', script: SCRIPT, secretNames: ['API_SECRET'] },
  );
  if (made.kind !== 'copy') {
    throw new Error(`expected a copy plan, got ${made.reason}`);
  }
  return made;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('binds new copy stores, the stub sandbox and fake secret values only', () => {
  const made = plan();
  expect(made.fakes).toEqual(['API_SECRET', 'STRIPE_KEY']);
  const metadata = securityRuntimeCopyMetadata(
    made,
    { sandbox: TARGET.sandbox },
    {
      ids: new Map([
        [`${SCRIPT}-d0`, 'd1-copy-uuid'],
        [`${SCRIPT}-k0`, 'kv-copy-id'],
      ]),
      fakes: new Map([
        ['API_SECRET', 'void-copy-fake-a'],
        ['STRIPE_KEY', 'void-copy-fake-b'],
        ['__VOID_PROXY_TOKEN', 'void-copy-fake-c'],
      ]),
      projectId: 'proj_1',
      projectSlug: 'app',
    },
  );
  const bindings = metadata.bindings as Array<Record<string, unknown>>;
  const byName = new Map(bindings.map((binding) => [binding.name, binding]));
  expect(byName.get('DB')).toEqual({ type: 'd1', name: 'DB', id: 'd1-copy-uuid' });
  expect(byName.get('FILES')).toMatchObject({ bucket_name: `${SCRIPT}-r0` });
  expect(byName.get('JOBS')).toMatchObject({ service: TARGET.sandbox, entrypoint: 'QueueStub' });
  expect(byName.get('__VOID_PROXY')).toMatchObject({ entrypoint: 'PlatformStub' });
  expect(byName.get('STRIPE_KEY')).toMatchObject({ text: 'void-copy-fake-b' });
  expect(byName.has('PG')).toBe(false);
  expect(JSON.stringify(metadata)).not.toContain(LIVE_SECRET);
});

function useCloudflare(failUpload = false) {
  const calls: Array<{ method: string; path: string }> = [];
  const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = new URL(String(input)).pathname.replace('/client/v4/accounts/acct', '');
    calls.push({ method, path });
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (method === 'POST' && path === '/d1/database') {
      return ok({ uuid: `uuid-${body.name}` });
    }
    if (method === 'POST' && path === '/storage/kv/namespaces') {
      return ok({ id: `kv-${body.title}` });
    }
    if (path === '/d1/database/live-d1/query') {
      return ok([{ results: [{ type: 'table', name: 'users', sql: 'CREATE TABLE users (id)' }] }]);
    }
    if (path.endsWith('/query')) {
      return ok([{ meta: { rows_written: 1 } }]);
    }
    if (method === 'PUT' && failUpload) {
      return new Response('bad module', { status: 400 });
    }
    return ok({});
  });
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  return {
    calls,
    deleted: () => calls.flatMap((call) => (call.method === 'DELETE' ? [call.path] : [])),
  };
}

const INPUT = {
  modules: [
    {
      name: 'index.js',
      type: 'application/javascript+module',
      bytes: new TextEncoder().encode('export default {}'),
    },
  ],
  liveD1: new Map([['DB', 'live-d1']]),
  projectId: 'proj_1',
  projectSlug: 'app',
  random: (bytes: number) => new Uint8Array(bytes).fill(7),
};

it('makes no copy when the live schema holds a stored secret value, and cleans up', async () => {
  const cf = useCloudflare();
  await expect(
    createSecurityRuntimeCopy(TARGET, {
      ...INPUT,
      plan: plan(),
      holdsSecret: (text) => text.includes('users'),
    }),
  ).rejects.toBeInstanceOf(SecurityCopySkipped);
  expect(cf.calls.some((call) => call.method === 'PUT')).toBe(false);
  expect(cf.deleted()).toContain(`/d1/database/uuid-${SCRIPT}-d0`);
});

it('deletes every store and the script it made when the upload fails', async () => {
  const cf = useCloudflare(true);
  await expect(createSecurityRuntimeCopy(TARGET, { ...INPUT, plan: plan() })).rejects.toThrow(
    'HTTP 400',
  );
  expect(cf.deleted()).toEqual(
    expect.arrayContaining([
      `/workers/dispatch/namespaces/${TARGET.namespace}/scripts/${SCRIPT}`,
      `/d1/database/uuid-${SCRIPT}-d0`,
      `/storage/kv/namespaces/kv-${SCRIPT}-k0`,
      `/r2/buckets/${SCRIPT}-r0`,
    ]),
  );
});
