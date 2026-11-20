import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  runtimeCopyPrefix,
  runtimeCopyScriptName,
  runtimeCopyStoreName,
  runtimeCopyStoreOwner,
} from '../../src/security/runtime-copy-names.ts';
import {
  planSecurityRuntimeCopy,
  securityRuntimeCopyMetadata,
  securityRuntimeCopyWanted,
  type SecurityCopyPlan,
} from '../../src/security/runtime-copy-plan.ts';
import {
  COPY_GUARD_MODULE_NAME,
  COPY_ENTRY_MODULE_NAME,
  copyEntryModule,
} from '../../src/security/runtime-copy-sources.ts';
import {
  deleteSecurityRuntimeCopy,
  sweepSecurityRuntimeCopies,
} from '../../src/security/runtime-copy-sweep.ts';
import {
  createSecurityRuntimeCopy,
  SecurityCopySkipped,
  securityCopySchemaStatements,
  type SecurityCopyTarget,
} from '../../src/security/runtime-copy.ts';
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

function manifest(extra: Partial<DeployManifest> = {}): DeployManifest {
  return {
    version: 5,
    workerMain: 'index.js',
    bindings: { d1: ['DB'], kv: ['CACHE'], r2: ['FILES'], hyperdrive: ['PG'] },
    queues: [{ name: 'jobs', bindingName: 'JOBS' }],
    vars: { PUBLIC_URL: 'https://app.example', STRIPE_KEY: LIVE_SECRET, API_SECRET: 'x' },
    websocket: { routes: [{ path: '/ws', className: 'Room' }], classes: ['Room', 'Lobby'] },
    live: { bindingName: 'LIVE', className: 'Live', storage: 'sqlite', classes: ['Live'] },
    schedules: [{ cron: '0 * * * *' }],
    ...extra,
  } as unknown as DeployManifest;
}

function plan(extra: Partial<DeployManifest> = {}, secretNames = ['API_SECRET']): SecurityCopyPlan {
  const made = planSecurityRuntimeCopy(manifest(extra), {
    engine: 'void_loop',
    script: SCRIPT,
    secretNames,
  });
  if (made.kind !== 'copy') {
    throw new Error(`expected a copy plan, got ${made.reason}`);
  }
  return made;
}

describe('names', () => {
  it('ties every store to its copy and one attempt to one copy', () => {
    expect(SCRIPT).toBe('void-sec-copy-abc123def456-scan01-a1');
    const store = runtimeCopyStoreName(SCRIPT, 'd', 0);
    expect(store).toBe(`${SCRIPT}-d0`);
    expect(runtimeCopyStoreOwner(store)).toBe(SCRIPT);
    // A store of attempt 10 never matches the name part of attempt 1.
    expect(
      runtimeCopyStoreName(runtimeCopyScriptName(PREFIX, 'scan_01', 10), 'd', 0),
    ).not.toContain(`${SCRIPT}-`);
  });
});

describe('planSecurityRuntimeCopy', () => {
  it('skips engines without a tool loop, static apps and a missing manifest', () => {
    const options = { script: SCRIPT, secretNames: [] };
    expect(planSecurityRuntimeCopy(manifest(), { ...options, engine: 'agent_sdk' })).toEqual({
      kind: 'skip',
      reason: 'engine',
    });
    expect(planSecurityRuntimeCopy(null, { ...options, engine: 'void_loop' })).toEqual({
      kind: 'skip',
      reason: 'no_manifest',
    });
    expect(
      planSecurityRuntimeCopy(manifest({ type: 'static' }), { ...options, engine: 'void_loop' }),
    ).toEqual({ kind: 'skip', reason: 'static' });
    expect(securityRuntimeCopyWanted(manifest(), 'void_loop')).toBe(true);
    expect(securityRuntimeCopyWanted(manifest(), 'agent_sdk')).toBe(false);
  });

  it('gives new empty stores, new DO classes, stubbed queues and fake secrets', () => {
    const made = plan();
    expect(made.stores).toEqual([
      { kind: 'd1', binding: 'DB', name: `${SCRIPT}-d0` },
      { kind: 'kv', binding: 'CACHE', name: `${SCRIPT}-k0` },
      { kind: 'r2', binding: 'FILES', name: `${SCRIPT}-r0` },
    ]);
    expect(made.durableObjects).toEqual([
      { binding: 'Room', className: 'Room' },
      { binding: 'Lobby', className: 'Lobby' },
      { binding: 'LIVE', className: 'Live' },
    ]);
    expect(made.queues).toEqual(['JOBS']);
    expect(made.vars).toEqual([{ name: 'PUBLIC_URL', value: 'https://app.example' }]);
    expect(made.fakes).toEqual(['API_SECRET', 'STRIPE_KEY']);
    expect(made.dropped).toEqual(['PG (hyperdrive)', 'cron triggers', 'queue consumers', 'assets']);
  });
});

