import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { CloudflareCommandResult } from '../../src/execute.ts';
import {
  CloudflareWorkerInspectionError,
  assertCloudflareDurableObjectLifecycleSupported,
  readCloudflareWorkerMigrationTag,
  readExistingCloudflareWorker,
  readCloudflareVersionMigrationTag,
  assertExistingCloudflareConfig,
  assertCloudflareBindingsPreserved,
  type ExistingCloudflareWorker,
} from '../../src/existing.ts';
import type { CloudflareOperation } from '../../src/operations.ts';
import { operationFixture } from '../operation-fixture.ts';
import { apiSecretDraftVersion, voidSecretDraftVersion } from '../secret-draft-fixture.ts';

const worker: ExistingCloudflareWorker = {
  versionId: 'original',
  bindings: [
    { type: 'secret_text', name: 'TOKEN' },
    { type: 'plain_text', name: 'URL', text: 'https://example.com' },
    { type: 'kv_namespace', name: 'KV', namespace_id: 'existing-id' },
  ],
  script: { handlers: ['fetch', 'scheduled'] },
  runtime: { compatibility_date: '2026-02-24', compatibility_flags: [] },
};
const config = {
  name: 'site',
  compatibility_date: '2026-02-24',
  kv_namespaces: [{ binding: 'KV', id: 'existing-id' }],
};

