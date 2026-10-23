import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeCloudflareVersionMessage } from '@void/deploy-cloudflare';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  activateCloudflareExistingVersion,
  changeCloudflareDomain,
  deleteCloudflareSecret,
  executeCloudflareD1Sql,
  applyCloudflareD1Migrations,
  listCloudflareDomains,
  listCloudflareSecrets,
  parseActiveVersionId,
  parseCloudflareDeployedVersionIds,
  parseCloudflareVersions,
  putCloudflareSecret,
  readCloudflareWorkerStatus,
  readCloudflareD1Migrations,
  resolveCloudflareD1Context,
  restoreCloudflareD1Database,
  syncCloudflareSecrets,
  tailCloudflareWorker,
  type CloudflareOperationContext,
  type CloudflareOperationRunner,
} from '../../src/cli/cloudflare-operations.ts';
import {
  readWranglerCustomDomains,
  readWranglerPublishedTrafficSnapshot,
  updateWranglerCustomDomain,
} from '../../src/cli/wrangler.ts';

const ok = (data?: unknown) => ({
  status: 0,
  data,
  stdout: '',
  stderr: '',
  signal: null,
  error: null,
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function context(runWrangler: CloudflareOperationRunner): CloudflareOperationContext {
  return {
    accountId: 'account-1',
    apiBaseUrl: 'https://api.cloudflare.com/client/v4',
    configPath: '/app/wrangler.jsonc',
    workerName: 'my-worker',
    runWrangler,
  };
}

function project(config?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-operations-'));
  writeFileSync(
    join(root, 'wrangler.jsonc'),
    config ??
      '{\n  "name": "my-worker",\n  "account_id": "account-1",\n  "compatibility_date": "2026-02-24"\n}\n',
  );
  return root;
}

describe('Cloudflare operational parsing', () => {
  it('rolls back to an original version while preserving current triggers and settings', async () => {
    const root = project();
    let active = 'new';
    const runner = vi.fn<CloudflareOperationRunner>((args) => {
      if (args.type === 'deployments.status') {
        return ok({ versions: [{ version_id: active, percentage: 100 }] });
      }
      if (args.type === 'versions.deploy') {
        const config = JSON.parse(readFileSync(args.configPath!, 'utf8'));
        expect(config).toEqual({ account_id: 'account-1', name: 'my-worker' });
        expect(args).not.toHaveProperty('bypassDeploymentChecks');
        active = 'original';
        return ok();
      }
      throw new Error(`Unexpected mutation ${args.type}`);
    });
    await activateCloudflareExistingVersion(
      { ...context(runner), configPath: join(root, 'wrangler.jsonc') },
      { id: 'original', message: null, metadata: null, createdAt: null },
      { id: 'new', message: null, metadata: null, createdAt: null },
    );
    expect(active).toBe('original');
    expect(runner.mock.calls).toHaveLength(3);
  });
  it('uses traffic-only rollback when the active version is outside the recent version list', async () => {
    const root = project();
    let active = 'new-outside-list';
    const runner = vi.fn<CloudflareOperationRunner>((args) => {
      if (args.type === 'deployments.status') {
        return ok({ versions: [{ version_id: active, percentage: 100 }] });
      }
      if (args.type === 'versions.deploy') {
        const config = JSON.parse(readFileSync(args.configPath!, 'utf8'));
        expect(config).toEqual({ account_id: 'account-1', name: 'my-worker' });
        active = 'target';
        return ok();
      }
      throw new Error(`Unexpected mutation ${args.type}`);
    });
    const triggerConfig = {
      workers_dev: true,
      preview_urls: true,
      routes: [],
      crons: ['0 * * * *'],
      queueConsumers: [],
      workflows: [],
    };
    await activateCloudflareExistingVersion(
      { ...context(runner), configPath: join(root, 'wrangler.jsonc') },
      {
        id: 'target',
        message: null,
        metadata: { schema: 2, migrations: [], triggerConfig },
        createdAt: null,
      },
      undefined,
    );
    expect(active).toBe('target');
    expect(runner.mock.calls.some(([args]) => args.type.startsWith('triggers.'))).toBe(false);
  });
  it('reads active traffic and Void migration metadata', () => {
    expect(
      parseActiveVersionId({
        versions: [
          { version_id: 'canary', percentage: 10 },
          { version_id: 'active', percentage: 100 },
        ],
      }),
    ).toBe('active');
    expect(
      parseActiveVersionId({
        versions: [
          { version_id: 'stable', percentage: 90 },
          { version_id: 'canary', percentage: 10 },
        ],
      }),
    ).toBeNull();
    expect(
      parseCloudflareVersions([
        {
          id: 'version-1',
          metadata: { created_on: '2026-09-11T00:00:00.000Z' },
          annotations: {
            'workers/message': 'void:{"schema":1,"migrations":["0000_init.sql"]}',
          },
        },
      ]),
    ).toEqual([
      {
        id: 'version-1',
        createdAt: '2026-09-11T00:00:00.000Z',
        message: 'void:{"schema":1,"migrations":["0000_init.sql"]}',
        metadata: { schema: 1, migrations: ['0000_init.sql'] },
      },
    ]);
  });

  it('fails closed on malformed structured responses and rejects legacy JSON strings', () => {
    expect(() => parseCloudflareVersions(JSON.stringify([{ id: 'legacy' }]))).toThrow(
      'unexpected response',
    );
    expect(() => parseCloudflareVersions({})).toThrow('unexpected response');
    expect(() => parseActiveVersionId(undefined)).toThrow('did not return structured data');
  });

  it('accepts only versions recorded in deployment history as rollback candidates', () => {
    expect(
      parseCloudflareDeployedVersionIds([
        { versions: [{ version_id: 'v1', percentage: 100 }] },
        {
          versions: [
            { version_id: 'v2', percentage: 100 },
            { version_id: 'failed-readiness', percentage: 0 },
          ],
        },
      ]),
    ).toEqual(['v1', 'v2']);
    expect(() => parseCloudflareDeployedVersionIds([{ versions: [{}] }])).toThrow('malformed');
    expect(() => parseCloudflareDeployedVersionIds([{ versions: [{ version_id: 'v3' }] }])).toThrow(
      'malformed',
    );
  });
});

describe('Cloudflare secret operations', () => {
  it('uses structured provider data even when diagnostics contain other JSON', async () => {
    const runner = vi.fn<CloudflareOperationRunner>().mockReturnValue({
      ...ok([{ name: 'ACTUAL' }]),
      stdout: JSON.stringify([{ name: 'DIAGNOSTIC_ONLY' }]),
    });
    await expect(listCloudflareSecrets(context(runner))).resolves.toEqual(['ACTUAL']);
    expect(runner).toHaveBeenCalledExactlyOnceWith(
      { type: 'secret.list', configPath: '/app/wrangler.jsonc', workerName: 'my-worker' },
      { capture: true, input: undefined },
    );
  });

  it('lists only secret names and sorts them', async () => {
    const runner = vi
      .fn<CloudflareOperationRunner>()
      .mockReturnValue(ok([{ name: 'ZED', type: 'secret_text' }, { name: 'ALPHA' }]));
    await expect(listCloudflareSecrets(context(runner))).resolves.toEqual(['ALPHA', 'ZED']);
    expect(runner).toHaveBeenCalledWith(
      { type: 'secret.list', configPath: '/app/wrangler.jsonc', workerName: 'my-worker' },
      { capture: true, input: undefined },
    );
  });

  it('streams put and bulk values over stdin, never argv', async () => {
    const runner = vi.fn<CloudflareOperationRunner>().mockReturnValue(ok());
    const ctx = context(runner);
    await putCloudflareSecret(ctx, 'API_KEY', 'super-secret');
    await syncCloudflareSecrets(ctx, [
      { name: 'ONE', value: 'first' },
      { name: 'TWO', value: 'second' },
    ]);
    const putCall = runner.mock.calls[0];
    expect(putCall[0]).toEqual({
      type: 'secret.put',
      name: 'API_KEY',
      configPath: '/app/wrangler.jsonc',
      workerName: 'my-worker',
    });
    expect(JSON.stringify(putCall[0])).not.toContain('super-secret');
    expect(putCall[1].input).toBe('super-secret');
    const bulkCall = runner.mock.calls[1];
    expect(bulkCall[0]).toEqual({
      type: 'secret.bulk',
      configPath: '/app/wrangler.jsonc',
      workerName: 'my-worker',
    });
    expect(JSON.stringify(bulkCall[0])).not.toContain('first');
    expect(JSON.parse(bulkCall[1].input!)).toEqual({ ONE: 'first', TWO: 'second' });
  });

  it('uses Wrangler delete only after the user invokes delete', async () => {
    const runner = vi.fn<CloudflareOperationRunner>().mockReturnValue(ok());
    await deleteCloudflareSecret(context(runner), 'OLD_KEY');
    expect(runner.mock.calls[0][0]).toEqual({
      type: 'secret.delete',
      name: 'OLD_KEY',
      configPath: '/app/wrangler.jsonc',
      workerName: 'my-worker',
    });
  });
});

describe('Cloudflare version operations', () => {
  it('reads deployment status and recent versions', async () => {
    const runner = vi.fn<CloudflareOperationRunner>((args) => {
      if (args.type === 'deployments.status') {
        return ok({ versions: [{ version_id: 'v2', percentage: 100 }] });
      }
      if (args.type === 'deployments.list') {
        return ok([{ versions: [{ version_id: 'v1', percentage: 100 }] }]);
      }
      return ok([
        { id: 'v1', metadata: {}, annotations: {} },
        { id: 'v2', metadata: {}, annotations: {} },
      ]);
    });
    const status = await readCloudflareWorkerStatus(context(runner));
    expect(status.activeVersionId).toBe('v2');
    expect(status.deployedVersionIds).toEqual(['v1', 'v2']);
    expect(status.versions.map((version) => version.id)).toEqual(['v1', 'v2']);
  });

  it('activates the selected version and restores its versioned triggers', async () => {
    let activeVersionId = 'v2';
    const runner = vi.fn<CloudflareOperationRunner>((args) => {
      if (args.type === 'deployments.status') {
        return ok({ versions: [{ version_id: activeVersionId, percentage: 100 }] });
      }
      if (args.type === 'versions.deploy') {
        activeVersionId = 'v1';
      }
      return ok();
    });
    const triggerConfig = {
      workers_dev: true,
      preview_urls: true,
      routes: [],
      crons: ['0 * * * *'],
      queueConsumers: [],
      workflows: [],
    };
    await activateCloudflareExistingVersion(
      context(runner),
      {
        id: 'v1',
        createdAt: null,
        message: null,
        metadata: { schema: 2, migrations: ['0000_init.sql'], triggerConfig },
      },
      {
        id: 'v2',
        createdAt: null,
        message: null,
        metadata: { schema: 2, migrations: [], triggerConfig },
      },
    );
    const activation = runner.mock.calls.find(
      ([args]) =>
        args.type === 'versions.deploy' &&
        args.versions.some((version) => version.versionId === 'v1' && version.percentage === 100),
    )!;
    expect(activation[0].type === 'versions.deploy' ? activation[0].message : undefined).toBe(
      'void:{"schema":2,"migrations":["0000_init.sql"],"triggerConfig":{"workers_dev":true,"preview_urls":true,"routes":[],"crons":["0 * * * *"],"queueConsumers":[],"workflows":[]}}',
    );
    expect(activation[0]).not.toHaveProperty('bypassDeploymentChecks');
    expect(runner.mock.calls.some(([args]) => args.type === 'triggers.deploy')).toBe(true);
  });

  it('restores the active version and triggers when rollback trigger sync fails', async () => {
    let triggerCalls = 0;
    let activeVersionId = 'v2';
    const runner = vi.fn<CloudflareOperationRunner>((args) => {
      if (args.type === 'deployments.status') {
        return ok({ versions: [{ version_id: activeVersionId, percentage: 100 }] });
      }
      if (args.type === 'versions.deploy') {
        activeVersionId =
          args.type === 'versions.deploy' &&
          args.versions.some((version) => version.versionId === 'v1' && version.percentage === 100)
            ? 'v1'
            : 'v2';
      }
      if (args.type.startsWith('triggers.') && ++triggerCalls === 1) {
        return { ...ok(), status: 1, stderr: 'partial trigger failure' };
      }
      return ok();
    });
    const triggerConfig = {
      workers_dev: true,
      preview_urls: true,
      routes: [],
      crons: [],
      queueConsumers: [],
      workflows: [],
    };

    await expect(
      activateCloudflareExistingVersion(
        context(runner),
        {
          id: 'v1',
          createdAt: null,
          message: null,
          metadata: { schema: 2, migrations: [], triggerConfig },
        },
        {
          id: 'v2',
          createdAt: null,
          message: null,
          metadata: { schema: 2, migrations: [], triggerConfig },
        },
      ),
    ).rejects.toThrow(/traffic and triggers were restored to v2/);
    expect(
      runner.mock.calls.filter(([args]) => args.type === 'versions.deploy').map(([args]) => args),
    ).toEqual([
      expect.objectContaining({ versions: [{ versionId: 'v1', percentage: 100 }] }),
      expect.objectContaining({
        versions: [{ versionId: 'v2', percentage: 100 }],
        bypassDeploymentChecks: true,
      }),
    ]);
    expect(
      runner.mock.calls.find(([args]) => args.type === 'versions.deploy')![0],
    ).not.toHaveProperty('bypassDeploymentChecks');
    expect(runner.mock.calls.filter(([args]) => args.type === 'triggers.deploy')).toHaveLength(2);
    expect(runner.mock.calls.filter(([args]) => args.type === 'triggers.clear-crons')).toHaveLength(
      1,
    );
  });

  it('repairs triggers for a concurrent rollback that supersedes activation', async () => {
    const activation = deferred<ReturnType<typeof ok>>();
    const activationStarted = deferred<void>();
    let activeVersionId = 'v3';
    let appliedTriggerConfig: Record<string, unknown> | undefined;
    const configFor = (cron: string) => ({
      workers_dev: true,
      preview_urls: true,
      routes: [],
      crons: [cron],
      queueConsumers: [],
      workflows: [],
    });
    const runner = vi.fn<CloudflareOperationRunner>(async (args) => {
      if (args.type === 'deployments.status') {
        return ok({ versions: [{ version_id: activeVersionId, percentage: 100 }] });
      }
      if (args.type === 'versions.deploy') {
        activeVersionId = 'v1';
        activationStarted.resolve(undefined);
        return activation.promise;
      }
      if (args.type === 'versions.list') {
        return ok([
          {
            id: 'v2',
            annotations: {
              'workers/message': encodeCloudflareVersionMessage([], configFor('v2')),
            },
          },
        ]);
      }
      if (args.type.startsWith('triggers.')) {
        appliedTriggerConfig = JSON.parse(readFileSync(args.configPath!, 'utf8')) as Record<
          string,
          unknown
        >;
        return ok();
      }
      throw new Error(`Unexpected command: ${args.type}`);
    });

    const pending = activateCloudflareExistingVersion(
      context(runner),
      {
        id: 'v1',
        createdAt: null,
        message: null,
        metadata: { schema: 2, migrations: [], triggerConfig: configFor('v1') },
      },
      {
        id: 'v3',
        createdAt: null,
        message: null,
        metadata: { schema: 2, migrations: [], triggerConfig: configFor('v3') },
      },
    );
    await activationStarted.promise;
    activeVersionId = 'v2';
    activation.resolve(ok());

    await expect(pending).rejects.toThrow(
      /superseded by v2.*restored the active version's triggers/,
    );
    expect(appliedTriggerConfig).toMatchObject({ triggers: { crons: ['v2'] } });
  });

  it('does not compensate over a concurrent rollback after trigger failure', async () => {
    const failedTriggers = deferred<ReturnType<typeof ok>>();
    const triggerStarted = deferred<void>();
    let activeVersionId = 'v3';
    let triggerCalls = 0;
    const configFor = (cron: string) => ({
      workers_dev: true,
      preview_urls: true,
      routes: [],
      crons: [cron],
      queueConsumers: [],
      workflows: [],
    });
    const runner = vi.fn<CloudflareOperationRunner>(async (args) => {
      if (args.type === 'deployments.status') {
        return ok({ versions: [{ version_id: activeVersionId, percentage: 100 }] });
      }
      if (args.type === 'versions.deploy') {
        activeVersionId = 'v1';
        return ok();
      }
      if (args.type === 'versions.list') {
        return ok([
          {
            id: 'v2',
            annotations: {
              'workers/message': encodeCloudflareVersionMessage([], configFor('v2')),
            },
          },
        ]);
      }
      if (args.type.startsWith('triggers.')) {
        triggerCalls++;
        if (triggerCalls === 1) {
          triggerStarted.resolve(undefined);
          return failedTriggers.promise;
        }
        return ok();
      }
      throw new Error(`Unexpected command: ${args.type}`);
    });

    const pending = activateCloudflareExistingVersion(
      context(runner),
      {
        id: 'v1',
        createdAt: null,
        message: null,
        metadata: { schema: 2, migrations: [], triggerConfig: configFor('v1') },
      },
      {
        id: 'v3',
        createdAt: null,
        message: null,
        metadata: { schema: 2, migrations: [], triggerConfig: configFor('v3') },
      },
    );
    await triggerStarted.promise;
    activeVersionId = 'v2';
    failedTriggers.resolve({ ...ok(), status: 1 });

    await expect(pending).rejects.toThrow(
      /superseded by v2.*restored the active version's triggers/,
    );
    expect(runner.mock.calls.filter(([args]) => args.type === 'versions.deploy')).toHaveLength(1);
  });

  it('maps search, version, and error filters to a live tail', async () => {
    const runner = vi.fn<CloudflareOperationRunner>().mockReturnValue(ok());
    await tailCloudflareWorker(context(runner), {
      filter: 'socket',
      versionId: 'v1',
      status: 'error',
    });
    expect(runner.mock.calls[0]).toEqual([
      {
        type: 'tail',
        workerName: 'my-worker',
        configPath: '/app/wrangler.jsonc',
        search: 'socket',
        versionId: 'v1',
        status: 'error',
      },
      { capture: false, input: undefined },
    ]);
  });
});

describe('Cloudflare D1 operations', () => {
  it('resolves the configured migration identity and executes remote SQL as JSON', async () => {
    const root = project(`{
  "name": "my-worker",
  "account_id": "account-1",
  "d1_databases": [{
    "binding": "DATA",
    "database_name": "my-data",
    "database_id": "11111111-2222-3333-4444-555555555555",
    "migrations_dir": "db/custom",
    "migrations_table": "custom_migrations"
  }]
}\n`);
    const runner = vi
      .fn<CloudflareOperationRunner>()
      .mockReturnValue(ok([{ success: true, results: [{ id: 1, name: 'Ada' }] }]));
    const ctx = resolveCloudflareD1Context(root, 'DATA', runner);
    expect(ctx).toMatchObject({
      binding: 'DATA',
      migrateToken: 'my-data',
      migrationsDir: 'db/custom',
      migrationsTable: 'custom_migrations',
    });
    await expect(executeCloudflareD1Sql(ctx, 'select * from users')).resolves.toEqual([
      { id: 1, name: 'Ada' },
    ]);
    expect(runner.mock.calls[0][0]).toEqual({
      type: 'd1.execute',
      database: 'my-data',
      sql: 'select * from users',
      configPath: join(root, 'wrangler.jsonc').replaceAll('\\', '/'),
    });
  });

  it('leaves migrationsDir unset when the D1 binding has none', () => {
    const root = project(`{
  "name": "my-worker",
  "account_id": "account-1",
  "d1_databases": [{
    "binding": "DB",
    "database_name": "my-data",
    "database_id": "11111111-2222-3333-4444-555555555555"
  }]
}\n`);
    const ctx = resolveCloudflareD1Context(root, 'DB', vi.fn<CloudflareOperationRunner>());
    expect(ctx.migrationsDir).toBeUndefined();
    expect(ctx.migrationsTable).toBe('d1_migrations');
  });

  it('reads applied migration names from a custom tracking table', async () => {
    const runner = vi
      .fn<CloudflareOperationRunner>()
      .mockReturnValue(
        ok([{ success: true, results: [{ name: '0000_init.sql' }, { name: '0001_more.sql' }] }]),
      );
    const ctx = {
      operation: context(runner),
      binding: 'DB',
      migrateToken: 'db-name',
      migrationsDir: 'db/migrations',
      migrationsTable: 'custom"table',
    };
    await expect(readCloudflareD1Migrations(ctx)).resolves.toEqual([
      '0000_init.sql',
      '0001_more.sql',
    ]);
    expect(runner.mock.calls[0][0]).toMatchObject({
      type: 'd1.execute',
      database: 'db-name',
      sql: 'SELECT name FROM "custom""table" ORDER BY name',
    });
  });

  it('applies migrations through the exact configured D1 target', async () => {
    const runner = vi.fn<CloudflareOperationRunner>().mockReturnValue(ok());
    await applyCloudflareD1Migrations({
      operation: context(runner),
      binding: 'DB',
      migrateToken: 'db-name',
      migrationsDir: 'db/migrations',
      migrationsTable: 'd1_migrations',
    });
    expect(runner.mock.calls[0]).toEqual([
      { type: 'd1.migrations.apply', database: 'db-name', configPath: '/app/wrangler.jsonc' },
      { capture: false, input: undefined },
    ]);
  });

  it('restores the exact configured D1 target and returns the bookmark that undoes it', async () => {
    const runner = vi
      .fn<CloudflareOperationRunner>()
      .mockReturnValue(ok({ previousBookmark: '00000001-00000002' }));
    const ctx = {
      operation: context(runner),
      binding: 'DB',
      migrateToken: 'db-name',
      migrationsDir: 'db/migrations',
      migrationsTable: 'd1_migrations',
    };
    await expect(
      restoreCloudflareD1Database(ctx, { timestamp: '2026-10-16T09:30:00Z' }),
    ).resolves.toBe('00000001-00000002');
    expect(runner.mock.calls[0][0]).toEqual({
      type: 'd1.time-travel.restore',
      database: 'db-name',
      target: { timestamp: '2026-10-16T09:30:00Z' },
      configPath: '/app/wrangler.jsonc',
    });
  });
});

describe('Cloudflare custom domains', () => {
  it('adds and removes a custom domain while preserving unrelated routes and comments', () => {
    const root = project(`{
  "name": "my-worker",
  "account_id": "account-1",
  // Keep this route.
  "routes": [
    { "pattern": "api.example.com/*", "zone_name": "example.com" }
  ]
}\n`);
    const added = updateWranglerCustomDomain(root, 'app.example.com', 'add');
    expect(added.domains.map((domain) => domain.pattern)).toEqual(['app.example.com']);
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')).toContain('// Keep this route.');
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')).toContain('api.example.com/*');
    const removed = updateWranglerCustomDomain(root, 'app.example.com', 'delete');
    expect(removed.domains).toEqual([]);
    expect(readWranglerCustomDomains(root).domains).toEqual([]);
  });

  it('rejects a collision with an existing non-custom route', () => {
    const root = project(
      '{"name":"my-worker","account_id":"account-1","routes":["app.example.com"]}',
    );
    expect(() => updateWranglerCustomDomain(root, 'app.example.com', 'add')).toThrow(
      'already exists as a non-custom route',
    );
  });

  it('rejects a singular route instead of shadowing it with a routes array', () => {
    const root = project(
      '{"name":"my-worker","account_id":"account-1","route":"api.example.com/*"}',
    );
    expect(() => updateWranglerCustomDomain(root, 'app.example.com', 'add')).toThrow(
      'uses the singular "route" field',
    );
  });

  it('synchronizes domains without replaying cron, queue, or workflow triggers', async () => {
    const root = project(`{
  "name": "my-worker",
  "account_id": "account-1",
  "workers_dev": false,
  "triggers": { "crons": ["0 * * * *"] },
  "queues": { "consumers": [{ "queue": "jobs" }] },
  "workflows": [{ "name": "flow", "class_name": "Flow" }]
}\n`);
    let deployedConfig: Record<string, unknown> | undefined;
    const runner = vi.fn<CloudflareOperationRunner>((args) => {
      deployedConfig = JSON.parse(readFileSync(args.configPath!, 'utf-8')) as Record<
        string,
        unknown
      >;
      return ok();
    });

    await changeCloudflareDomain(root, 'app.example.com', 'add', runner);

    expect(deployedConfig).toEqual({
      name: 'my-worker',
      account_id: 'account-1',
      workers_dev: false,
      routes: [{ pattern: 'app.example.com', custom_domain: true }],
    });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(readWranglerPublishedTrafficSnapshot(join(root, 'wrangler.jsonc'))).toEqual({
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: 'app.example.com', custom_domain: true }],
    });
  });

  it('restores the exact local and remote config on trigger failure', async () => {
    const root = project(
      '{"name":"my-worker","account_id":"account-1","routes":[{"pattern":"existing.example.com","custom_domain":true}]}',
    );
    const before = readFileSync(join(root, 'wrangler.jsonc'), 'utf-8');
    const runner = vi
      .fn<CloudflareOperationRunner>()
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'not accepted' })
      .mockReturnValueOnce(ok());
    await expect(changeCloudflareDomain(root, 'app.example.com', 'add', runner)).rejects.toThrow(
      'local config and remote triggers were restored',
    );
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')).toBe(before);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('reports uncertain remote route state when automatic restore also fails', async () => {
    const root = project(
      '{"name":"my-worker","account_id":"account-1","routes":[{"pattern":"existing.example.com","custom_domain":true}]}',
    );
    const before = readFileSync(join(root, 'wrangler.jsonc'), 'utf-8');
    const runner = vi.fn<CloudflareOperationRunner>().mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'not accepted',
    });

    await expect(changeCloudflareDomain(root, 'app.example.com', 'add', runner)).rejects.toThrow(
      'remote route state may be partially applied',
    );
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')).toBe(before);
  });

  it('publishes an empty final domain set to the pinned Cloudflare API', async () => {
    const root = project(
      '{"name":"my-worker","account_id":"account-1","routes":[{"pattern":"app.example.com","custom_domain":true}]}',
    );
    vi.stubEnv('CLOUDFLARE_API_TOKEN', '');
    vi.stubEnv('CF_API_TOKEN', '');
    const runner = vi
      .fn<CloudflareOperationRunner>()
      .mockResolvedValue({ status: 0, stdout: '', stderr: '' });
    await expect(
      changeCloudflareDomain(root, 'app.example.com', 'delete', runner),
    ).resolves.toMatchObject({ modified: true, domains: [] });
    expect(readWranglerCustomDomains(root).domains).toEqual([]);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(
      {
        type: 'triggers.clear-domains',
        configPath: join(root, 'wrangler.jsonc').replaceAll('\\', '/'),
        workerName: 'my-worker',
      },
      expect.objectContaining({ capture: true }),
    );
  });

  it('restores the final domain when the authenticated clear operation is rejected', async () => {
    const root = project(
      '{"name":"my-worker","account_id":"account-1","routes":[{"pattern":"app.example.com","custom_domain":true}]}',
    );
    const before = readFileSync(join(root, 'wrangler.jsonc'), 'utf-8');
    const runner = vi
      .fn<CloudflareOperationRunner>()
      .mockResolvedValueOnce({
        status: 1,
        stdout: '',
        stderr: 'Cloudflare authentication is required.',
      })
      .mockResolvedValue({ status: 0, stdout: '', stderr: '' });
    vi.stubEnv('CLOUDFLARE_API_TOKEN', '');
    vi.stubEnv('CF_API_TOKEN', '');

    await expect(changeCloudflareDomain(root, 'app.example.com', 'delete', runner)).rejects.toThrow(
      'both the local config and remote triggers were restored',
    );

    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')).toBe(before);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[0]?.[0].type).toEqual('triggers.clear-domains');
    expect(runner.mock.calls[1]?.[0].type).toEqual('triggers.deploy');
  });

  it('lists configured domains without an account mutation', () => {
    const root = project(
      '{"name":"my-worker","account_id":"account-1","routes":[{"pattern":"app.example.com","custom_domain":true}]}',
    );
    expect(listCloudflareDomains(root)).toEqual([
      { pattern: 'app.example.com', customDomain: true },
    ]);
  });
});