describe('securityRuntimeCopyMetadata', () => {
  it('binds the copy stores, the stub sandbox and fake values only', () => {
    const made = plan();
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
    expect(metadata.main_module).toBe(COPY_ENTRY_MODULE_NAME);
    expect(byName.get('DB')).toEqual({ type: 'd1', name: 'DB', id: 'd1-copy-uuid' });
    expect(byName.get('CACHE')).toEqual({
      type: 'kv_namespace',
      name: 'CACHE',
      namespace_id: 'kv-copy-id',
    });
    expect(byName.get('FILES')).toMatchObject({ bucket_name: `${SCRIPT}-r0` });
    expect(byName.get('JOBS')).toMatchObject({ service: TARGET.sandbox, entrypoint: 'QueueStub' });
    expect(byName.get('__VOID_PROXY')).toMatchObject({ entrypoint: 'PlatformStub' });
    expect(byName.get('__VOID_COPY_EGRESS')).toMatchObject({ service: TARGET.sandbox });
    expect(byName.get('STRIPE_KEY')).toEqual({
      type: 'secret_text',
      name: 'STRIPE_KEY',
      text: 'void-copy-fake-b',
    });
    expect(byName.has('PG')).toBe(false);
    expect(JSON.stringify(metadata)).not.toContain(LIVE_SECRET);
    expect(metadata.migrations).toEqual({
      new_tag: 'v1',
      new_sqlite_classes: ['Live', 'Lobby', 'Room'],
    });
  });
});

describe('copyEntryModule', () => {
  it('loads the guard before the app and keeps its exports', () => {
    const source = copyEntryModule('index.js');
    expect(source.indexOf(COPY_GUARD_MODULE_NAME)).toBeLessThan(source.indexOf('./index.js'));
    expect(source).toContain('export * from "./index.js"');
  });
});

describe('securityCopySchemaStatements', () => {
  it('replays tables, views and indexes and leaves out shadow tables', () => {
    expect(
      securityCopySchemaStatements([
        { type: 'table', name: 'users', sql: 'CREATE TABLE users (id INTEGER)' },
        { type: 'table', name: 'docs', sql: 'CREATE VIRTUAL TABLE docs USING fts5(body)' },
        { type: 'table', name: 'docs_data', sql: 'CREATE TABLE docs_data (id)' },
        { type: 'table', name: 'docs_idx', sql: 'CREATE TABLE docs_idx (segid)' },
        // A normal table whose name starts like the virtual table's is kept.
        { type: 'table', name: 'docs_meta', sql: 'CREATE TABLE docs_meta (id)' },
        { type: 'view', name: 'v', sql: 'CREATE VIEW v AS SELECT 1' },
        { type: 'index', name: 'i', sql: 'CREATE INDEX i ON users (id)' },
        { type: 'index', name: 'auto', sql: null },
      ]),
    ).toEqual([
      'CREATE TABLE users (id INTEGER)',
      'CREATE VIRTUAL TABLE docs USING fts5(body)',
      'CREATE TABLE docs_meta (id)',
      'CREATE VIEW v AS SELECT 1',
      'CREATE INDEX i ON users (id)',
    ]);
  });
});