async function withMigrationsConfig(
  migrations: Array<Record<string, unknown>>,
  run: (configPath: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'void-do-lifecycle-'));
  try {
    const configPath = join(root, 'wrangler.jsonc');
    writeFileSync(configPath, JSON.stringify({ migrations }));
    await run(configPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function activeWorkerRunner(version: Record<string, unknown>) {
  return vi.fn(async (operation: CloudflareOperation): Promise<CloudflareCommandResult> => ({
    status: 0,
    stdout: '',
    stderr: '',
    data:
      operation.type === 'deployments.status'
        ? { versions: [{ version_id: 'active', percentage: 100 }] }
        : { id: 'active', ...version },
  }));
}

it('preserves an existing authored version metadata binding without permitting additions', () => {
  const metadata = { type: 'version_metadata', name: 'APP_VERSION' };
  const existing = { ...worker, bindings: [...worker.bindings, metadata] };
  const authored = { ...config, version_metadata: { binding: 'APP_VERSION' } };
  expect(() => assertExistingCloudflareConfig(existing, authored)).not.toThrow();
  expect(() => assertCloudflareBindingsPreserved(existing, existing)).not.toThrow();
  expect(() => assertExistingCloudflareConfig(existing, config)).toThrow('version_metadata');
  expect(() => assertExistingCloudflareConfig(worker, authored)).toThrow('cannot add or replace');
  expect(() =>
    assertExistingCloudflareConfig(existing, {
      ...authored,
      version_metadata: { binding: '__VOID_VERSION_METADATA' },
    }),
  ).toThrow('cannot add or replace');
  expect(() => assertCloudflareBindingsPreserved(worker, existing)).toThrow('preserve');
});

describe('assets-only Worker handoff', () => {
  const assetsOnly: ExistingCloudflareWorker = {
    versionId: 'original',
    bindings: [],
    script: { handlers: null },
    runtime: { compatibility_date: config.compatibility_date, assets: {} },
  };
  const assets = { type: 'assets', name: 'ASSETS' };
  const uploaded = { ...assetsOnly, bindings: [assets], script: { handlers: ['fetch'] } };
  const options = { staticAssetsBinding: 'ASSETS' };
  const staticConfig = {
    name: 'site',
    compatibility_date: config.compatibility_date,
    assets: { directory: 'dist', binding: 'ASSETS' },
  };

  it.each([null, []])('accepts assets metadata with handlers %j', (handlers) => {
    const existing = { ...assetsOnly, script: { handlers } };
    expect(() => assertExistingCloudflareConfig(existing, staticConfig)).not.toThrow();
    expect(() => assertExistingCloudflareConfig(existing, staticConfig, true)).not.toThrow();
    expect(() => assertCloudflareBindingsPreserved(existing, uploaded, [], options)).not.toThrow();
    expect(() => assertCloudflareBindingsPreserved(existing, uploaded)).toThrow('bindings');
  });

  it.each([undefined, 'fetch', ['queue'], ['email']])(
    'rejects missing, malformed, or unsupported handlers %j even with assets',
    (handlers) => {
      expect(() =>
        assertExistingCloudflareConfig({ ...assetsOnly, script: { handlers } }, staticConfig),
      ).toThrow('handlers');
    },
  );

  it.each([undefined, null, false, []])('does not infer assets-only from assets %j', (assets) => {
    const existing = { ...assetsOnly, runtime: { ...assetsOnly.runtime, assets } };
    expect(() => assertExistingCloudflareConfig(existing, staticConfig)).toThrow('handlers');
    expect(() => assertCloudflareBindingsPreserved(existing, uploaded, [], options)).toThrow();
  });

  it('requires exactly the static assets binding and fetch handler', () => {
    for (const bindings of [
      [],
      [{ ...assets, name: 'OTHER' }],
      [assets, assets],
      [assets, { type: 'kv_namespace', name: 'KV', namespace_id: 'new-id' }],
    ]) {
      expect(() =>
        assertCloudflareBindingsPreserved(assetsOnly, { ...uploaded, bindings }, [], options),
      ).toThrow('bindings');
    }
    for (const handlers of [null, [], ['fetch', 'scheduled'], ['fetch', 'queue']]) {
      expect(() =>
        assertCloudflareBindingsPreserved(
          assetsOnly,
          { ...uploaded, script: { handlers } },
          [],
          options,
        ),
      ).toThrow('event handlers');
    }
  });

  it('preserves variables, secrets, and existing resources and rejects name collisions', () => {
    const existing = { ...assetsOnly, bindings: worker.bindings };
    const candidate = { ...uploaded, bindings: [...worker.bindings, assets] };
    expect(() => assertCloudflareBindingsPreserved(existing, candidate, [], options)).not.toThrow();
    expect(() => assertCloudflareBindingsPreserved(existing, uploaded, [], options)).toThrow(
      'bindings',
    );
    const collision = { ...assetsOnly, bindings: [{ name: 'ASSETS', type: 'secret_text' }] };
    for (const bindings of [[assets], collision.bindings, [...collision.bindings, assets]]) {
      expect(() =>
        assertCloudflareBindingsPreserved(collision, { ...uploaded, bindings }, [], options),
      ).toThrow('bindings');
    }
    expect(() =>
      assertExistingCloudflareConfig(assetsOnly, {
        ...staticConfig,
        kv_namespaces: config.kv_namespaces,
      }),
    ).toThrow('cannot add');
  });

  it('does not exempt Workers with existing handlers and supports a completed activation retry', () => {
    expect(() =>
      assertCloudflareBindingsPreserved(
        { ...assetsOnly, script: { handlers: ['scheduled'] } },
        uploaded,
        [],
        options,
      ),
    ).toThrow();
    expect(() => assertExistingCloudflareConfig(uploaded, staticConfig, true)).not.toThrow();
    expect(() => assertCloudflareBindingsPreserved(uploaded, uploaded, [], options)).not.toThrow();
  });
});

describe('existing Worker preservation', () => {
  const approved = [{ binding: 'ISR_CACHE', id: '0123456789abcdef0123456789abcdef' }];
  const cache = { name: 'ISR_CACHE', type: 'kv_namespace', namespace_id: approved[0]!.id };
  it('allows only the approved new KV identity and preserves the original bindings', () => {
    const withCache = { ...config, kv_namespaces: [...config.kv_namespaces, approved[0]!] };
    expect(() => assertExistingCloudflareConfig(worker, config, false, approved)).not.toThrow();
    expect(() => assertExistingCloudflareConfig(worker, config, true, approved)).toThrow(
      'approved KV namespace',
    );
    expect(() => assertExistingCloudflareConfig(worker, withCache, true, approved)).not.toThrow();
    expect(() =>
      assertCloudflareBindingsPreserved(
        worker,
        { ...worker, bindings: [...worker.bindings, cache] },
        approved,
      ),
    ).not.toThrow();
    expect(() => assertCloudflareBindingsPreserved(worker, worker, approved)).toThrow(
      'approved KV namespace',
    );
    expect(() =>
      assertCloudflareBindingsPreserved(worker, { ...worker, bindings: [cache] }, approved),
    ).toThrow('preserve the existing Worker bindings');
    expect(() =>
      assertCloudflareBindingsPreserved(
        worker,
        { ...worker, bindings: [...worker.bindings, { ...cache, namespace_id: 'wrong-id' }] },
        approved,
      ),
    ).toThrow('approved KV namespace');
    expect(() =>
      assertExistingCloudflareConfig(
        worker,
        { ...withCache, kv_namespaces: [approved[0]!] },
        true,
        approved,
      ),
    ).toThrow('existing Cloudflare resource');
    expect(() =>
      assertExistingCloudflareConfig(
        worker,
        {
          ...withCache,
          kv_namespaces: [...withCache.kv_namespaces, { binding: 'OTHER', id: approved[0]!.id }],
        },
        true,
        approved,
      ),
    ).toThrow('cannot add');
  });
  it('cannot use approval to replace or weaken a production binding', () => {
    const retarget = [{ binding: 'KV', id: approved[0]!.id }];
    expect(() => assertExistingCloudflareConfig(worker, config, false, retarget)).toThrow(
      'cannot replace',
    );
    expect(() => assertCloudflareBindingsPreserved(worker, worker, retarget)).toThrow(
      'cannot replace',
    );
    const tampered = {
      ...worker,
      bindings: [
        ...worker.bindings.map((binding) =>
          binding.name === 'TOKEN' ? { ...binding, type: 'plain_text', text: 'private' } : binding,
        ),
        cache,
      ],
    };
    expect(() => assertCloudflareBindingsPreserved(worker, tampered, approved)).toThrow(
      'preserve the existing Worker bindings',
    );
    expect(() =>
      assertCloudflareBindingsPreserved(
        worker,
        { ...worker, bindings: [...worker.bindings, cache], script: { handlers: ['fetch'] } },
        approved,
      ),
    ).toThrow('event handlers');
    const sharedNamespace = {
      ...worker,
      bindings: [{ name: 'KV', type: 'kv_namespace', namespace_id: approved[0]!.id }],
    };
    expect(() =>
      assertCloudflareBindingsPreserved(
        sharedNamespace,
        { ...sharedNamespace, bindings: [...sharedNamespace.bindings, cache] },
        approved,
      ),
    ).toThrow('separate namespace');
  });
  it('handles a completed activation retried before its local handoff was cleared', () => {
    const active = { ...worker, bindings: [...worker.bindings, cache] };
    expect(() => assertCloudflareBindingsPreserved(active, active, approved)).not.toThrow();
    expect(() =>
      assertExistingCloudflareConfig(
        active,
        { ...config, kv_namespaces: [...config.kv_namespaces, approved[0]!] },
        true,
        approved,
      ),
    ).not.toThrow();
  });
  it('keeps remote-only vars/secrets while requiring exact resource identities', () => {
    expect(() => assertExistingCloudflareConfig(worker, config, true)).not.toThrow();
    expect(() =>
      assertExistingCloudflareConfig(worker, {
        ...config,
        kv_namespaces: [{ binding: 'KV', id: 'new-empty-id' }],
      }),
    ).toThrow('existing Cloudflare resource');
    expect(() => assertExistingCloudflareConfig(worker, { ...config, kv_namespaces: [] })).toThrow(
      'existing Cloudflare resource',
    );
  });
  it('blocks variable changes and secret demotion without exposing values', () => {
    for (const vars of [{ TOKEN: 'private-value' }, { URL: 'private-value' }]) {
      try {
        assertExistingCloudflareConfig(worker, { ...config, vars });
        throw new Error('expected rejection');
      } catch (error) {
        expect(String(error)).toContain('Preserve production');
        expect(String(error)).not.toContain('private-value');
      }
    }
  });
  it('rejects an upload that drops an existing event handler', () => {
    expect(() =>
      assertCloudflareBindingsPreserved(worker, {
        ...worker,
        versionId: 'candidate',
        script: { handlers: ['fetch'] },
      }),
    ).toThrow('event handlers');
    expect(() =>
      assertCloudflareBindingsPreserved(worker, {
        ...worker,
        versionId: 'candidate',
        script: { handlers: ['scheduled', 'fetch'] },
      }),
    ).not.toThrow();
  });
  it('blocks new resources, runtime changes, and unsupported bindings', () => {
    expect(() =>
      assertExistingCloudflareConfig(worker, {
        ...config,
        r2_buckets: [{ binding: 'STORAGE', bucket_name: 'new' }],
      }),
    ).toThrow('cannot add');
    expect(() =>
      assertExistingCloudflareConfig(worker, { ...config, compatibility_date: '2026-09-15' }),
    ).toThrow('compatibility_date');
    expect(() =>
      assertExistingCloudflareConfig(
        { ...worker, bindings: [{ name: 'STATE', type: 'durable_object_namespace' }] },
        config,
      ),
    ).toThrow('not yet supported');
  });
  it('accepts empty normalized runtime collections', () => {
    expect(() =>
      assertExistingCloudflareConfig(
        worker,
        { ...config, triggers: { crons: [] }, queues: { consumers: [], producers: [] } },
        true,
      ),
    ).not.toThrow();
  });
  it('compares compatibility flags as a semantic set', () => {
    expect(() =>
      assertExistingCloudflareConfig(
        {
          ...worker,
          runtime: {
            compatibility_date: '2026-02-24',
            compatibility_flags: ['nodejs_compat'],
          },
        },
        { ...config, compatibility_flags: ['nodejs_compat', 'nodejs_compat'] },
        true,
      ),
    ).not.toThrow();
  });
  it('reads the active version and detects changes during inspection', async () => {
    let statuses = 0;
    const runWrangler = operationFixture((args: Array<string>) => ({
      status: 0,
      stderr: '',
      stdout: JSON.stringify(
        args[0] === 'deployments'
          ? {
              versions: [
                { version_id: ++statuses === 1 ? 'original' : 'new-owner', percentage: 100 },
              ],
            }
          : {
              id: 'original',
              resources: {
                bindings: worker.bindings,
                script: worker.script,
                script_runtime: worker.runtime,
              },
            },
      ),
    }));
    await expect(
      readExistingCloudflareWorker({
        runWrangler,
        workerName: 'site',
        configPath: '/app/wrangler.jsonc',
      }),
    ).rejects.toThrow('production changed');
    expect(runWrangler.mock.calls[1]![0]).toContain('original');
  });

  it('does not infer an active migration tag from an explicitly requested candidate', async () => {
    const runWrangler = operationFixture(
      (_args: Array<string>, _options: { capture: boolean }) => ({
        status: 0,
        stderr: '',
        stdout: JSON.stringify({
          id: 'candidate',
          migration_tag: 'not-authoritative',
          resources: {
            bindings: [],
            script: { handlers: ['fetch'] },
            script_runtime: { migration_tag: 'still-not-authoritative' },
          },
        }),
      }),
    );
    const candidate = await readExistingCloudflareWorker({
      runWrangler,
      workerName: 'site',
      configPath: '/app/wrangler.jsonc',
      versionId: 'candidate',
    });
    expect(candidate.script).toEqual({ handlers: ['fetch'] });
    expect(runWrangler).toHaveBeenCalledTimes(1);
    expect(runWrangler.mock.calls[0]![0].slice(0, 3)).toEqual(['versions', 'view', 'candidate']);
  });
  it.each([403, 404, 1])('never turns a failed read (%s) into Worker creation', async (status) => {
    const inspect = readExistingCloudflareWorker({
      runWrangler: operationFixture(() => ({ status, stdout: '', stderr: 'private data' })),
      workerName: 'site',
      configPath: '/app/wrangler.jsonc',
    });
    await expect(inspect).rejects.toBeInstanceOf(CloudflareWorkerInspectionError);
  });

  it('rejects a pending class migration on an existing Worker', async () => {
    const migrations = [
      { tag: 'v1', new_sqlite_classes: ['Room'] },
      { tag: 'v2', new_sqlite_classes: ['Counter'] },
    ];
    const runWrangler = activeWorkerRunner({
      resources: {
        bindings: [],
        script: { handlers: ['fetch'] },
        script_runtime: { migration_tag: 'v1' },
      },
    });
    await withMigrationsConfig(migrations, async (configPath) => {
      await expect(
        assertCloudflareDurableObjectLifecycleSupported({
          runWrangler,
          configPath,
          workerName: 'app',
          accountId: 'account',
          apiBaseUrl: 'https://api.cloudflare.test/client/v4',
          readMigrationTag: async () => 'v1',
        }),
      ).rejects.toThrow(/atomic Cloudflare deployment[\s\S]*v2/);
      await expect(
        assertCloudflareDurableObjectLifecycleSupported({
          runWrangler,
          configPath,
          workerName: 'app',
          accountId: 'account',
          apiBaseUrl: 'https://api.cloudflare.test/client/v4',
          readMigrationTag: async () => 'v1',
          allowPendingAtomicMigration: true,
        }),
      ).resolves.toBeUndefined();
      expect(runWrangler).toHaveBeenCalledTimes(12);
    });
  });

  it('allows first deployment and an already-active class migration', async () => {
    const missing = operationFixture(() => ({
      status: 1,
      stdout: '',
      stderr: 'This Worker does not exist. [code: 10007]',
    }));
    const active = activeWorkerRunner({
      resources: {
        bindings: [],
        script: { handlers: ['fetch'] },
        script_runtime: { migration_tag: 'v1' },
      },
    });
    await withMigrationsConfig(
      [{ tag: 'v1', new_sqlite_classes: ['Room'] }],
      async (configPath) => {
        await expect(
          assertCloudflareDurableObjectLifecycleSupported({
            runWrangler: missing,
            configPath,
            workerName: 'first',
            accountId: 'account',
            apiBaseUrl: 'https://api.cloudflare.test/client/v4',
          }),
        ).resolves.toBeUndefined();
        await expect(
          assertCloudflareDurableObjectLifecycleSupported({
            runWrangler: active,
            configPath,
            workerName: 'app',
            accountId: 'account',
            apiBaseUrl: 'https://api.cloudflare.test/client/v4',
            readMigrationTag: async () => 'v1',
          }),
        ).resolves.toBeUndefined();
      },
    );
  });

  it.each(['placeholder', 'api-placeholder', 'real-code', 'owner-drift'] as const)(
    'verifies immutable SDK secret-draft proof before its first DO migration: %s',
    async (scenario) => {
      const source =
        scenario === 'api-placeholder' ? apiSecretDraftVersion() : voidSecretDraftVersion();
      if (scenario === 'real-code') {
        source.modules[0]!.content_base64 = Buffer.from(
          'export default { fetch() { return new Response("app"); } };',
        ).toString('base64');
      }
      let owner = source.id;
      const runWrangler = vi.fn(
        async (operation: CloudflareOperation): Promise<CloudflareCommandResult> => {
          if (operation.type === 'deployments.status') {
            return {
              status: 0,
              stdout: '',
              stderr: '',
              data: { versions: [{ version_id: owner, percentage: 100 }] },
            };
          }
          if (operation.type === 'versions.view') {
            if (operation.includeSource) {
              if (scenario === 'owner-drift') {
                owner = '22222222-2222-4222-8222-222222222222';
              }
              return { status: 0, stdout: '', stderr: '', data: source };
            }
            return {
              status: 0,
              stdout: '',
              stderr: '',
              data: {
                id: operation.versionId,
                source: source.source,
                annotations: source.annotations,
                resources: {
                  bindings: source.bindings,
                  script: { handlers: ['fetch'] },
                  script_runtime: {
                    compatibility_date: source.compatibility_date,
                    usage_model: 'standard',
                  },
                },
              },
            };
          }
          throw new Error(`Unexpected read-only lifecycle operation: ${operation.type}`);
        },
      );
      await withMigrationsConfig(
        [{ tag: 'v1', new_sqlite_classes: ['Room'] }],
        async (configPath) => {
          const inspection = assertCloudflareDurableObjectLifecycleSupported({
            runWrangler,
            configPath,
            workerName: 'app',
            accountId: 'account',
            apiBaseUrl: 'https://api.cloudflare.test/client/v4',
            readMigrationTag: async () => null,
          });
          if (scenario === 'placeholder' || scenario === 'api-placeholder') {
            await expect(inspection).resolves.toBeUndefined();
          } else {
            await expect(inspection).rejects.toThrow(
              scenario === 'owner-drift' ? 'production changed' : 'atomic Cloudflare deployment',
            );
          }
          expect(
            runWrangler.mock.calls.filter(
              ([operation]) => operation.type === 'versions.view' && operation.includeSource,
            ),
          ).toHaveLength(scenario === 'owner-drift' ? 1 : 2);
        },
      );
    },
  );

  it('does not request source for an ordinary existing Worker read', async () => {
    const runWrangler = vi.fn(
      async (operation: CloudflareOperation): Promise<CloudflareCommandResult> => ({
        status: 0,
        stdout: '',
        stderr: '',
        data:
          operation.type === 'deployments.status'
            ? { versions: [{ version_id: worker.versionId, percentage: 100 }] }
            : {
                id: worker.versionId,
                resources: {
                  bindings: worker.bindings,
                  script: worker.script,
                  script_runtime: worker.runtime,
                },
              },
      }),
    );
    await expect(
      readExistingCloudflareWorker({
        runWrangler,
        configPath: '/app/wrangler.jsonc',
        workerName: 'app',
      }),
    ).resolves.toEqual(worker);
    expect(
      runWrangler.mock.calls.some(([op]) => op.type === 'versions.view' && op.includeSource),
    ).toBe(false);
  });

  it.each<Partial<CloudflareCommandResult>>([
    { signal: 'SIGTERM' },
    { error: 'provider process failed' },
    { status: Number.NaN },
  ])('never treats an interrupted lifecycle probe as an absent Worker: %j', async (provenance) => {
    await withMigrationsConfig(
      [{ tag: 'v1', new_sqlite_classes: ['Room'] }],
      async (configPath) => {
        await expect(
          assertCloudflareDurableObjectLifecycleSupported({
            runWrangler: () => ({
              status: 1,
              stdout: '',
              stderr: '',
              errorCode: 10007,
              failure: 'not-found',
              ...provenance,
            }),
            configPath,
            workerName: 'app',
            accountId: 'account',
            apiBaseUrl: 'https://api.cloudflare.test/client/v4',
          }),
        ).rejects.toBeInstanceOf(CloudflareWorkerInspectionError);
      },
    );
  });

  it('accepts an already-published declarative Durable Object state without a legacy tag', async () => {
    const migrations = [
      { tag: 'fate-v1', new_sqlite_classes: ['Fate'] },
      { tag: 'live-v1', deleted_classes: ['Fate'], new_sqlite_classes: ['Live'] },
    ];
    const runWrangler = activeWorkerRunner({
      resources: {
        bindings: [],
        script: { handlers: ['fetch'] },
        script_runtime: {
          exports: { Live: { type: 'durable-object', storage: 'sqlite' } },
        },
      },
    });
    await withMigrationsConfig(migrations, async (configPath) => {
      await expect(
        assertCloudflareDurableObjectLifecycleSupported({
          runWrangler,
          configPath,
          workerName: 'app',
          accountId: 'account',
          apiBaseUrl: 'https://api.cloudflare.test/client/v4',
          readMigrationTag: async () => null,
        }),
      ).resolves.toBeUndefined();
    });
  });

  it('does not authenticate or read metadata without a class migration', async () => {
    const runWrangler = operationFixture(() => {
      throw new Error('must not run');
    });
    await withMigrationsConfig([{ tag: 'v1' }], async (configPath) => {
      await expect(
        assertCloudflareDurableObjectLifecycleSupported({
          runWrangler,
          configPath,
          workerName: 'app',
          accountId: 'account',
          apiBaseUrl: 'https://api.cloudflare.test/client/v4',
        }),
      ).resolves.toBeUndefined();
      expect(runWrangler).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      tag: 'older',
      runtime: { usage_model: 'standard' },
      binding: { name: 'TOKEN', type: 'secret_text' },
      annotation: 'secret',
    },
    {
      tag: null,
      runtime: { usage_model: 'standard', compatibility_date: '2026-09-18' },
      binding: { name: 'TOKEN', type: 'secret_text' },
      annotation: 'secret',
    },
    {
      tag: null,
      runtime: { usage_model: 'standard' },
      binding: { name: 'DB', type: 'd1', id: 'existing-database' },
      annotation: 'secret',
    },
    {
      tag: null,
      runtime: { usage_model: 'standard' },
      binding: { name: 'TOKEN', type: 'secret_text' },
      annotation: 'upload',
    },
  ])(
    'does not treat an established Worker as an initial-secret bootstrap: %j',
    async ({ tag, runtime, binding, annotation }) => {
      const runWrangler = activeWorkerRunner({
        annotations: { 'workers/triggered_by': annotation },
        resources: {
          bindings: [binding],
          script: { handlers: ['fetch'] },
          script_runtime: runtime,
        },
      });
      const migrations = [{ tag: 'live-v1', new_sqlite_classes: ['Room'] }];
      await withMigrationsConfig(migrations, async (configPath) => {
        await expect(
          assertCloudflareDurableObjectLifecycleSupported({
            runWrangler,
            configPath,
            workerName: 'app',
            accountId: 'account',
            apiBaseUrl: 'https://api.cloudflare.test/client/v4',
            readMigrationTag: async () => tag,
          }),
        ).rejects.toThrow(/atomic Cloudflare deployment[\s\S]*live-v1/);
        expect(
          runWrangler.mock.calls.every(
            ([operation]) =>
              operation.type === 'deployments.status' || operation.type === 'versions.view',
          ),
        ).toBe(true);
      });
    },
  );

  it('reads current and legacy Worker version migration-tag shapes', () => {
    expect(
      readCloudflareVersionMigrationTag({
        resources: { script_runtime: { migration_tag: 'current' } },
      }),
    ).toBe('current');
    expect(
      readCloudflareVersionMigrationTag({ resources: { script: { migration_tag: 'legacy' } } }),
    ).toBe('legacy');
    expect(readCloudflareVersionMigrationTag({ script: { migration_tag: 'older' } })).toBe('older');
    expect(readCloudflareVersionMigrationTag({})).toBeNull();
  });

  it('reads the authoritative migration tag from Worker script metadata', async () => {
    const runWrangler = operationFixture(() => ({
      status: 0,
      stdout: JSON.stringify({ type: 'oauth', token: 'private-token' }),
      stderr: '',
    }));
    const fetchMock = vi.fn(async () =>
      Response.json({
        success: true,
        result: [
          { id: 'other', migration_tag: 'v0' },
          { id: 'app', migration_tag: 'v2' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(
        readCloudflareWorkerMigrationTag({
          runWrangler,
          accountId: 'account/id',
          apiBaseUrl: 'https://api.cloudflare.test/client/v4/',
          workerName: 'app',
        }),
      ).resolves.toBe('v2');
      expect(runWrangler).toHaveBeenCalledWith(['auth', 'token', '--json'], { capture: true });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.cloudflare.test/client/v4/accounts/account%2Fid/workers/scripts',
        expect.objectContaining({
          headers: { Authorization: 'Bearer private-token' },
          redirect: 'error',
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects migration state that changes during lifecycle verification', async () => {
    const runWrangler = activeWorkerRunner({
      annotations: { 'workers/triggered_by': 'secret' },
      resources: {
        bindings: [{ name: 'TOKEN', type: 'secret_text' }],
        script: { handlers: ['fetch'] },
        script_runtime: { usage_model: 'standard' },
      },
    });
    const readMigrationTag = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('v1');
    await withMigrationsConfig(
      [{ tag: 'v1', new_sqlite_classes: ['Room'] }],
      async (configPath) => {
        await expect(
          assertCloudflareDurableObjectLifecycleSupported({
            runWrangler,
            configPath,
            workerName: 'app',
            accountId: 'account',
            apiBaseUrl: 'https://api.cloudflare.test/client/v4',
            readMigrationTag,
          }),
        ).rejects.toThrow('migration state changed');
        expect(readMigrationTag).toHaveBeenCalledTimes(2);
      },
    );
  });
});