// ---------------------------------------------------------------------------
// A small Cloudflare API: records every call, answers from state.

type Call = { method: string; path: string; body?: unknown };

function fakeCloudflare(
  options: {
    scripts?: Array<string>;
    d1?: Array<{ uuid: string; name: string }>;
    kv?: Array<{ id: string; title: string }>;
    r2?: Array<string>;
    failUpload?: boolean;
    failR2?: boolean;
    /** Bindings a copy script's settings answer; absent means no such script. */
    settings?: Array<Record<string, unknown>>;
  } = {},
) {
  const calls: Array<Call> = [];
  let form: FormData | null = null;
  const ok = (result: unknown) =>
    new Response(JSON.stringify({ success: true, errors: [], result }), {
      headers: { 'content-type': 'application/json' },
    });
  const fail = (status: number) =>
    new Response(JSON.stringify({ success: false, errors: [{ code: status, message: 'no' }] }), {
      status,
    });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = `${url.pathname.replace('/client/v4/accounts/acct', '')}${url.search}`;
    let body: unknown;
    if (init?.body instanceof FormData) {
      form = init.body;
      body = 'form';
    } else if (typeof init?.body === 'string') {
      body = JSON.parse(init.body);
    }
    calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
    const route = `${method} ${url.pathname.replace('/client/v4/accounts/acct', '')}`;
    if (route === 'POST /d1/database') {
      return ok({ uuid: `uuid-${(body as { name: string }).name}` });
    }
    if (route === 'POST /d1/database/live-d1/query') {
      return ok([
        {
          results: [
            { type: 'table', name: 'users', sql: 'CREATE TABLE users (id INTEGER)' },
            { type: 'index', name: 'u', sql: 'CREATE INDEX u ON users (id)' },
          ],
        },
      ]);
    }
    if (method === 'POST' && route.endsWith('/query')) {
      return ok([{ meta: { rows_written: 2 } }]);
    }
    if (route === 'POST /storage/kv/namespaces') {
      return ok({ id: `kv-${(body as { title: string }).title}` });
    }
    if (route === 'POST /r2/buckets') {
      return options.failR2 ? fail(500) : ok({});
    }
    if (method === 'PUT' && route.includes('/workers/dispatch/namespaces/')) {
      return options.failUpload ? new Response('bad module', { status: 400 }) : ok({ id: 'x' });
    }
    if (method === 'GET' && route.endsWith('/settings')) {
      return options.settings ? ok({ bindings: options.settings }) : fail(404);
    }
    if (method === 'GET' && route.startsWith('GET /d1/database/')) {
      const id = route.slice('GET /d1/database/'.length);
      const found = (options.d1 ?? []).find((row) => row.uuid === id);
      return found ? ok(found) : fail(404);
    }
    if (method === 'GET' && route.startsWith('GET /storage/kv/namespaces/')) {
      const id = route.slice('GET /storage/kv/namespaces/'.length);
      const found = (options.kv ?? []).find((row) => row.id === id);
      return found ? ok(found) : fail(404);
    }
    if (route === `GET /workers/dispatch/namespaces/${TARGET.namespace}/scripts`) {
      return ok((options.scripts ?? []).map((id) => ({ id })));
    }
    if (route === 'GET /d1/database') {
      return ok(options.d1 ?? []);
    }
    if (route === 'GET /storage/kv/namespaces') {
      return ok(options.kv ?? []);
    }
    if (route === 'GET /r2/buckets') {
      return ok({ buckets: (options.r2 ?? []).map((name) => ({ name })) });
    }
    if (method === 'DELETE') {
      return ok(null);
    }
    return fail(404);
  });
  return { calls, fetch, form: () => form };
}

let cf: ReturnType<typeof fakeCloudflare>;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function useCloudflare(options: Parameters<typeof fakeCloudflare>[0] = {}) {
  cf = fakeCloudflare(options);
  vi.stubGlobal('fetch', cf.fetch);
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

describe('createSecurityRuntimeCopy', () => {
  it('makes empty stores, replays the schema and uploads guard, entry and modules', async () => {
    useCloudflare();
    const made = plan();
    const created = await createSecurityRuntimeCopy(TARGET, { ...INPUT, plan: made });
    expect(created.script).toBe(SCRIPT);
    expect(created.schema).toEqual({ DB: 2 });
    expect(created.costNano).toBeGreaterThan(0);
    // The live D1 is only read; the schema goes into the copy D1.
    const queries = cf.calls.filter((call) => call.path.endsWith('/query'));
    expect(queries).toEqual([
      {
        method: 'POST',
        path: '/d1/database/live-d1/query',
        body: { sql: expect.stringContaining('sqlite_master') },
      },
      {
        method: 'POST',
        path: `/d1/database/uuid-${SCRIPT}-d0/query`,
        body: { sql: 'CREATE TABLE users (id INTEGER);\nCREATE INDEX u ON users (id);' },
      },
    ]);
    const upload = cf.calls.find((call) => call.method === 'PUT');
    expect(upload?.path).toBe(`/workers/dispatch/namespaces/${TARGET.namespace}/scripts/${SCRIPT}`);
    const form = cf.form()!;
    expect([...form.keys()]).toEqual([
      'metadata',
      COPY_ENTRY_MODULE_NAME,
      COPY_GUARD_MODULE_NAME,
      'index.js',
    ]);
    const metadata = await (form.get('metadata') as Blob).text();
    expect(metadata).not.toContain(LIVE_SECRET);
    expect(metadata).toContain('void-copy-fake-stripe_key-070707');
  });

  it('deletes what it made when the upload fails', async () => {
    useCloudflare({ failUpload: true });
    await expect(createSecurityRuntimeCopy(TARGET, { ...INPUT, plan: plan() })).rejects.toThrow(
      'HTTP 400',
    );
    const deleted = cf.calls.filter((call) => call.method === 'DELETE').map((call) => call.path);
    expect(deleted).toEqual(
      expect.arrayContaining([
        `/workers/dispatch/namespaces/${TARGET.namespace}/scripts/${SCRIPT}?force=true`,
        `/d1/database/uuid-${SCRIPT}-d0`,
        `/storage/kv/namespaces/kv-${SCRIPT}-k0`,
        `/r2/buckets/${SCRIPT}-r0`,
      ]),
    );
    expect(deleted[0]).toContain('/scripts/');
  });

  it('makes no copy when the live schema holds a stored secret value', async () => {
    useCloudflare();
    await expect(
      createSecurityRuntimeCopy(TARGET, {
        ...INPUT,
        plan: plan(),
        holdsSecret: (text) => text.includes('users'),
      }),
    ).rejects.toBeInstanceOf(SecurityCopySkipped);
    expect(cf.calls.some((call) => call.method === 'PUT')).toBe(false);
    const deleted = cf.calls.filter((call) => call.method === 'DELETE').map((call) => call.path);
    expect(deleted).toEqual(expect.arrayContaining([`/d1/database/uuid-${SCRIPT}-d0`]));
  });

  it('deletes the stores already made when one store fails, before any upload', async () => {
    useCloudflare({ failR2: true });
    await expect(createSecurityRuntimeCopy(TARGET, { ...INPUT, plan: plan() })).rejects.toThrow();
    expect(cf.calls.some((call) => call.method === 'PUT')).toBe(false);
    const deleted = cf.calls.filter((call) => call.method === 'DELETE').map((call) => call.path);
    expect(deleted.sort()).toEqual(
      [`/d1/database/uuid-${SCRIPT}-d0`, `/storage/kv/namespaces/kv-${SCRIPT}-k0`].sort(),
    );
  });
});

describe('sweep and delete', () => {
  const OTHER = runtimeCopyScriptName(PREFIX, 'scan_02', 3);

  it('keeps running copies and deletes the rest, scripts first', async () => {
    useCloudflare({
      scripts: [SCRIPT, OTHER, 'someone-else'],
      d1: [
        { uuid: 'd-keep', name: `${SCRIPT}-d0` },
        { uuid: 'd-old', name: `${OTHER}-d0` },
      ],
      kv: [
        { id: 'k-old', title: `${OTHER}-k0` },
        { id: 'k-foreign', title: 'my-app-cache' },
      ],
      r2: [`${OTHER}-r0`],
    });
    expect(await sweepSecurityRuntimeCopies(TARGET, new Set([SCRIPT]))).toBe(1);
    const deleted = cf.calls.filter((call) => call.method === 'DELETE').map((call) => call.path);
    expect(deleted[0]).toBe(
      `/workers/dispatch/namespaces/${TARGET.namespace}/scripts/${OTHER}?force=true`,
    );
    expect(deleted.slice(1).sort()).toEqual(
      ['/d1/database/d-old', '/r2/buckets/' + `${OTHER}-r0`, '/storage/kv/namespaces/k-old'].sort(),
    );
  });

  it('still deletes leftover stores when the copy namespace is gone', async () => {
    useCloudflare({ d1: [{ uuid: 'd-old', name: `${OTHER}-d0` }] });
    cf.fetch.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: 'gone' }] }), {
          status: 404,
        }),
    );
    expect(await sweepSecurityRuntimeCopies(TARGET, new Set())).toBe(1);
    expect(cf.calls.at(-1)).toEqual({ method: 'DELETE', path: '/d1/database/d-old' });
  });

  it('reads the running scans only after the lists, so a scan that starts meanwhile is kept', async () => {
    useCloudflare({ scripts: [SCRIPT], d1: [{ uuid: 'd-new', name: `${SCRIPT}-d0` }] });
    let listedFirst = false;
    const keep = vi.fn(async () => {
      listedFirst = cf.calls.some((call) => call.path.startsWith('/r2/buckets'));
      return new Set([SCRIPT]);
    });
    expect(await sweepSecurityRuntimeCopies(TARGET, keep)).toBe(0);
    expect(listedFirst).toBe(true);
    expect(cf.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('deletes one copy from its own bindings, without listing the account', async () => {
    useCloudflare({
      d1: [
        { uuid: 'd-mine', name: `${SCRIPT}-d0` },
        { uuid: 'd-live', name: 'my-app-db' },
      ],
      kv: [{ id: 'k-mine', title: `${SCRIPT}-k0` }],
      settings: [
        { type: 'd1', name: 'DB', id: 'd-mine' },
        // An id whose name is not this copy's is never deleted.
        { type: 'd1', name: 'OTHER', id: 'd-live' },
        { type: 'kv_namespace', name: 'CACHE', namespace_id: 'k-mine' },
        { type: 'r2_bucket', name: 'FILES', bucket_name: `${SCRIPT}-r0` },
        { type: 'r2_bucket', name: 'LIVE', bucket_name: 'my-app-files' },
        { type: 'secret_text', name: 'STRIPE_KEY' },
      ],
    });
    await deleteSecurityRuntimeCopy(TARGET, SCRIPT);
    const deleted = cf.calls.filter((call) => call.method === 'DELETE').map((call) => call.path);
    expect(deleted[0]).toBe(
      `/workers/dispatch/namespaces/${TARGET.namespace}/scripts/${SCRIPT}?force=true`,
    );
    expect(deleted.slice(1).sort()).toEqual(
      ['/d1/database/d-mine', '/storage/kv/namespaces/k-mine', `/r2/buckets/${SCRIPT}-r0`].sort(),
    );
    // No account-wide list call.
    expect(cf.calls.some((call) => call.path.startsWith('/storage/kv/namespaces?'))).toBe(false);
    expect(cf.calls.some((call) => call.path.startsWith('/d1/database?'))).toBe(false);
  });

  it('does nothing past one read when the attempt never had a copy', async () => {
    useCloudflare();
    await deleteSecurityRuntimeCopy(TARGET, SCRIPT);
    expect(cf.calls).toEqual([
      {
        method: 'GET',
        path: `/workers/dispatch/namespaces/${TARGET.namespace}/scripts/${SCRIPT}/settings`,
      },
    ]);
  });
});
