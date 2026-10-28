import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseJsoncRaw } from 'jsonc-parser';
import { toSlash } from 'pathslash';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { CloudflareOperation } from '../../../deploy-cloudflare/src/operations.ts';
import { encodeCloudflareOperation } from '../../src/cli/cloudflare-process.ts';
import {
  assertNoTransportRedirectInProjectDotenv,
  checkCloudflareProvisionDrift,
  enableD1ReadReplicationViaApi,
  normalizeRunWranglerResult,
  provisionCloudflareResources as provisionCloudflareResourcesImpl,
  provisionEnv,
  resolvePinnedApiBaseUrl,
  WranglerQuarantineError,
  type DesiredResourceSet,
  type RunWrangler,
} from '../../src/cli/provision.ts';
import { materializeCloudflareConfig } from '../../src/cloudflare-config.ts';
import {
  AMBIENT_ACCOUNT,
  emptyDesired,
  fail,
  hex32,
  isCall,
  makeRunner,
  ok,
  provisionCloudflareResources,
  provisionOperationFixture,
  silentLog,
  stubEmptyHyperdriveList,
  useProvisionTestDir,
  uuid,
} from './provision-fixtures.ts';

const { tmpDir, wranglerPath, setup, readConfig, simulateUpdateConfig } =
  useProvisionTestDir('resources');

describe('D1 read-replication API', () => {
  it('uses the pinned account and endpoint with an authenticated update', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    await enableD1ReadReplicationViaApi(
      {
        accountId: 'account-one',
        apiBaseUrl: 'https://api.example.test/client/v4',
        databaseId: uuid('db1'),
      },
      'token-one',
      async (url, init) => {
        requests.push({ url: String(url), init: init! });
        return Response.json({ success: true });
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      `https://api.example.test/client/v4/accounts/account-one/d1/database/${uuid('db1')}`,
    );
    expect(requests[0].init.method).toBe('PUT');
    expect(requests[0].init.headers).toEqual({
      Authorization: 'Bearer token-one',
      'Content-Type': 'application/json',
    });
    expect(requests[0].init.body).toBe(JSON.stringify({ read_replication: { mode: 'auto' } }));
  });

  it('fails closed when Cloudflare rejects the replication update', async () => {
    const update = enableD1ReadReplicationViaApi(
      {
        accountId: 'account-one',
        apiBaseUrl: 'https://api.example.test/client/v4',
        databaseId: uuid('db1'),
      },
      'secret-token',
      async () => Response.json({ success: false }, { status: 403 }),
    );

    await expect(update).rejects.toThrow(/D1 Edit permission/);
  });
});

describe('provisionCloudflareResources — typed operations', () => {
  it('sends a Hyperdrive connection only through stdin while literal public targets stay structured', async () => {
    setup('{}');
    const connection = 'postgres://user:synthetic-password@host/database';
    const operations: Array<CloudflareOperation> = [];
    const inputs: Array<string | undefined> = [];
    const run: RunWrangler = (operation, options) => {
      operations.push(operation);
      inputs.push(options.input);
      simulateUpdateConfig('hyperdrive', { binding: 'HYPERDRIVE', id: hex32('typed') });
      return ok();
    };
    await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { name: 'typed-hd', binding: 'HYPERDRIVE', connectionString: connection },
      },
      { runWrangler: run, listHyperdriveConfigs: async () => [], log: silentLog },
    );
    expect(operations).toEqual([
      {
        type: 'hyperdrive.create',
        name: 'typed-hd',
        binding: 'HYPERDRIVE',
        configPath: wranglerPath,
      },
    ]);
    expect(inputs).toEqual([connection]);
    expect(JSON.stringify(operations)).not.toContain('synthetic-password');
    const encoded = encodeCloudflareOperation(operations[0]!);
    expect(encoded).toHaveLength(1);
    expect(encoded.join(' ')).not.toContain('synthetic-password');
    expect(JSON.parse(encoded[0]!)).toEqual(operations[0]);
  });

  it('adopts structured Queue identity despite misleading human prose', async () => {
    setup('{}');
    const operations: Array<CloudflareOperation> = [];
    const run: RunWrangler = (operation) => {
      operations.push(operation);
      return {
        status: 0,
        stdout: 'Queue "typed-jobs" does not exist.',
        stderr: '',
        data: { name: 'typed-jobs' },
      };
    };
    await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, queues: ['typed-jobs'] },
      { runWrangler: run, log: silentLog },
    );
    expect(operations).toEqual([
      { type: 'queues.info', name: 'typed-jobs', configPath: wranglerPath },
    ]);
  });

  it('creates a Queue from a structured not-found result and verifies the new identity', async () => {
    setup('{}');
    const operations: Array<CloudflareOperation> = [];
    let created = false;
    const run: RunWrangler = (operation) => {
      operations.push(operation);
      if (operation.type === 'queues.create') {
        created = true;
        return ok();
      }
      return created
        ? { ...ok(), data: { name: 'typed-jobs' } }
        : { status: 1, stdout: '', stderr: 'Provider presentation changed.', failure: 'not-found' };
    };
    await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, queues: ['typed-jobs'] },
      { runWrangler: run, log: silentLog },
    );
    expect(operations.map((operation) => operation.type)).toEqual([
      'queues.info',
      'queues.create',
      'queues.info',
    ]);
  });

  it('rejects signal provenance even when structured D1 data looks valid', async () => {
    setup('{}');
    const run: RunWrangler = () => ({
      status: 0,
      stdout: '',
      stderr: '',
      data: [],
      signal: 'SIGTERM',
    });
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { name: 'typed-db', binding: 'DB' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/SIGTERM|failed|invalid/);
  });
});

describe('provisionCloudflareResources — read-first', () => {
  it('enables D1 replication for a reused database before continuing the deploy', async () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: uuid('db1') }],
      }),
    );
    const enabled: Array<unknown> = [];
    const { run } = makeRunner([]);

    await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      {
        runWrangler: run,
        log: silentLog,
        enableD1ReadReplication: async (context: unknown) => {
          enabled.push(context);
        },
      },
    );

    expect(enabled).toEqual([
      {
        databaseId: uuid('db1'),
        accountId: AMBIENT_ACCOUNT,
        apiBaseUrl: 'https://api.cloudflare.com/client/v4',
      },
    ]);
  });

  it('does not skip replication when the Wrangler runner is injected', async () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: uuid('db1') }],
      }),
    );
    const requests: Array<string> = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      requests.push(String(input));
      return Response.json({ success: true });
    });
    const { run } = makeRunner([]);
    await provisionCloudflareResourcesImpl(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, apiToken: 'test-token', log: silentLog },
    );
    expect(requests).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${AMBIENT_ACCOUNT}/d1/database/${uuid('db1')}`,
    ]);
  });

  it('points to the Void Cloudflare login when replication has no bearer', async () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: uuid('db1') }],
      }),
    );
    vi.stubEnv('CLOUDFLARE_API_TOKEN', undefined);
    const { run } = makeRunner([{ match: /^auth token/, reply: () => fail('', 'Not logged in') }]);
    const error = await provisionCloudflareResourcesImpl(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    ).catch((e: unknown) => e as Error);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Run `void cloudflare login`');
    expect((error as Error).message).not.toContain('wrangler login');
  });

  it('does NOT treat a placeholder database_id ("local") as real — proceeds to provision', async () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'default', database_id: 'local' }],
      }),
    );
    const { run, calls } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[]') },
      {
        match: /^d1 create /,
        reply: () => {
          simulateUpdateConfig('d1_databases', {
            binding: 'DB',
            database_name: 'myapp-db',
            database_id: uuid('created'),
          });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls[0]).toEqual(['d1', 'list', '--json', '-c', wranglerPath, '--env=']);
    expect(result.resources[0].action).toBe('created');
  });
});

describe('provisionCloudflareResources — config discovery (fail closed, single file)', () => {
  it('reads a BOM-prefixed config correctly — ids found, no re-provision', async () => {
    setup(
      '﻿' +
        JSON.stringify({
          d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: uuid('db1') }],
        }),
    );
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    // A BOM must NOT defeat read-first (a fail-open-to-{} parse would re-provision).
    expect(calls.some((c) => c[0] === 'd1')).toBe(false);
    expect(result.resources[0]).toMatchObject({ kind: 'd1', action: 'reused', id: uuid('db1') });
    // BOM survives the writer's migrations_dir fill.
    expect(readFileSync(wranglerPath, 'utf-8').charCodeAt(0)).toBe(0xfeff);
  });

  it('fails closed on a malformed root config — throws, no wrangler calls, no write', async () => {
    const malformed = '{ "name": "x" "d1_databases": [] }'; // missing comma
    setup(malformed);
    const { run, calls } = makeRunner([{ match: /.*/, reply: () => ok() }]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/not valid JSON/);
    expect(calls).toEqual([]);
    expect(readFileSync(wranglerPath, 'utf-8')).toBe(malformed);
  });

  it('reads and writes the SAME single resolved file when both wrangler.json and wrangler.jsonc exist', async () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    const jsoncPath = join(tmpDir, 'wrangler.jsonc');
    const jsonPath = join(tmpDir, 'wrangler.json');
    // The caller pins wrangler.json; the writer must not rediscover .jsonc.
    writeFileSync(jsonPath, JSON.stringify({ kv_namespaces: [{ binding: 'KV', id: 'local' }] }));
    writeFileSync(jsoncPath, JSON.stringify({ kv_namespaces: [{ binding: 'KV', id: 'local' }] }));
    const { run } = makeRunner([
      {
        match: /^kv namespace list/,
        reply: () => ok(JSON.stringify([{ id: hex32('kv'), title: 'myapp-kv' }])),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      jsonPath,
      { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
      { runWrangler: run, log: silentLog },
    );
    expect(result.configPath).toBe(toSlash(jsonPath));
    // The adopted id landed in the passed file (wrangler.json) — NOT split into .jsonc.
    const jsonAfter = parseJsoncRaw(readFileSync(jsonPath, 'utf-8')) as Record<string, unknown>;
    expect((jsonAfter.kv_namespaces as Array<Record<string, unknown>>)[0].id).toBe(hex32('kv'));
    // wrangler.jsonc is untouched (still the placeholder).
    const jsoncAfter = parseJsoncRaw(readFileSync(jsoncPath, 'utf-8')) as Record<string, unknown>;
    expect((jsoncAfter.kv_namespaces as Array<Record<string, unknown>>)[0].id).toBe('local');
  });
});

describe('provisionCloudflareResources — D1', () => {
  it('creates a missing D1 with --update-config then writes migrations_dir', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[]') },
      {
        match: /^d1 create /,
        reply: () => {
          simulateUpdateConfig('d1_databases', {
            binding: 'DB',
            database_name: 'myapp-db',
            database_id: uuid('created'),
          });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([
      ['d1', 'list', '--json', '-c', wranglerPath, '--env='],
      [
        'd1',
        'create',
        'myapp-db',
        '--binding',
        'DB',
        '--update-config',
        '-c',
        wranglerPath,
        '--env=',
      ],
    ]);
    const d1 = readConfig().d1_databases as Array<Record<string, unknown>>;
    expect(d1).toEqual([
      {
        binding: 'DB',
        database_name: 'myapp-db',
        database_id: uuid('created'),
        migrations_dir: './db/migrations',
      },
    ]);
    expect(result.resources).toEqual([
      { kind: 'd1', binding: 'DB', name: 'myapp-db', action: 'created' },
    ]);
  });

  it('repairs a missing migrations_dir on the read-first reused path (retry convergence, no duplicate D1)', async () => {
    // Simulates a prior run that created the D1 (real id written) then crashed
    // before migrations_dir. The retry takes read-first → reused and must still
    // fill migrations_dir — without re-creating (no duplicate D1).
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: uuid('db1') }],
      }),
    );
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([]); // read-first — no create, no list
    const d1 = readConfig().d1_databases as Array<Record<string, unknown>>;
    expect(d1).toHaveLength(1); // no duplicate D1 minted
    expect(d1[0]).toEqual({
      binding: 'DB',
      database_name: 'myapp-db',
      database_id: uuid('db1'),
      migrations_dir: './db/migrations',
    });
    expect(result.resources).toEqual([
      { kind: 'd1', binding: 'DB', name: 'myapp-db', action: 'reused', id: uuid('db1') },
    ]);
  });

  it('adopts an existing D1 found in the account (list hit) — no create, writes id + migrations_dir', async () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'default', database_id: 'local' }],
      }),
    );
    const { run, calls } = makeRunner([
      {
        match: /^d1 list --json/,
        reply: () => ok(JSON.stringify([{ uuid: uuid('existing'), name: 'myapp-db' }])),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([['d1', 'list', '--json', '-c', wranglerPath, '--env=']]);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
    const d1 = readConfig().d1_databases as Array<Record<string, unknown>>;
    expect(d1).toEqual([
      {
        binding: 'DB',
        database_name: 'myapp-db',
        database_id: uuid('existing'),
        migrations_dir: './db/migrations',
      },
    ]);
    expect(result.resources).toEqual([
      { kind: 'd1', binding: 'DB', name: 'myapp-db', action: 'adopted', id: uuid('existing') },
    ]);
  });

  it('treats a create-time 7502 (already exists) as adopt — captures the id via d1 info', async () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'default', database_id: 'local' }],
      }),
    );
    const { run, calls } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[]') },
      {
        match: /^d1 create /,
        reply: () => fail('', 'X [ERROR] A database with that name already exists [code: 7502]'),
      },
      {
        match: /^d1 info myapp-db --json/,
        reply: () => ok(JSON.stringify({ uuid: uuid('raced'), name: 'myapp-db' })),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([
      ['d1', 'list', '--json', '-c', wranglerPath, '--env='],
      [
        'd1',
        'create',
        'myapp-db',
        '--binding',
        'DB',
        '--update-config',
        '-c',
        wranglerPath,
        '--env=',
      ],
      ['d1', 'info', 'myapp-db', '--json', '-c', wranglerPath, '--env='],
    ]);
    const d1 = readConfig().d1_databases as Array<Record<string, unknown>>;
    expect(d1[0]).toMatchObject({ binding: 'DB', database_id: uuid('raced') });
    expect(result.resources[0]).toEqual({
      kind: 'd1',
      binding: 'DB',
      name: 'myapp-db',
      action: 'adopted',
      id: uuid('raced'),
    });
  });

  it('throws on a non-7502 create failure', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[]') },
      {
        match: /^d1 create /,
        reply: () => fail('', 'X [ERROR] Authentication error [code: 10000]'),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/d1 create myapp-db.*failed/s);
  });
});

describe('provisionCloudflareResources — D1 discovery gate + strict validation', () => {
  const d1Desired: DesiredResourceSet = {
    ...emptyDesired,
    d1: { binding: 'DB', name: 'myapp-db' },
  };

  it('fails closed (no create) when `d1 list` exits non-zero', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^d1 list --json/,
        reply: () => fail('', 'X [ERROR] Authentication error [code: 10000]'),
      },
    ]);
    await expect(
      provisionCloudflareResources(tmpDir, wranglerPath, d1Desired, {
        runWrangler: run,
        log: silentLog,
      }),
    ).rejects.toThrow(/d1 list.*failed/s);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
    expect(readConfig().d1_databases).toBeUndefined();
  });

  it('fails closed (no create) when `d1 list` returns truncated JSON (status 0)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[{ "uuid": "a", "name": "myapp-db"') },
    ]);
    await expect(
      provisionCloudflareResources(tmpDir, wranglerPath, d1Desired, {
        runWrangler: run,
        log: silentLog,
      }),
    ).rejects.toThrow(/did not return a JSON array/);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
  });

  it('fails closed (no create) when a `d1 list` member is malformed — even when it IS the target name', async () => {
    // The target-named member carries NO id → it must NOT be filtered to a false
    // "absent" that mints a duplicate D1.
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok(JSON.stringify([{ name: 'myapp-db' }])) },
    ]);
    await expect(
      provisionCloudflareResources(tmpDir, wranglerPath, d1Desired, {
        runWrangler: run,
        log: silentLog,
      }),
    ).rejects.toThrow(/D1 database named "myapp-db" with no valid id/);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
  });

  it('fails closed (no adopt/write) when the collision `d1 info` exits non-zero', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[]') },
      { match: /^d1 create /, reply: () => fail('', 'X [ERROR] already exists [code: 7502]') },
      {
        match: /^d1 info myapp-db --json/,
        reply: () => fail('', 'X [ERROR] Authentication error [code: 10000]'),
      },
    ]);
    await expect(
      provisionCloudflareResources(tmpDir, wranglerPath, d1Desired, {
        runWrangler: run,
        log: silentLog,
      }),
    ).rejects.toThrow(/d1 info myapp-db.*failed/s);
    // The 7502 create wrote nothing, and the failed info produced no adopt/write.
    expect(readConfig().d1_databases).toBeUndefined();
  });
});

describe('provisionCloudflareResources — KV', () => {
  it('retains a created namespace when typed config is materialized again', async () => {
    setup('{}');
    rmSync(wranglerPath);
    writeFileSync(
      join(tmpDir, 'void.config.ts'),
      `export default { cloudflare: { name: 'app', account_id: '${AMBIENT_ACCOUNT}' } };\n`,
    );
    const generatedPath = materializeCloudflareConfig(tmpDir);
    const namespaceId = hex32('newkv');
    const { run } = makeRunner([
      { match: /^kv namespace list/, reply: () => ok('[]') },
      {
        match: /^kv namespace create /,
        reply: () => {
          simulateUpdateConfig('kv_namespaces', { binding: 'KV', id: namespaceId }, generatedPath);
          return ok();
        },
      },
    ]);

    await provisionCloudflareResources(
      tmpDir,
      generatedPath,
      { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'app-kv' }] },
      { runWrangler: run, log: silentLog },
    );

    const lock = JSON.parse(readFileSync(join(tmpDir, 'void.lock.json'), 'utf8')) as {
      resolved: { kv_namespaces: Array<{ binding: string; id: string }> };
    };
    expect(lock.resolved.kv_namespaces).toEqual([{ binding: 'KV', id: namespaceId }]);
    materializeCloudflareConfig(tmpDir);
    const generated = parseJsoncRaw(readFileSync(generatedPath, 'utf8')) as Record<string, unknown>;
    expect(generated.kv_namespaces).toEqual([{ binding: 'KV', id: namespaceId }]);
  });

  it('adopts when the namespace list shows a title match (writes id, no create)', async () => {
    setup(JSON.stringify({ kv_namespaces: [{ binding: 'KV', id: 'local' }] }));
    const { run, calls } = makeRunner([
      {
        match: /^kv namespace list/,
        reply: () => ok(JSON.stringify([{ id: hex32('kv'), title: 'myapp-kv' }])),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([['kv', 'namespace', 'list', '-c', wranglerPath, '--env=']]);
    const kv = readConfig().kv_namespaces as Array<Record<string, unknown>>;
    expect(kv).toEqual([{ binding: 'KV', id: hex32('kv') }]);
    expect(result.resources).toEqual([
      { kind: 'kv', binding: 'KV', name: 'myapp-kv', action: 'adopted', id: hex32('kv') },
    ]);
  });

  it('creates when the namespace list is empty', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^kv namespace list/, reply: () => ok('[]') },
      {
        match: /^kv namespace create /,
        reply: () => {
          simulateUpdateConfig('kv_namespaces', { binding: 'ISR_CACHE', id: hex32('newkv') });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, kvNamespaces: [{ binding: 'ISR_CACHE', title: 'myapp-isr' }] },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([
      ['kv', 'namespace', 'list', '-c', wranglerPath, '--env='],
      [
        'kv',
        'namespace',
        'create',
        'myapp-isr',
        '--binding',
        'ISR_CACHE',
        '--update-config',
        '-c',
        wranglerPath,
        '--env=',
      ],
    ]);
    expect(result.resources).toEqual([
      { kind: 'kv', binding: 'ISR_CACHE', name: 'myapp-isr', action: 'created' },
    ]);
  });

  it('fails closed (no create) when `kv namespace list` exits non-zero', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^kv namespace list/,
        reply: () => fail('', 'X [ERROR] Authentication error [code: 10000]'),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/kv namespace list.*failed/s);
    expect(calls.some((c) => isCall(c, 'kv', 'namespace', 'create'))).toBe(false);
  });

  it('fails closed (no create) when `kv namespace list` returns non-JSON output', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^kv namespace list/, reply: () => ok('not a json list at all') },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/did not return a JSON array/);
    expect(calls.some((c) => isCall(c, 'kv', 'namespace', 'create'))).toBe(false);
  });

  it('picks the lexicographically-smallest id and warns on multiple title matches', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const warnings: Array<string> = [];
    const { run } = makeRunner([
      {
        match: /^kv namespace list/,
        reply: () =>
          ok(
            JSON.stringify([
              { id: hex32('zzz'), title: 'myapp-kv' },
              { id: hex32('aaa'), title: 'myapp-kv' },
              { id: hex32('mmm'), title: 'other' },
            ]),
          ),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
      { runWrangler: run, log: { info: () => {}, warn: (m) => warnings.push(m) } },
    );
    // hex32 is order-preserving on equal-length seeds, so hex32('aaa') < hex32('zzz').
    expect(result.resources[0]).toMatchObject({ action: 'adopted', id: hex32('aaa') });
    expect((readConfig().kv_namespaces as Array<Record<string, unknown>>)[0].id).toBe(hex32('aaa'));
    expect(
      warnings.some((w) => w.includes('multiple KV namespaces') && w.includes(hex32('aaa'))),
    ).toBe(true);
  });

  it('provisions each KV binding independently (ISR_CACHE + app KV)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^kv namespace list/, reply: () => ok('[]') },
      {
        match: /^kv namespace create /,
        reply: (sub) => {
          const binding = sub.includes('ISR_CACHE') ? 'ISR_CACHE' : 'KV';
          simulateUpdateConfig('kv_namespaces', { binding, id: hex32(binding) });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        kvNamespaces: [
          { binding: 'KV', title: 'myapp-kv' },
          { binding: 'ISR_CACHE', title: 'myapp-isr' },
        ],
      },
      { runWrangler: run, log: silentLog },
    );
    expect(result.resources.map((r) => r.action)).toEqual(['created', 'created']);
    const kv = readConfig().kv_namespaces as Array<Record<string, unknown>>;
    expect(kv.map((e) => e.binding).sort()).toEqual(['ISR_CACHE', 'KV']);
    expect(calls.filter((c) => isCall(c, 'kv', 'namespace', 'create'))).toHaveLength(2);
  });
});

describe('provisionCloudflareResources — account_id', () => {
  it('writes top-level account_id via the writer when provided', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run } = makeRunner([]);
    const result = await provisionCloudflareResources(tmpDir, wranglerPath, emptyDesired, {
      runWrangler: run,
      accountId: 'acc-123',
      log: silentLog,
    });
    expect(readConfig().account_id).toBe('acc-123');
    expect(result.accountIdWritten).toBe(true);
  });

  it('does not write account_id when not provided (and none resolvable)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    // No account anywhere; with no remote work the account fence does not fire.
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', undefined);
    const { run } = makeRunner([]);
    const result = await provisionCloudflareResources(tmpDir, wranglerPath, emptyDesired, {
      runWrangler: run,
      log: silentLog,
    });
    expect(readConfig().account_id).toBeUndefined();
    expect(result.accountIdWritten).toBe(false);
  });
});

describe('provisionCloudflareResources — idempotent re-run', () => {
  it('a second run after adoption is a read-first no-op (byte-identical config, no wrangler calls)', async () => {
    setup(JSON.stringify({ kv_namespaces: [{ binding: 'KV', id: 'local' }] }));
    const first = makeRunner([
      {
        match: /^kv namespace list/,
        reply: () => ok(JSON.stringify([{ id: hex32('kv'), title: 'myapp-kv' }])),
      },
    ]);
    const desired: DesiredResourceSet = {
      ...emptyDesired,
      kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }],
    };
    await provisionCloudflareResources(tmpDir, wranglerPath, desired, {
      runWrangler: first.run,
      log: silentLog,
    });
    const afterFirst = readFileSync(wranglerPath, 'utf-8');

    const second = makeRunner([]);
    const result = await provisionCloudflareResources(tmpDir, wranglerPath, desired, {
      runWrangler: second.run,
      log: silentLog,
    });
    expect(second.calls).toEqual([]);
    expect(result.resources).toEqual([
      { kind: 'kv', binding: 'KV', name: 'myapp-kv', action: 'reused', id: hex32('kv') },
    ]);
    expect(readFileSync(wranglerPath, 'utf-8')).toBe(afterFirst);
  });
});

describe('provisionCloudflareResources — R2', () => {
  it('reuses when the bucket_name is already real (no wrangler call)', async () => {
    setup(JSON.stringify({ r2_buckets: [{ binding: 'STORAGE', bucket_name: 'myapp-uploads' }] }));
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([]);
    expect(result.resources).toEqual([
      { kind: 'r2', binding: 'STORAGE', name: 'myapp-uploads', action: 'reused' },
    ]);
  });

  it('adopts an existing bucket via `r2 bucket info` (status 0) — writes the entry, no create', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^r2 bucket info myapp-uploads --json/,
        reply: () => ok(JSON.stringify({ name: 'myapp-uploads', created: 'x' })),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([
      ['r2', 'bucket', 'info', 'myapp-uploads', '--json', '-c', wranglerPath, '--env='],
    ]);
    expect(readConfig().r2_buckets).toEqual([{ binding: 'STORAGE', bucket_name: 'myapp-uploads' }]);
    expect(result.resources).toEqual([
      { kind: 'r2', binding: 'STORAGE', name: 'myapp-uploads', action: 'adopted' },
    ]);
  });

  it('creates the bucket when `r2 bucket info` reports it does not exist', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^r2 bucket info /,
        reply: () => fail('', 'X [ERROR] The specified bucket does not exist [code: 10006]'),
      },
      {
        match: /^r2 bucket create /,
        reply: () => {
          simulateUpdateConfig('r2_buckets', {
            binding: 'STORAGE',
            bucket_name: 'myapp-uploads',
          });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([
      ['r2', 'bucket', 'info', 'myapp-uploads', '--json', '-c', wranglerPath, '--env='],
      [
        'r2',
        'bucket',
        'create',
        'myapp-uploads',
        '--binding',
        'STORAGE',
        '--update-config',
        '-c',
        wranglerPath,
        '--env=',
      ],
    ]);
    expect(result.resources).toEqual([
      { kind: 'r2', binding: 'STORAGE', name: 'myapp-uploads', action: 'created' },
    ]);
  });

  it('does NOT create on an R2 info failure that is not a confirmed not-found (auth/metrics) — surfaces the error', async () => {
    // `r2 bucket info` also runs a metrics query, so an existing bucket can exit
    // non-zero on an auth or metrics failure.
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^r2 bucket info /,
        reply: () => fail('', 'X [ERROR] Authentication error [code: 10000]'),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/r2 bucket info myapp-uploads.*(failed|refusing)/s);
    // No create attempted (the existing bucket must not be duplicated/errored on).
    expect(calls).toEqual([
      ['r2', 'bucket', 'info', 'myapp-uploads', '--json', '-c', wranglerPath, '--env='],
    ]);
  });
});

describe('provisionCloudflareResources — Hyperdrive', () => {
  it('adopts an existing Hyperdrive config found by name — writes id via the writer, no create', async () => {
    setup(JSON.stringify({ hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }] }));
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
      },
      {
        runWrangler: run,
        log: silentLog,
        listHyperdriveConfigs: async () => [
          { id: hex32('other-hd'), name: 'someone-else' },
          { id: hex32('existing'), name: 'myapp-hd' },
        ],
      },
    );
    // No wrangler create — existence via the injected REST seam, id via the writer.
    expect(calls.some((c) => isCall(c, 'hyperdrive', 'create'))).toBe(false);
    const hd = readConfig().hyperdrive as Array<Record<string, unknown>>;
    expect(hd).toEqual([{ binding: 'HYPERDRIVE', id: hex32('existing') }]);
    expect(result.resources).toEqual([
      {
        kind: 'hyperdrive',
        binding: 'HYPERDRIVE',
        name: 'myapp-hd',
        action: 'adopted',
        id: hex32('existing'),
      },
    ]);
  });

  it('creates the config when confirmed absent and a connection string is present', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^hyperdrive create /,
        reply: () => {
          simulateUpdateConfig('hyperdrive', { binding: 'HYPERDRIVE', id: hex32('newhd') });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: {
          binding: 'HYPERDRIVE',
          name: 'myapp-hd',
          connectionString: 'postgres://u:p@h/db',
        },
      },
      { runWrangler: run, log: silentLog, listHyperdriveConfigs: async () => [] },
    );
    expect(calls).toEqual([
      [
        'hyperdrive',
        'create',
        'myapp-hd',
        '--binding',
        'HYPERDRIVE',
        '--update-config',
        '-c',
        wranglerPath,
        '--env=',
      ],
    ]);
    expect(result.resources).toEqual([
      { kind: 'hyperdrive', binding: 'HYPERDRIVE', name: 'myapp-hd', action: 'created' },
    ]);
  });

  it('fails closed when existence is ambiguous (check throws) and a connection string is present — no create', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: {
            binding: 'HYPERDRIVE',
            name: 'myapp-hd',
            connectionString: 'postgres://u:p@h/db',
          },
        },
        {
          runWrangler: run,
          log: silentLog,
          listHyperdriveConfigs: async () => {
            throw new Error('network down');
          },
        },
      ),
    ).rejects.toThrow(/could not check whether Hyperdrive config "myapp-hd" already exists/);
    expect(calls.some((c) => isCall(c, 'hyperdrive', 'create'))).toBe(false);
  });

  it('still skips (structured, never creates) when a lister can look but finds nothing', async () => {
    // A lister IS available, so this run COULD have adopted a same-named config; it
    // just did not find one. Nothing can be minted without a connection string, so the
    // structured skip — not a throw — remains the right report for that outcome.
    setup(JSON.stringify({ name: 'app' }));
    const warnings: Array<string> = [];
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
      },
      {
        accountId: 'acct',
        runWrangler: run,
        listHyperdriveConfigs: async () => [],
        log: { info: () => {}, warn: (m) => warnings.push(m) },
      },
    );
    expect(calls).toEqual([]);
    expect(result.resources).toEqual([
      {
        kind: 'hyperdrive',
        binding: 'HYPERDRIVE',
        name: 'myapp-hd',
        action: 'skipped',
        reason: 'no connection string provided',
      },
    ]);
    expect(warnings.some((w) => w.includes('skipping Hyperdrive'))).toBe(true);
  });

  it('adopts a same-named config with NO connection string (adoption never needs one)', async () => {
    // Guards the stringless fail-closed fence from over-reaching: a run with no
    // connection string whose lister DOES find a match must still adopt, not throw.
    setup(JSON.stringify({ hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }] }));
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
      },
      {
        accountId: 'acct',
        runWrangler: run,
        listHyperdriveConfigs: async () => [{ id: hex32('adopted'), name: 'myapp-hd' }],
        log: silentLog,
      },
    );
    expect(calls).toEqual([]);
    expect(result.resources).toEqual([
      {
        kind: 'hyperdrive',
        binding: 'HYPERDRIVE',
        name: 'myapp-hd',
        action: 'adopted',
        id: hex32('adopted'),
      },
    ]);
  });
});

// The Hyperdrive existence check uses the Cloudflare API and needs an API token, so a
// missing token must be reported before any other resource is created.
describe('provisionCloudflareResources — Hyperdrive API token requirement', () => {
  beforeEach(() => {
    vi.stubEnv('CLOUDFLARE_API_TOKEN', undefined);
  });

  it('fails with an actionable token error BEFORE any account mutation when the config has no id', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          d1: { binding: 'DB', name: 'myapp-db' },
          hyperdrive: {
            binding: 'HYPERDRIVE',
            name: 'myapp-hd',
            connectionString: 'postgres://u:p@h/db',
          },
        },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
    // Nothing ran: no `d1 create`, no Hyperdrive call — the account is untouched.
    expect(calls).toEqual([]);
    // The config was not touched either (no account_id pin, no new entries).
    expect(readConfig()).toEqual({ name: 'app' });
  });

  it('names the two remedies: export a token, or put an existing Hyperdrive id in the config', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run } = makeRunner([]);
    const error = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: {
          binding: 'HYPERDRIVE',
          name: 'myapp-hd',
          connectionString: 'postgres://u:p@h/db',
        },
      },
      { runWrangler: run, log: silentLog },
    ).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('CLOUDFLARE_API_TOKEN');
    expect(message).toContain('Hyperdrive');
    // Explains WHY a token is needed where a browser login suffices elsewhere.
    expect(message).toMatch(/API token/);
    expect(message).toMatch(/browser login/);
    // Remedy 2: create the config in Cloudflare and add its id to void.config.ts.
    expect(message).toContain('cloudflare.hyperdrive');
    expect(message).not.toContain('wrangler');
    // The connection string is never echoed into the error.
    expect(message).not.toContain('postgres://');
  });

  it('proceeds with NO token when the Hyperdrive id is already in the config (no REST call)', async () => {
    setup(JSON.stringify({ hyperdrive: [{ binding: 'HYPERDRIVE', id: hex32('hd') }] }));
    const { run, calls } = makeRunner([]);
    const fetchUrls: Array<string> = [];
    vi.stubGlobal('fetch', async (url: string | URL) => {
      fetchUrls.push(String(url));
      throw new Error('the read-first path must not reach the network');
    });
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: {
          binding: 'HYPERDRIVE',
          name: 'myapp-hd',
          connectionString: 'postgres://u:p@h/db',
        },
      },
      { runWrangler: run, log: silentLog },
    );
    expect(fetchUrls).toEqual([]);
    expect(calls).toEqual([]);
    expect(result.resources).toEqual([
      {
        kind: 'hyperdrive',
        binding: 'HYPERDRIVE',
        name: 'myapp-hd',
        action: 'reused',
        id: hex32('hd'),
      },
    ]);
  });

  it('runs the existence check unchanged when a token IS resolvable', async () => {
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'ambient-tok');
    setup(JSON.stringify({ account_id: 'config-acct', name: 'app' }));
    const urls = stubEmptyHyperdriveList();
    const { run, calls } = makeRunner([
      {
        match: /^hyperdrive create /,
        reply: () => {
          simulateUpdateConfig('hyperdrive', { binding: 'HYPERDRIVE', id: hex32('newhd') });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: {
          binding: 'HYPERDRIVE',
          name: 'myapp-hd',
          connectionString: 'postgres://u:p@h/db',
        },
      },
      { runWrangler: run, log: silentLog },
    );
    expect(urls[0]).toContain('/accounts/config-acct/hyperdrive/configs');
    expect(calls.some((c) => isCall(c, 'hyperdrive', 'create'))).toBe(true);
    expect(result.resources).toEqual([
      { kind: 'hyperdrive', binding: 'HYPERDRIVE', name: 'myapp-hd', action: 'created' },
    ]);
  });

  it('needs no token when a listHyperdriveConfigs seam is injected', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^hyperdrive create /,
        reply: () => {
          simulateUpdateConfig('hyperdrive', { binding: 'HYPERDRIVE', id: hex32('newhd') });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: {
          binding: 'HYPERDRIVE',
          name: 'myapp-hd',
          connectionString: 'postgres://u:p@h/db',
        },
      },
      { runWrangler: run, log: silentLog, listHyperdriveConfigs: async () => [] },
    );
    expect(calls.some((c) => isCall(c, 'hyperdrive', 'create'))).toBe(true);
    expect(result.resources).toEqual([
      { kind: 'hyperdrive', binding: 'HYPERDRIVE', name: 'myapp-hd', action: 'created' },
    ]);
  });

  it('fails closed on a MISSING connection string when nothing can look the account up', async () => {
    // No connection string AND no token/lister → this run can neither create nor adopt,
    // so its only reachable outcome is the structured `skipped`, which deploy treats as
    // FATAL. Reaching that costs the user a half-provisioned account, so it stops here.
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
        },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/no DATABASE_URL to create it from/);
    // Nothing ran: no wrangler call, so no resource was created before the rejection.
    expect(calls).toEqual([]);
  });

  it('names DATABASE_URL and the manual adopt route, and does not suggest a dotenv file', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run } = makeRunner([]);
    const err = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
      },
      { runWrangler: run, log: silentLog },
    ).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('cloudflare.hyperdrive');
    expect(message).not.toContain('wrangler');
    expect(message).toContain('HYPERDRIVE');
    // The remedy must point at the shell, never at a dotenv file — project-derived env
    // is read only inside the build subprocess, and a shipped .env value would leak.
    expect(message).toMatch(/shell/);
    expect(message).toMatch(/NOT used here/);
  });

  it('fails closed BEFORE the account pin and before any other resource is created', async () => {
    // The whole point of fencing early: a run that also wants KV/R2 must not create
    // them (and must not stamp account_id) only to abort at the Hyperdrive block.
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([{ match: /.*/, reply: () => ok() }]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }],
          r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' },
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
        },
        { runWrangler: run, accountId: 'acct-A', log: silentLog },
      ),
    ).rejects.toThrow(/no DATABASE_URL to create it from/);
    // No create seam was invoked at all — KV and R2 were never touched.
    expect(calls).toEqual([]);
    // …and the account was never pinned, so a retry under a different account is still free.
    expect(readConfig().account_id).toBeUndefined();
  });

  it('a hyperdrive already provisioned with a real id needs neither a string nor a token', async () => {
    // The read-first path is pure config I/O — the stringless fence must not touch it.
    setup(JSON.stringify({ hyperdrive: [{ binding: 'HYPERDRIVE', id: hex32('hd') }] }));
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
      },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([]);
    expect(result.resources).toEqual([
      {
        kind: 'hyperdrive',
        binding: 'HYPERDRIVE',
        name: 'myapp-hd',
        action: 'reused',
        id: hex32('hd'),
      },
    ]);
  });
});

describe('provisionCloudflareResources — Queues (resource only)', () => {
  it('reuses a queue that `queues info` finds (no create, never writes queue config)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^queues info jobs/, reply: () => ok('Queue Name: jobs') },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, queues: ['jobs'] },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([['queues', 'info', 'jobs', '-c', wranglerPath, '--env=']]);
    expect(result.resources).toEqual([{ kind: 'queue', name: 'jobs', action: 'reused' }]);
    // Provisioning writes no queue producer or consumer entries.
    expect(readConfig().queues).toBeUndefined();
  });

  it('creates a queue that `queues info` reports missing; verifies with a follow-up info probe', async () => {
    setup(JSON.stringify({ name: 'app' }));
    // Queues write no config, so a follow-up `queues info` is the only check that the
    // create really happened.
    let created = false;
    const { run, calls } = makeRunner([
      {
        match: /^queues info emails/,
        reply: () =>
          created ? ok('Queue Name: emails') : fail('', 'X [ERROR] Queue "emails" does not exist.'),
      },
      {
        match: /^queues create emails/,
        reply: () => {
          created = true;
          return ok('Created queue emails');
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, queues: ['emails'] },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([
      ['queues', 'info', 'emails', '-c', wranglerPath, '--env='],
      ['queues', 'create', 'emails', '-c', wranglerPath, '--env='],
      ['queues', 'info', 'emails', '-c', wranglerPath, '--env='],
    ]);
    expect(result.resources).toEqual([{ kind: 'queue', name: 'emails', action: 'created' }]);
    expect(readConfig().queues).toBeUndefined();
  });

  it('handles a mix of existing and missing queues', async () => {
    setup(JSON.stringify({ name: 'app' }));
    let created = false;
    const { run, calls } = makeRunner([
      { match: /^queues info jobs/, reply: () => ok('Queue Name: jobs') },
      {
        match: /^queues info emails/,
        reply: () =>
          created ? ok('Queue Name: emails') : fail('', 'Queue "emails" does not exist.'),
      },
      {
        match: /^queues create emails/,
        reply: () => {
          created = true;
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, queues: ['jobs', 'emails'] },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([
      ['queues', 'info', 'jobs', '-c', wranglerPath, '--env='],
      ['queues', 'info', 'emails', '-c', wranglerPath, '--env='],
      ['queues', 'create', 'emails', '-c', wranglerPath, '--env='],
      ['queues', 'info', 'emails', '-c', wranglerPath, '--env='],
    ]);
    expect(result.resources).toEqual([
      { kind: 'queue', name: 'jobs', action: 'reused' },
      { kind: 'queue', name: 'emails', action: 'created' },
    ]);
  });

  it('throws (does NOT create) when `queues info` fails for a non-missing reason', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^queues info jobs/,
        reply: () => fail('', 'X [ERROR] Authentication error [code: 10000]'),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, queues: ['jobs'] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/queues info jobs.*failed/s);
    expect(calls.some((c) => isCall(c, 'queues', 'create'))).toBe(false);
  });

  it('fails closed when a masked-signal `queues create` (wrapper exit 0) did NOT create the queue', async () => {
    // wrangler's bin wrapper maps a signal-killed inner CLI to exit 0. Queues write
    // no config, so the ONLY backstop is the post-create verify probe: a create that
    // reports clean 0 but whose follow-up `queues info` still does not confirm the
    // queue must fail closed (never a false `created`).
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        // Both the initial probe AND the verify probe report the queue absent — the
        // masked-kill create never actually created it.
        match: /^queues info jobs/,
        reply: () => fail('', 'X [ERROR] Queue "jobs" does not exist.'),
      },
      // A signal-killed inner CLI surfaced as a clean exit 0 by the wrapper.
      { match: /^queues create jobs/, reply: () => ok('') },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, queues: ['jobs'] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/did not confirm the queue exists afterward/);
    // The verify probe ran (info, create, info) but the queue was never recorded.
    expect(calls).toEqual([
      ['queues', 'info', 'jobs', '-c', wranglerPath, '--env='],
      ['queues', 'create', 'jobs', '-c', wranglerPath, '--env='],
      ['queues', 'info', 'jobs', '-c', wranglerPath, '--env='],
    ]);
  });
});

describe('provisionCloudflareResources — account reconciliation + config pin', () => {
  it('fails closed BEFORE any wrangler/REST call when config account_id differs from opts.accountId', async () => {
    setup(JSON.stringify({ account_id: 'config-acct', name: 'app' }));
    let restCalled = false;
    const { run, calls } = makeRunner([{ match: /.*/, reply: () => ok() }]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        {
          runWrangler: run,
          accountId: 'requested-acct',
          log: silentLog,
          listHyperdriveConfigs: async () => {
            restCalled = true;
            return [];
          },
        },
      ),
    ).rejects.toThrow(/account mismatch.*config-acct.*requested-acct/s);
    // No wrangler call and no REST call happened before the fail-closed throw.
    expect(calls).toEqual([]);
    expect(restCalled).toBe(false);
  });

  it.each([
    { source: 'opts.accountId', ambient: AMBIENT_ACCOUNT, accountId: 'acct-A', pinned: 'acct-A' },
    {
      source: 'the ambient CLOUDFLARE_ACCOUNT_ID',
      ambient: 'ambient-A',
      accountId: undefined,
      pinned: 'ambient-A',
    },
  ])(
    'persists the account from $source before any remote op so a later different-account retry fails closed',
    async ({ ambient, accountId, pinned }) => {
      vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', ambient);
      setup(JSON.stringify({ name: 'app' }));
      // Run 1: D1 create writes a real id, then a later op fails.
      const run1 = makeRunner([
        { match: /^d1 list --json/, reply: () => ok('[]') },
        {
          match: /^d1 create /,
          reply: () => {
            simulateUpdateConfig('d1_databases', {
              binding: 'DB',
              database_name: 'myapp-db',
              database_id: uuid('createdA'),
            });
            return ok();
          },
        },
        {
          match: /^queues info jobs/,
          reply: () => fail('', 'X [ERROR] Authentication error [code: 10000]'),
        },
      ]);
      await expect(
        provisionCloudflareResources(
          tmpDir,
          wranglerPath,
          { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' }, queues: ['jobs'] },
          { runWrangler: run1.run, accountId, log: silentLog },
        ),
      ).rejects.toThrow(/queues info jobs.*failed/s);
      // The account was pinned before D1, alongside the real D1 id.
      const after1 = readConfig();
      expect(after1.account_id).toBe(pinned);
      expect((after1.d1_databases as Array<Record<string, unknown>>)[0].database_id).toBe(
        uuid('createdA'),
      );

      // Run 2 under account B fails closed with no wrangler or REST call.
      let restCalled = false;
      const run2 = makeRunner([{ match: /.*/, reply: () => ok() }]);
      await expect(
        provisionCloudflareResources(
          tmpDir,
          wranglerPath,
          { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' }, queues: ['jobs'] },
          {
            runWrangler: run2.run,
            accountId: 'acct-B',
            log: silentLog,
            listHyperdriveConfigs: async () => {
              restCalled = true;
              return [];
            },
          },
        ),
      ).rejects.toThrow(new RegExp(`account mismatch.*${pinned}.*acct-B`, 's'));
      expect(run2.calls).toEqual([]);
      expect(restCalled).toBe(false);
      expect(readConfig()).toEqual(after1);
    },
  );

  it('passes -c <configPath> to EVERY wrangler invocation (list, info, create)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    let queueCreated = false;
    const { run, calls } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[]') },
      {
        match: /^d1 create /,
        reply: () => {
          simulateUpdateConfig('d1_databases', {
            binding: 'DB',
            database_name: 'myapp-db',
            database_id: uuid('created'),
          });
          return ok();
        },
      },
      { match: /^kv namespace list/, reply: () => ok('[]') },
      {
        match: /^kv namespace create /,
        reply: () => {
          simulateUpdateConfig('kv_namespaces', { binding: 'KV', id: hex32('newkv') });
          return ok();
        },
      },
      {
        match: /^r2 bucket info /,
        reply: () => fail('', 'The specified bucket does not exist. [code: 10006]'),
      },
      {
        match: /^r2 bucket create /,
        reply: () => {
          simulateUpdateConfig('r2_buckets', { binding: 'STORAGE', bucket_name: 'bucket-b' });
          return ok();
        },
      },
      {
        match: /^queues info /,
        reply: () =>
          queueCreated ? ok('Queue Name: jobs') : fail('', 'Queue "jobs" does not exist.'),
      },
      {
        match: /^queues create /,
        reply: () => {
          queueCreated = true;
          return ok();
        },
      },
    ]);
    await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        d1: { binding: 'DB', name: 'myapp-db' },
        kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }],
        r2: { binding: 'STORAGE', bucketName: 'bucket-b' },
        queues: ['jobs'],
      },
      { runWrangler: run, log: silentLog },
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const argv of calls) {
      const i = argv.indexOf('-c');
      expect(i).toBeGreaterThanOrEqual(0);
      expect(argv[i + 1]).toBe(wranglerPath);
    }
  });

  it('the default Hyperdrive existence REST call targets the effective (config) account id', async () => {
    setup(
      JSON.stringify({
        account_id: 'config-acct',
        hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }],
      }),
    );
    const urls = stubEmptyHyperdriveList();
    const { run } = makeRunner([]);
    await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        // No connection string: only the existence check runs, never a create.
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
      },
      { runWrangler: run, apiToken: 'tok', log: silentLog },
    );
    expect(urls.length).toBeGreaterThan(0);
    expect(urls[0]).toContain('/accounts/config-acct/hyperdrive/configs');
    expect(urls[0]).toMatch(/^https:\/\/api\.cloudflare\.com\/client\/v4\//);
  });
});

describe('provisionCloudflareResources — pinned transport (one base for wrangler + REST)', () => {
  it('resolvePinnedApiBaseUrl mirrors wrangler: default prod, direct override, staging, fedramp', () => {
    expect(resolvePinnedApiBaseUrl({})).toBe('https://api.cloudflare.com/client/v4');
    expect(resolvePinnedApiBaseUrl({ CLOUDFLARE_API_BASE_URL: 'https://api.example/v9' })).toBe(
      'https://api.example/v9',
    );
    // Deprecated alias honored when the primary is absent.
    expect(resolvePinnedApiBaseUrl({ CF_API_BASE_URL: 'https://cf.example/v4' })).toBe(
      'https://cf.example/v4',
    );
    expect(resolvePinnedApiBaseUrl({ WRANGLER_API_ENVIRONMENT: 'staging' })).toBe(
      'https://api.staging.cloudflare.com/client/v4',
    );
    expect(resolvePinnedApiBaseUrl({ CLOUDFLARE_COMPLIANCE_REGION: 'fedramp_high' })).toBe(
      'https://api.fed.cloudflare.com/client/v4',
    );
  });

  it('the default Hyperdrive REST lister honors a pinned CLOUDFLARE_API_BASE_URL (not hardcoded prod)', async () => {
    vi.stubEnv('CLOUDFLARE_API_BASE_URL', 'https://api.staging.cloudflare.com/client/v4');
    setup(
      JSON.stringify({
        account_id: 'config-acct',
        hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }],
      }),
    );
    const urls = stubEmptyHyperdriveList();
    const { run } = makeRunner([]);
    await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
      },
      { runWrangler: run, apiToken: 'tok', log: silentLog },
    );
    expect(urls[0]).toMatch(/^https:\/\/api\.staging\.cloudflare\.com\/client\/v4\//);
    expect(urls[0]).toContain('/accounts/config-acct/hyperdrive/configs');
  });

  it('the lister URL uses the pinned base with wrangler-EXACT concatenation (no trailing-slash trim)', async () => {
    // Wrangler appends the resource path to the base verbatim, so a trailing slash gives
    // `//accounts/`. The lister must request the same URL as the create.
    const pinnedBase = 'https://proxy.example/api/';
    vi.stubEnv('CLOUDFLARE_API_BASE_URL', pinnedBase);
    setup(JSON.stringify({ account_id: 'config-acct', name: 'app' }));
    const urls = stubEmptyHyperdriveList();
    const { run } = makeRunner([]);
    await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
      },
      { runWrangler: run, apiToken: 'tok', log: silentLog },
    );
    expect(urls[0]).toBe(
      `${pinnedBase}/accounts/config-acct/hyperdrive/configs?page=1&per_page=100`,
    );
    expect(urls[0]).toContain('/api//accounts/');
  });

  it('the injected lister receives the pinned apiBaseUrl + a deadline AbortSignal in its transport context', async () => {
    setup(JSON.stringify({ account_id: 'config-acct', name: 'app' }));
    let seen: { accountId: string; apiBaseUrl: string; signal: AbortSignal } | undefined;
    const { run } = makeRunner([]);
    await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
      },
      {
        runWrangler: run,
        log: silentLog,
        listHyperdriveConfigs: async (ctx) => {
          seen = ctx;
          return [];
        },
      },
    );
    expect(seen?.accountId).toBe('config-acct');
    expect(seen?.apiBaseUrl).toBe('https://api.cloudflare.com/client/v4');
    // The lister is handed the overall-deadline signal to thread into every fetch.
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  it('FAILS CLOSED when a project .env sets a transport-redirect var (no wrangler/REST)', async () => {
    setup(JSON.stringify({ account_id: 'config-acct', name: 'app' }));
    // A repo .env that would redirect wrangler's transport on every command.
    writeFileSync(
      join(tmpDir, '.env'),
      'CLOUDFLARE_API_BASE_URL=https://api.staging.cloudflare.com/client/v4\n',
    );
    let listerCalled = false;
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          d1: { binding: 'DB', name: 'myapp-db' },
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
        },
        {
          runWrangler: run,
          log: silentLog,
          listHyperdriveConfigs: async () => {
            listerCalled = true;
            return [];
          },
        },
      ),
    ).rejects.toThrow(/refusing to provision.*\.env.*CLOUDFLARE_API_BASE_URL.*redirect/s);
    // Failed closed BEFORE any remote work.
    expect(calls.length).toBe(0);
    expect(listerCalled).toBe(false);
  });
});

describe('provisionCloudflareResources — Hyperdrive discovery (pagination + fail closed)', () => {
  /** Serve `pages` in order (repeating the last) and record every requested URL. */
  function stubFetch(pages: Array<{ status?: number; body: unknown }>): Array<string> {
    const urls: Array<string> = [];
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const page = pages[Math.min(urls.length, pages.length - 1)];
      urls.push(String(url));
      return new Response(typeof page.body === 'string' ? page.body : JSON.stringify(page.body), {
        status: page.status ?? 200,
      });
    });
    return urls;
  }

  it('follows result_info pagination and adopts a match found on page 2 (no create)', async () => {
    setup(
      JSON.stringify({ account_id: 'acct', hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }] }),
    );
    const urls = stubFetch([
      {
        body: {
          success: true,
          result: [{ id: hex32('p1a'), name: 'other-1' }],
          result_info: { total_count: 2 },
        },
      },
      {
        body: {
          success: true,
          result: [{ id: hex32('p2hd'), name: 'myapp-hd' }],
          result_info: { total_count: 2 },
        },
      },
    ]);
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
      },
      { runWrangler: run, apiToken: 'tok', log: silentLog },
    );
    expect(urls.length).toBe(2);
    expect(calls.some((c) => isCall(c, 'hyperdrive', 'create'))).toBe(false);
    const hd = readConfig().hyperdrive as Array<Record<string, unknown>>;
    expect(hd).toEqual([{ binding: 'HYPERDRIVE', id: hex32('p2hd') }]);
    expect(result.resources[0]).toMatchObject({ action: 'adopted', id: hex32('p2hd') });
  });

  it('fails closed on a non-2xx envelope (never treats it as absence, no create)', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    stubFetch([{ status: 500, body: { success: false } }]);
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
        },
        { runWrangler: run, apiToken: 'tok', log: silentLog },
      ),
    ).rejects.toThrow(/could not check whether Hyperdrive config "myapp-hd" already exists/);
    expect(calls.some((c) => isCall(c, 'hyperdrive', 'create'))).toBe(false);
  });

  it('fails closed on success:false and on a malformed entry (missing id) — no create', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    for (const body of [
      { success: false, result: [] },
      { success: true, result: [{ name: 'myapp-hd' }], result_info: { total_count: 1 } },
    ]) {
      stubFetch([{ body }]);
      const { run, calls } = makeRunner([]);
      await expect(
        provisionCloudflareResources(
          tmpDir,
          wranglerPath,
          {
            ...emptyDesired,
            hyperdrive: {
              binding: 'HYPERDRIVE',
              name: 'myapp-hd',
              connectionString: 'postgres://x',
            },
          },
          { runWrangler: run, apiToken: 'tok', log: silentLog },
        ),
      ).rejects.toThrow(/could not check whether Hyperdrive config "myapp-hd" already exists/);
      expect(calls.some((c) => isCall(c, 'hyperdrive', 'create'))).toBe(false);
    }
  });

  it('fails closed when two configs share the requested name (ambiguous) — no create', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
        },
        {
          runWrangler: run,
          log: silentLog,
          listHyperdriveConfigs: async () => [
            { id: hex32('hd-1'), name: 'myapp-hd' },
            { id: hex32('hd-2'), name: 'myapp-hd' },
          ],
        },
      ),
    ).rejects.toThrow(/cannot adopt Hyperdrive config "myapp-hd".*share that name/s);
    expect(calls.some((c) => isCall(c, 'hyperdrive', 'create'))).toBe(false);
  });

  it('fails closed on malformed pagination (missing/premature-empty/duplicate/inconsistent) — never declares absence, no create', async () => {
    // A same-named config could sit on an unread page, so incomplete listings never
    // count as absence.
    const cases: Array<Array<{ status?: number; body: unknown }>> = [
      // 1. missing result_info.total_count metadata (cannot prove completeness)
      [{ body: { success: true, result: [{ id: 'a', name: 'other' }] } }],
      // 2. premature empty page before all configs are listed
      [
        {
          body: {
            success: true,
            result: [{ id: 'a', name: 'other' }],
            result_info: { total_count: 3 },
          },
        },
        { body: { success: true, result: [], result_info: { total_count: 3 } } },
      ],
      // 3. repeated/duplicate id across pages (padding to satisfy a count)
      [
        {
          body: {
            success: true,
            result: [{ id: 'a', name: 'x' }],
            result_info: { total_count: 2 },
          },
        },
        {
          body: {
            success: true,
            result: [{ id: 'a', name: 'x' }],
            result_info: { total_count: 2 },
          },
        },
      ],
      // 4. inconsistent total_count between pages
      [
        {
          body: {
            success: true,
            result: [{ id: 'a', name: 'x' }],
            result_info: { total_count: 2 },
          },
        },
        {
          body: {
            success: true,
            result: [{ id: 'b', name: 'y' }],
            result_info: { total_count: 5 },
          },
        },
      ],
    ];
    for (const pages of cases) {
      setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
      stubFetch(pages);
      const { run, calls } = makeRunner([]);
      await expect(
        provisionCloudflareResources(
          tmpDir,
          wranglerPath,
          {
            ...emptyDesired,
            hyperdrive: {
              binding: 'HYPERDRIVE',
              name: 'myapp-hd',
              connectionString: 'postgres://x',
            },
          },
          { runWrangler: run, apiToken: 'tok', log: silentLog },
        ),
      ).rejects.toThrow(/could not check whether Hyperdrive config "myapp-hd" already exists/);
      expect(calls.some((c) => isCall(c, 'hyperdrive', 'create'))).toBe(false);
    }
  });
});

describe('provisionCloudflareResources — KV/R2 fail closed on schema-valid ambiguity', () => {
  it('KV: fails closed (no create) when the target title matches but the entry has no id', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^kv namespace list/, reply: () => ok(JSON.stringify([{ title: 'myapp-kv' }])) },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/namespace titled "myapp-kv" with no valid id/);
    expect(calls.some((c) => isCall(c, 'kv', 'namespace', 'create'))).toBe(false);
  });

  it('KV: fails closed (no create) when the list has a malformed member (null) — never filtered away', async () => {
    // Filtering out the malformed member would turn the list into a false "absent".
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^kv namespace list/,
        reply: () => ok(JSON.stringify([null, { id: 'other', title: 'someone-else' }])),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/malformed KV namespace entry/);
    expect(calls.some((c) => isCall(c, 'kv', 'namespace', 'create'))).toBe(false);
  });

  it('R2: does NOT adopt when `r2 bucket info` exits 0 but the payload names a different bucket', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^r2 bucket info /,
        reply: () => ok(JSON.stringify({ name: 'a-different-bucket' })),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/did not identify the requested bucket/);
    // Neither adopted nor created — the config is untouched.
    expect(calls.some((c) => isCall(c, 'r2', 'bucket', 'create'))).toBe(false);
    expect(readConfig().r2_buckets).toBeUndefined();
  });
});

describe('provisionEnv — scrubbed and pinned keys', () => {
  it('provisionEnv scrubs CLOUDFLARE_ENV + the CF Access token pair and pins the account', () => {
    vi.stubEnv('CLOUDFLARE_ENV', 'staging');
    vi.stubEnv('CF_ACCESS_CLIENT_ID', 'id');
    vi.stubEnv('CF_ACCESS_CLIENT_SECRET', 'secret');
    vi.stubEnv('CF_ACCESS_TOKEN', 'short-lived-user-jwt');
    const env = provisionEnv({ accountId: 'acct-X' });
    // CLOUDFLARE_ENV would let wrangler select an env-specific account block.
    expect(env.CLOUDFLARE_ENV).toBeUndefined();
    expect(env.CF_ACCESS_CLIENT_ID).toBeUndefined();
    expect(env.CF_ACCESS_CLIENT_SECRET).toBeUndefined();
    expect(env.CF_ACCESS_TOKEN).toBeUndefined();
    expect(env.CLOUDFLARE_ACCOUNT_ID).toBe('acct-X');
  });

  it('provisionEnv scrubs EVERY transport-redirect var and pins the ONE resolved API base', () => {
    vi.stubEnv('CLOUDFLARE_API_BASE_URL', 'https://evil.example');
    vi.stubEnv('CF_API_BASE_URL', 'https://evil2.example');
    vi.stubEnv('WRANGLER_API_ENVIRONMENT', 'staging');
    vi.stubEnv('CLOUDFLARE_COMPLIANCE_REGION', 'fedramp_high');
    const env = provisionEnv({
      accountId: 'acct-X',
      apiBaseUrl: 'https://api.cloudflare.com/client/v4',
    });
    expect(env.CF_API_BASE_URL).toBeUndefined();
    expect(env.WRANGLER_API_ENVIRONMENT).toBeUndefined();
    expect(env.CLOUDFLARE_COMPLIANCE_REGION).toBeUndefined();
    expect(env.CLOUDFLARE_API_BASE_URL).toBe('https://api.cloudflare.com/client/v4');
  });
});

describe('provisionCloudflareResources — resource-name validation', () => {
  const badNames = ['--help', '--config', '-h'];
  const kinds: Array<{
    label: RegExp;
    desired: (name: string) => DesiredResourceSet;
  }> = [
    {
      // badNames all start with "-", so the universal option-injection guard fires FIRST
      // with "refusing to pass an unsafe <label> name", before the grammar check.
      label: /unsafe D1 database name/,
      desired: (name) => ({ ...emptyDesired, d1: { binding: 'DB', name } }),
    },
    {
      label: /unsafe KV namespace name/,
      desired: (name) => ({ ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: name }] }),
    },
    {
      label: /unsafe R2 bucket name/,
      desired: (name) => ({ ...emptyDesired, r2: { binding: 'STORAGE', bucketName: name } }),
    },
    {
      label: /unsafe Hyperdrive config name/,
      desired: (name) => ({
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name, connectionString: 'postgres://x' },
      }),
    },
    {
      label: /unsafe queue name/,
      desired: (name) => ({ ...emptyDesired, queues: [name] }),
    },
  ];

  it('rejects option-like names for EVERY resource kind before any wrangler call', async () => {
    for (const bad of badNames) {
      for (const kind of kinds) {
        setup(JSON.stringify({ name: 'app' }));
        const { run, calls } = makeRunner([{ match: /.*/, reply: () => ok() }]);
        await expect(
          provisionCloudflareResources(tmpDir, wranglerPath, kind.desired(bad), {
            runWrangler: run,
            log: silentLog,
            listHyperdriveConfigs: async () => [],
          }),
        ).rejects.toThrow(kind.label);
        expect(calls).toEqual([]);
      }
    }
  });
});

describe('provisionCloudflareResources — signal-killed probe never authorizes create', () => {
  it('queues: a SIGTERM-killed probe with buffered "does not exist" text fails closed (no create)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const killed = normalizeRunWranglerResult({
      stdout: '',
      stderr: 'X [ERROR] Queue "jobs" does not exist.',
      status: null,
      signal: 'SIGTERM',
    });
    const { run, calls } = makeRunner([{ match: /^queues info jobs/, reply: () => killed }]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, queues: ['jobs'] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/queues info jobs.*failed/s);
    expect(calls.some((c) => isCall(c, 'queues', 'create'))).toBe(false);
  });

  it('R2: a SIGTERM-killed probe with buffered 10006 text fails closed (no create)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const killed = normalizeRunWranglerResult({
      stdout: '',
      stderr: 'X [ERROR] The bucket is not present [code: 10006]',
      status: null,
      signal: 'SIGTERM',
    });
    const { run, calls } = makeRunner([{ match: /^r2 bucket info /, reply: () => killed }]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/r2 bucket info myapp-uploads.*(failed|refusing)/s);
    expect(calls.some((c) => isCall(c, 'r2', 'bucket', 'create'))).toBe(false);
  });
});

describe('provisionCloudflareResources — create postcondition', () => {
  it('KV: a create that reports success but writes NO id fails closed', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^kv namespace list/, reply: () => ok('[]') },
      // Success exit, but nothing written to config (simulates a killed child the
      // wrapper masked as exit 0, or a silent partial create).
      { match: /^kv namespace create /, reply: () => ok() },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(
      /reported success but .* does not hold the expected KV namespace .*need a real id/s,
    );
    expect(calls.some((c) => isCall(c, 'kv', 'namespace', 'create'))).toBe(true);
    expect(readConfig().kv_namespaces).toBeUndefined();
  });

  it('D1: a create that reports success but writes NO id fails closed', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[]') },
      { match: /^d1 create /, reply: () => ok() },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(
      /reported success but .* does not hold the expected D1 database .*need a real database_id/s,
    );
    expect(readConfig().d1_databases).toBeUndefined();
  });

  it('R2: a create that reports success but writes NO bucket fails closed', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run } = makeRunner([
      {
        match: /^r2 bucket info /,
        reply: () => fail('', 'The specified bucket does not exist. [code: 10006]'),
      },
      { match: /^r2 bucket create /, reply: () => ok() },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(
      /reported success but .* does not hold the expected R2 bucket .*need a real bucket_name/s,
    );
    expect(readConfig().r2_buckets).toBeUndefined();
  });

  it('Hyperdrive: a create that reports success but writes NO id fails closed', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run } = makeRunner([{ match: /^hyperdrive create /, reply: () => ok() }]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
        },
        { runWrangler: run, log: silentLog, listHyperdriveConfigs: async () => [] },
      ),
    ).rejects.toThrow(
      /reported success but .* does not hold the expected Hyperdrive config .*need a real id/s,
    );
    expect(readConfig().hyperdrive).toBeUndefined();
  });
});

describe('provisionCloudflareResources — strict D1 identity', () => {
  it('adopts (not create) a list member with uuid:"" but a valid database_id', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^d1 list --json/,
        // Empty-string uuid must NOT shadow the valid database_id.
        reply: () =>
          ok(JSON.stringify([{ uuid: '', database_id: uuid('realdb'), name: 'myapp-db' }])),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
    const d1 = readConfig().d1_databases as Array<Record<string, unknown>>;
    expect(d1[0].database_id).toBe(uuid('realdb'));
    expect(result.resources[0]).toMatchObject({ action: 'adopted', id: uuid('realdb') });
  });

  it('fails closed when the target-named list member has conflicting non-empty ids (ambiguous)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^d1 list --json/,
        reply: () =>
          ok(JSON.stringify([{ uuid: uuid('id-a'), database_id: uuid('id-b'), name: 'myapp-db' }])),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/no valid id.*agreeing on one id/s);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
  });

  it('rejects a 7502-collision `d1 info` payload with an id but NO name (unverified) — no adopt', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[]') },
      { match: /^d1 create /, reply: () => fail('', 'X [ERROR] already exists [code: 7502]') },
      { match: /^d1 info myapp-db --json/, reply: () => ok(JSON.stringify({ database_id: 'x' })) },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/did not return a database with a matching name/);
    expect(readConfig().d1_databases).toBeUndefined();
  });

  it('rejects a 7502-collision `d1 info` payload whose name MISMATCHES the request — no adopt', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[]') },
      { match: /^d1 create /, reply: () => fail('', 'X [ERROR] already exists [code: 7502]') },
      {
        match: /^d1 info myapp-db --json/,
        reply: () => ok(JSON.stringify({ database_id: 'x', name: 'a-different-db' })),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/did not return a database with a matching name/);
    expect(readConfig().d1_databases).toBeUndefined();
  });
});

describe('provisionCloudflareResources — boundary account fence', () => {
  it('fails closed BEFORE any INJECTED seam call when no account is resolvable', async () => {
    setup(JSON.stringify({ name: 'app' }));
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', undefined);
    let restCalled = false;
    const { run, calls } = makeRunner([{ match: /.*/, reply: () => ok() }]);
    const error = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
      },
      {
        runWrangler: run,
        log: silentLog,
        listHyperdriveConfigs: async () => {
          restCalled = true;
          return [];
        },
      },
    ).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/no Cloudflare account is resolvable/);
    // The remedy names the Void setting, not a Wrangler config file.
    expect(message).toContain('cloudflare.account_id');
    expect(message).not.toContain('wrangler');
    expect(calls).toEqual([]);
    expect(restCalled).toBe(false);
    expect(readConfig().account_id).toBeUndefined();
  });
});

describe('provisionCloudflareResources — absolute config path', () => {
  it('resolves a RELATIVE rootWranglerPath against root (not cwd) so reads + wrangler ops target ONE file', async () => {
    // Node would resolve a relative path against cwd while wrangler resolves `-c` against
    // root, so the provisioner makes it absolute against root up front.
    setup(JSON.stringify({ account_id: 'acct', name: 'app' })); // at tmpDir/wrangler.jsonc
    const relPath = 'wrangler.jsonc'; // relative to root (tmpDir), NOT to process.cwd()
    const abs = join(tmpDir, relPath);
    const { run, calls } = makeRunner([
      {
        match: /^kv namespace list/,
        reply: () => ok(JSON.stringify([{ id: hex32('kv'), title: 'myapp-kv' }])),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir, // root — absolute, and different from process.cwd()
      relPath, // RELATIVE config path
      { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
      { runWrangler: run, log: silentLog },
    );
    // Returned + threaded config path is the absolute resolution against root.
    expect(result.configPath).toBe(toSlash(abs));
    expect(calls.length).toBeGreaterThan(0);
    for (const argv of calls) {
      const i = argv.indexOf('-c');
      expect(i).toBeGreaterThanOrEqual(0);
      expect(argv[i + 1]).toBe(toSlash(abs)); // wrangler `-c` is the SAME absolute file
    }
    // The adopted id landed in root/wrangler.jsonc — the file Node read from too.
    const after = parseJsoncRaw(readFileSync(abs, 'utf-8')) as Record<string, unknown>;
    expect((after.kv_namespaces as Array<Record<string, unknown>>)[0].id).toBe(hex32('kv'));
  });
});

describe('provisionCloudflareResources — one D1 normalizer', () => {
  it('fails closed on CONFLICTING name aliases (name vs database_name) for the requested database', async () => {
    // A member claims the requested name via `name` while its `database_name` disagrees.
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^d1 list --json/,
        reply: () =>
          ok(
            JSON.stringify([
              { name: 'myapp-db', database_name: 'other-db', database_id: uuid('the-id') },
            ]),
          ),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/ambiguous or empty id/);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
    expect(readConfig().d1_databases).toBeUndefined();
  });

  it('fails closed when TWO list entries both match the requested name (ambiguous)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^d1 list --json/,
        reply: () =>
          ok(
            JSON.stringify([
              { name: 'myapp-db', database_id: uuid('id-1') },
              { name: 'myapp-db', database_id: uuid('id-2') },
            ]),
          ),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/2 D1 databases named/);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
  });

  it('adopts the single unambiguous match (agreeing aliases + uuid) — no create', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^d1 list --json/,
        reply: () =>
          ok(
            JSON.stringify([{ name: 'myapp-db', database_name: 'myapp-db', uuid: uuid('theid') }]),
          ),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
    expect(result.resources[0]).toMatchObject({ action: 'adopted', id: uuid('theid') });
    const d1 = readConfig().d1_databases as Array<Record<string, unknown>>;
    expect(d1[0].database_id).toBe(uuid('theid'));
  });
});

describe('provisionCloudflareResources — transport account context', () => {
  it('threads the reconciled account into EVERY wrangler call AND the Hyperdrive lister', async () => {
    // Config pins the account → it is the reconciled effective account (config wins
    // over the ambient CLOUDFLARE_ACCOUNT_ID). Every seam invocation must receive it.
    setup(JSON.stringify({ account_id: 'reconciled-acct' }));
    const seenRunAccounts: Array<string> = [];
    const seenListAccounts: Array<string> = [];
    const run: RunWrangler = provisionOperationFixture((args, opts) => {
      seenRunAccounts.push(opts.accountId);
      const sub = args.join(' ');
      if (/^d1 list --json/.test(sub)) {
        return ok('[]');
      }
      if (/^d1 create /.test(sub)) {
        simulateUpdateConfig('d1_databases', {
          binding: 'DB',
          database_name: 'myapp-db',
          database_id: uuid('dbid'),
        });
        return ok();
      }
      if (/^kv namespace list/.test(sub)) {
        return ok('[]');
      }
      if (/^kv namespace create /.test(sub)) {
        simulateUpdateConfig('kv_namespaces', { binding: 'KV', id: hex32('kvid') });
        return ok();
      }
      return ok();
    });
    await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        d1: { binding: 'DB', name: 'myapp-db' },
        kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }],
        // Empty connection string → only the existence check runs (no create), so the
        // lister IS invoked and records the account it was called with.
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
      },
      {
        runWrangler: run,
        log: silentLog,
        listHyperdriveConfigs: async ({ accountId }) => {
          seenListAccounts.push(accountId);
          return [];
        },
      },
    );
    expect(seenRunAccounts.length).toBeGreaterThan(0);
    for (const acct of seenRunAccounts) {
      expect(acct).toBe('reconciled-acct');
    }
    expect(seenListAccounts).toEqual(['reconciled-acct']);
  });
});

describe('provisionCloudflareResources — boundary duplicate-member guard', () => {
  it('fails closed at entry on a config with duplicate kv_namespaces members — NO wrangler/REST calls', async () => {
    // jsonc-parser.parse() (used by readRootConfig) silently resolves a duplicate to
    // the LAST member, so without the boundary guard a `kv namespace create` could
    // orphan or a reuse be false. The SAME strict detector the writer uses runs at the
    // provisioner boundary — before account persistence, discovery, or any remote work.
    setup(`{
  "account_id": "acct",
  "kv_namespaces": [{ "binding": "KV", "id": "aaa" }],
  "kv_namespaces": [{ "binding": "KV", "id": "bbb" }]
}`);
    let restCalled = false;
    const { run, calls } = makeRunner([{ match: /.*/, reply: () => ok() }]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
        {
          runWrangler: run,
          log: silentLog,
          listHyperdriveConfigs: async () => {
            restCalled = true;
            return [];
          },
        },
      ),
    ).rejects.toThrow(/duplicate key "kv_namespaces"/);
    expect(calls).toEqual([]);
    expect(restCalled).toBe(false);
  });
});

describe('provisionCloudflareResources — Hyperdrive list validation at the caller', () => {
  const hdDesired: DesiredResourceSet = {
    ...emptyDesired,
    hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
  };

  function provisionWithInjectedList(list: Array<unknown>): Promise<unknown> {
    setup(JSON.stringify({ account_id: 'acct' }));
    const { run } = makeRunner([{ match: /.*/, reply: () => ok() }]);
    return provisionCloudflareResources(tmpDir, wranglerPath, hdDesired, {
      runWrangler: run,
      log: silentLog,
      // The injected lister LIES about its return type — the caller-side validator must
      // reject the malformed shape at runtime rather than adopt an empty/garbage id.
      listHyperdriveConfigs: async () => list as never,
    });
  }

  it('fails closed on an injected entry with an EMPTY id — never adopts', async () => {
    await expect(provisionWithInjectedList([{ id: '', name: 'myapp-hd' }])).rejects.toThrow(
      /malformed config entry/,
    );
    expect(readConfig().hyperdrive).toBeUndefined();
  });

  it('fails closed on a non-object member', async () => {
    await expect(provisionWithInjectedList([null])).rejects.toThrow(/malformed config entry/);
    expect(readConfig().hyperdrive).toBeUndefined();
  });

  it('fails closed on a duplicate id across members', async () => {
    await expect(
      provisionWithInjectedList([
        { id: hex32('dup'), name: 'other' },
        { id: hex32('dup'), name: 'myapp-hd' },
      ]),
    ).rejects.toThrow(/duplicate config id/);
    expect(readConfig().hyperdrive).toBeUndefined();
  });

  it('fails closed on a NON-matching member with a malformed id (no create)', async () => {
    // A member for a different config carries a non-hex id, so the list cannot prove absence.
    await expect(
      provisionWithInjectedList([{ id: 'bogus', name: 'someone-else' }]),
    ).rejects.toThrow(/malformed id "bogus".*32-character hex Hyperdrive id/s);
    expect(readConfig().hyperdrive).toBeUndefined();
  });

  // A runtime null/undefined/non-array OUTER result must be treated as UNKNOWN
  // (never coerced to "empty" = confirmed absence), so it fails closed BEFORE any
  // create instead of authorizing a blind `hyperdrive create` on a same-named config.
  for (const [label, bad] of [
    ['null', null],
    ['undefined', undefined],
    ['a non-array object', { configs: [] }],
    ['a string', 'nope'],
  ] as const) {
    it(`fails closed (no create) when the lister returns ${label}`, async () => {
      setup(JSON.stringify({ account_id: 'acct' }));
      const { run, calls } = makeRunner([{ match: /.*/, reply: () => ok() }]);
      await expect(
        provisionCloudflareResources(tmpDir, wranglerPath, hdDesired, {
          runWrangler: run,
          log: silentLog,
          listHyperdriveConfigs: async () => bad as never,
        }),
      ).rejects.toThrow(/could not check whether Hyperdrive config "myapp-hd" already exists/);
      // No blind create, and nothing written to the config.
      expect(calls.some((c) => isCall(c, 'hyperdrive', 'create'))).toBe(false);
      expect(readConfig().hyperdrive).toBeUndefined();
    });
  }
});

describe('provisionCloudflareResources — whole-list id-format gate (D1 + KV, before name filtering)', () => {
  it('D1: a NON-matching list member with a malformed id fails the whole list closed (no create)', async () => {
    setup(JSON.stringify({ account_id: 'acct' }));
    const { run, calls } = makeRunner([
      // A different database with a bogus (non-UUID) id. Target "myapp-db" is absent, but
      // the untrustworthy member must reject the list rather than authorize a create.
      {
        match: /^d1 list --json/,
        reply: () => ok(JSON.stringify([{ name: 'other', database_id: 'bogus' }])),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/no valid id/);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
  });

  it('KV: a NON-matching list member with a malformed id fails the whole list closed (no create)', async () => {
    setup(JSON.stringify({ account_id: 'acct' }));
    const { run, calls } = makeRunner([
      {
        match: /^kv namespace list/,
        reply: () => ok(JSON.stringify([{ title: 'other', id: 'bogus' }])),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/no valid id/);
    expect(calls.some((c) => isCall(c, 'kv', 'namespace', 'create'))).toBe(false);
  });

  it('D1: a well-formed non-matching member still allows the target to be created (absence is authoritative)', async () => {
    setup(JSON.stringify({ account_id: 'acct' }));
    const { run } = makeRunner([
      {
        match: /^d1 list --json/,
        reply: () => ok(JSON.stringify([{ name: 'other', database_id: uuid('other') }])),
      },
      {
        match: /^d1 create /,
        reply: () => {
          simulateUpdateConfig('d1_databases', {
            binding: 'DB',
            database_name: 'myapp-db',
            database_id: uuid('mine'),
          });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(result.resources).toEqual([
      { kind: 'd1', binding: 'DB', name: 'myapp-db', action: 'created' },
    ]);
  });
});

describe('provisionCloudflareResources — strict duplicate-safe binding reader', () => {
  it('read-first fails closed on DUPLICATE same-binding entries in the target field (not reused)', async () => {
    // Two d1_databases entries share binding "DB".
    setup(
      JSON.stringify({
        account_id: 'acct',
        d1_databases: [
          { binding: 'DB', database_id: uuid('a'), database_name: 'myapp-db' },
          { binding: 'DB', database_id: uuid('b'), database_name: 'myapp-db' },
        ],
      }),
    );
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/binding "DB" is declared 2 times in "d1_databases"/);
    // Failed closed before any wrangler call — never reused/created.
    expect(calls.length).toBe(0);
  });

  it('read-first fails closed on a CROSS-TYPE collision (binding used by another field) — not reused', async () => {
    // Binding "DB" is used by a d1_databases entry and a kv_namespaces entry, which
    // wrangler rejects.
    setup(
      JSON.stringify({
        account_id: 'acct',
        d1_databases: [{ binding: 'DB', database_id: uuid('a'), database_name: 'myapp-db' }],
        kv_namespaces: [{ binding: 'DB', id: hex32('kv') }],
      }),
    );
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/binding "DB" in "d1_databases" is also used by a KV Namespace binding/);
    expect(calls.length).toBe(0);
  });

  it('read-first fails closed when a QUEUE PRODUCER collides with the binding (cross-type) — not reused', async () => {
    setup(
      JSON.stringify({
        account_id: 'acct',
        kv_namespaces: [{ binding: 'CACHE', id: hex32('cache') }],
        queues: { producers: [{ binding: 'CACHE', queue: 'jobs' }] },
      }),
    );
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, kvNamespaces: [{ binding: 'CACHE', title: 'cache' }] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/binding "CACHE" in "kv_namespaces" is also used by a Queue binding/);
    expect(calls.length).toBe(0);
  });

  it('reuses cleanly when the binding is unique across the worker (no false collision)', async () => {
    setup(
      JSON.stringify({
        account_id: 'acct',
        d1_databases: [{ binding: 'DB', database_id: uuid('db'), database_name: 'myapp-db' }],
        kv_namespaces: [{ binding: 'CACHE', id: hex32('cache') }],
      }),
    );
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(result.resources).toEqual([
      { kind: 'd1', binding: 'DB', name: 'myapp-db', action: 'reused', id: uuid('db') },
    ]);
    // Reused via read-first — no discovery/create.
    expect(calls.some((c) => isCall(c, 'd1', 'list'))).toBe(false);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
  });
});

describe('provisionCloudflareResources — resource-specific create postcondition', () => {
  it('R2: fails closed when create writes a DIFFERENT bucket_name than requested', async () => {
    setup(JSON.stringify({ account_id: 'acct' }));
    const { run } = makeRunner([
      {
        match: /^r2 bucket info /,
        reply: () => fail('', 'The specified bucket does not exist. [code: 10006]'),
      },
      {
        match: /^r2 bucket create /,
        reply: () => {
          // create "succeeds" but writes a DIFFERENT bucket than requested (a race /
          // stale --update-config / wrong-account write). bucket_name IS the identity.
          simulateUpdateConfig('r2_buckets', { binding: 'STORAGE', bucket_name: 'other-bucket' });
          return ok();
        },
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/does not hold the expected R2 bucket .*bucket_name === "myapp-uploads"/s);
  });

  it('D1: fails closed when create writes a real id but a MISMATCHED database_name', async () => {
    setup(JSON.stringify({ account_id: 'acct' }));
    const { run } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[]') },
      {
        match: /^d1 create /,
        reply: () => {
          simulateUpdateConfig('d1_databases', {
            binding: 'DB',
            database_name: 'other-db',
            database_id: 'real-id',
          });
          return ok();
        },
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/does not hold the expected D1 database .*database_name === "myapp-db"/s);
  });
});

describe('provisionCloudflareResources — resource-specific real-id validators', () => {
  it('KV: an id of " " is NOT real — runs discovery instead of read-first reuse', async () => {
    setup(JSON.stringify({ account_id: 'acct', kv_namespaces: [{ binding: 'KV', id: ' ' }] }));
    const { run, calls } = makeRunner([
      {
        match: /^kv namespace list/,
        reply: () => ok(JSON.stringify([{ id: hex32('kv'), title: 'myapp-kv' }])),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
      { runWrangler: run, log: silentLog },
    );
    expect(calls.some((c) => isCall(c, 'kv', 'namespace', 'list'))).toBe(true);
    expect(result.resources[0]).toMatchObject({ action: 'adopted', id: hex32('kv') });
  });

  it('D1: an id of "xyz" is NOT real — runs discovery instead of read-first reuse', async () => {
    setup(
      JSON.stringify({
        account_id: 'acct',
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: 'xyz' }],
      }),
    );
    const { run, calls } = makeRunner([
      {
        match: /^d1 list --json/,
        reply: () => ok(JSON.stringify([{ name: 'myapp-db', database_id: uuid('db') }])),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls.some((c) => isCall(c, 'd1', 'list'))).toBe(true);
    expect(result.resources[0]).toMatchObject({ action: 'adopted', id: uuid('db') });
  });

  it('KV: create postcondition FAILS when --update-config wrote a non-hex id', async () => {
    setup(JSON.stringify({ account_id: 'acct' }));
    const { run } = makeRunner([
      { match: /^kv namespace list/, reply: () => ok('[]') },
      {
        match: /^kv namespace create/,
        reply: () => {
          simulateUpdateConfig('kv_namespaces', { binding: 'KV', id: 'not-a-real-id' });
          return ok();
        },
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/does not hold the expected KV namespace/);
  });
});

describe('provisionCloudflareResources — KV title grammar vs option-injection guard', () => {
  it('accepts a KV title with spaces ("My Own Namespace") and creates it under that exact name', async () => {
    setup(JSON.stringify({ account_id: 'acct' }));
    const { run, calls } = makeRunner([
      { match: /^kv namespace list/, reply: () => ok('[]') },
      {
        match: /^kv namespace create/,
        reply: () => {
          simulateUpdateConfig('kv_namespaces', { binding: 'KV', id: hex32('kv') });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'My Own Namespace' }] },
      { runWrangler: run, log: silentLog },
    );
    expect(result.resources[0]).toMatchObject({ kind: 'kv', action: 'created' });
    const createCall = calls.find((c) => isCall(c, 'kv', 'namespace', 'create'));
    expect(createCall).toContain('My Own Namespace');
  });

  it('rejects an R2 bucket name with invalid characters (uppercase/underscore)', async () => {
    setup(JSON.stringify({ account_id: 'acct' }));
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'My_Bucket' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/invalid R2 bucket name/);
    expect(calls.length).toBe(0);
  });
});

describe('provisionCloudflareResources — queue name grammar (Cloudflare Queues)', () => {
  // Underscores are NOT allowed; a trailing separator is NOT allowed; > 63 chars rejected.
  for (const bad of ['jobs_v2', 'jobs_', 'jobs-', '_jobs', '-jobs', 'a'.repeat(64)]) {
    it(`rejects the invalid queue name ${JSON.stringify(bad)} before any wrangler call`, async () => {
      setup(JSON.stringify({ account_id: 'acct' }));
      const { run, calls } = makeRunner([]);
      await expect(
        provisionCloudflareResources(
          tmpDir,
          wranglerPath,
          { ...emptyDesired, queues: [bad] },
          { runWrangler: run, log: silentLog },
        ),
      ).rejects.toThrow(/unsafe queue name|invalid queue name/);
      expect(calls.length).toBe(0);
    });
  }

  // Valid: single alphanumeric, 63 chars, and internal dashes.
  for (const good of ['a', 'Q9', 'a'.repeat(63), 'jobs-v2', 'my-queue-1']) {
    it(`accepts the valid queue name ${JSON.stringify(good)} (reaches wrangler)`, async () => {
      setup(JSON.stringify({ account_id: 'acct' }));
      const { run, calls } = makeRunner([
        { match: /^queues info /, reply: () => ok(`Queue Name: ${good}`) },
      ]);
      const result = await provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, queues: [good] },
        { runWrangler: run, log: silentLog },
      );
      expect(result.resources).toEqual([{ kind: 'queue', name: good, action: 'reused' }]);
      expect(calls.some((c) => isCall(c, 'queues', 'info'))).toBe(true);
    });
  }
});

describe('provisionCloudflareResources — config compliance_region pins the transport', () => {
  it('resolvePinnedApiBaseUrl honors the config compliance_region (fedramp) with no ambient override', () => {
    // Config says fedramp_high, no CLOUDFLARE_COMPLIANCE_REGION ambient → the FedRAMP base.
    expect(resolvePinnedApiBaseUrl({}, 'fedramp_high')).toBe(
      'https://api.fed.cloudflare.com/client/v4',
    );
    // Config "public" → public base; absent config → public base.
    expect(resolvePinnedApiBaseUrl({}, 'public')).toBe('https://api.cloudflare.com/client/v4');
    expect(resolvePinnedApiBaseUrl({}, undefined)).toBe('https://api.cloudflare.com/client/v4');
  });

  it('resolvePinnedApiBaseUrl fails closed on a config-vs-ambient compliance_region conflict', () => {
    expect(() =>
      resolvePinnedApiBaseUrl({ CLOUDFLARE_COMPLIANCE_REGION: 'public' }, 'fedramp_high'),
    ).toThrow(/conflicting values/);
    // Equal on both sides is fine (no conflict).
    expect(
      resolvePinnedApiBaseUrl({ CLOUDFLARE_COMPLIANCE_REGION: 'fedramp_high' }, 'fedramp_high'),
    ).toBe('https://api.fed.cloudflare.com/client/v4');
  });

  it('rejects an invalid config compliance_region value', () => {
    expect(() => resolvePinnedApiBaseUrl({}, 'somewhere')).toThrow(
      'the Cloudflare config "compliance_region" must be one of "public" or "fedramp_high"',
    );
  });

  it('a fedramp config pins BOTH the wrangler child env AND the Hyperdrive REST lister to the .fed base', async () => {
    vi.stubEnv('CLOUDFLARE_COMPLIANCE_REGION', undefined);
    setup(
      JSON.stringify({
        account_id: 'config-acct',
        compliance_region: 'fedramp_high',
        hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }],
      }),
    );
    let seen: { apiBaseUrl: string } | undefined;
    const run: RunWrangler = provisionOperationFixture((_args, opts) => {
      expect(opts.apiBaseUrl).toBe('https://api.fed.cloudflare.com/client/v4');
      return { stdout: '', stderr: '', status: 0 };
    });
    await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
      },
      {
        runWrangler: run,
        log: silentLog,
        listHyperdriveConfigs: async (ctx) => {
          seen = ctx;
          return [];
        },
      },
    );
    expect(seen?.apiBaseUrl).toBe('https://api.fed.cloudflare.com/client/v4');
  });

  it('fails closed when the config compliance_region conflicts with an ambient CLOUDFLARE_COMPLIANCE_REGION', async () => {
    vi.stubEnv('CLOUDFLARE_COMPLIANCE_REGION', 'public');
    setup(
      JSON.stringify({
        account_id: 'config-acct',
        compliance_region: 'fedramp_high',
        hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }],
      }),
    );
    let listerCalled = false;
    const { run } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
        },
        {
          runWrangler: run,
          log: silentLog,
          listHyperdriveConfigs: async () => {
            listerCalled = true;
            return [];
          },
        },
      ),
    ).rejects.toThrow(/conflicting values/);
    expect(listerCalled).toBe(false);
  });
});

describe('provisionCloudflareResources — wrangler-exact base resolution order', () => {
  it('an INVALID WRANGLER_API_ENVIRONMENT fails closed (wrangler assertOneOf) instead of pinning prod', () => {
    // wrangler's env factory has choices ["production","staging"]; a present out-of-choices
    // value (typo'd "stagng", or an empty string) throws — never silently public production.
    expect(() => resolvePinnedApiBaseUrl({ WRANGLER_API_ENVIRONMENT: 'stagng' })).toThrow(
      /WRANGLER_API_ENVIRONMENT.*"production" or "staging".*"stagng"/s,
    );
    expect(() => resolvePinnedApiBaseUrl({ WRANGLER_API_ENVIRONMENT: '' })).toThrow(
      /WRANGLER_API_ENVIRONMENT/,
    );
    // An explicit "production" is a valid choice → the public base.
    expect(resolvePinnedApiBaseUrl({ WRANGLER_API_ENVIRONMENT: 'production' })).toBe(
      'https://api.cloudflare.com/client/v4',
    );
  });

  it('an empty direct base override is honored AS-IS (presence + nullish semantics, like wrangler)', () => {
    // wrangler: `getCloudflareApiBaseUrlFromEnv() ?? derived` — a PRESENT empty string is
    // returned (nullish, not falsy, coalescing) and CLOUDFLARE_* presence beats CF_*.
    expect(resolvePinnedApiBaseUrl({ CLOUDFLARE_API_BASE_URL: '' })).toBe('');
    expect(
      resolvePinnedApiBaseUrl({
        CLOUDFLARE_API_BASE_URL: '',
        CF_API_BASE_URL: 'https://cf.example',
      }),
    ).toBe('');
    expect(resolvePinnedApiBaseUrl({ CF_API_BASE_URL: '' })).toBe('');
  });

  it('provisionEnv pins a resolved EMPTY base into the child env (presence, not truthiness)', () => {
    const env = provisionEnv({ accountId: 'acct', apiBaseUrl: '' });
    // The child wrangler must see the SAME (empty) override the ambient env carried — never
    // a scrubbed env that would silently re-derive the default endpoint (split-brain).
    expect(env.CLOUDFLARE_API_BASE_URL).toBe('');
  });

  it('a direct base + CONFLICTING compliance settings resolves to the direct base (no false reject)', () => {
    // wrangler's `??` short-circuits past getComplianceRegionSubdomain when a direct base is
    // present, so the env-vs-config conflict is never evaluated there.
    expect(
      resolvePinnedApiBaseUrl(
        {
          CLOUDFLARE_API_BASE_URL: 'https://direct.example',
          CLOUDFLARE_COMPLIANCE_REGION: 'public',
        },
        'fedramp_high',
      ),
    ).toBe('https://direct.example');
    // Same for an invalid STAGING selector — unread on the direct branch.
    expect(
      resolvePinnedApiBaseUrl({
        CLOUDFLARE_API_BASE_URL: 'https://direct.example',
        WRANGLER_API_ENVIRONMENT: 'stagng',
      }),
    ).toBe('https://direct.example');
  });

  it('the config compliance_region VALUE is still validated with a direct base present (wrangler config validation)', () => {
    expect(() =>
      resolvePinnedApiBaseUrl({ CLOUDFLARE_API_BASE_URL: 'https://direct.example' }, 'bogus'),
    ).toThrow(/one of "public" or "fedramp_high"/);
  });
});

describe('provisionCloudflareResources — Hyperdrive password never reaches wrangler diagnostics', () => {
  it('provisionEnv scrubs the session-output sinks and PINS sanitized logging', () => {
    vi.stubEnv('WRANGLER_OUTPUT_FILE_PATH', '/tmp/wrangler-output.json');
    vi.stubEnv('WRANGLER_OUTPUT_FILE_DIRECTORY', '/tmp/wrangler-output');
    vi.stubEnv('WRANGLER_LOG_SANITIZE', 'false');
    const env = provisionEnv({ accountId: 'acct' });
    // Output sinks would write the child's diagnostics to disk.
    expect(env.WRANGLER_OUTPUT_FILE_PATH).toBeUndefined();
    expect(env.WRANGLER_OUTPUT_FILE_DIRECTORY).toBeUndefined();
    expect(env.WRANGLER_LOG_SANITIZE).toBe('true');
  });

  it('redacts the exact connection string AND URL userinfo passwords from propagated errors', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const conn = 'postgres://dbuser:sup3r-secret@db.example.com:5432/app';
    const { run } = makeRunner([
      {
        // The create fails, ECHOING the connection string (verbatim AND re-rendered).
        match: /^hyperdrive create /,
        reply: () =>
          fail(
            '',
            `X [ERROR] could not connect using ${conn} ` +
              `(also tried mysql://dbuser:sup3r-secret@db.example.com/app)`,
          ),
      },
    ]);
    let thrown: Error | undefined;
    try {
      await provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: conn },
        },
        { runWrangler: run, log: silentLog, listHyperdriveConfigs: async () => [] },
      );
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
    // The password never appears — neither via the verbatim echo nor the re-rendered URL.
    expect(thrown!.message).not.toContain('sup3r-secret');
    expect(thrown!.message).not.toContain(conn);
    expect(thrown!.message).toContain('[REDACTED]');
  });

  it('a seam rejecting a password-bearing plain STRING is redacted before propagation', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const conn = 'postgres://dbuser:sup3r-secret@db.example.com:5432/app';
    const run: RunWrangler = provisionOperationFixture(() =>
      Promise.reject(`hyperdrive create failed for ${conn}`),
    );
    let thrown: unknown;
    try {
      await provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: conn },
        },
        { runWrangler: run, log: silentLog, listHyperdriveConfigs: async () => [] },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain('sup3r-secret');
    expect((thrown as Error).message).not.toContain(conn);
    expect((thrown as Error).message).toContain('[REDACTED]');
  });

  it('a QUARANTINE rejection keeps its identity/metadata while its message is redacted', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const lockMutex = `${wranglerPath}.void-provision.lock.lock`;
    const sidecar = `${wranglerPath}.void-provision.lock.quarantine.json`;
    const conn = 'postgres://dbuser:sup3r-secret@db.example.com:5432/app';
    const quarantineError = new WranglerQuarantineError(
      54321,
      `kill failed while running hyperdrive create --connection-string=${conn}`,
    );
    const run: RunWrangler = provisionOperationFixture(() => Promise.reject(quarantineError));
    let thrown: unknown;
    try {
      await provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: conn },
        },
        { runWrangler: run, log: silentLog, listHyperdriveConfigs: async () => [] },
      );
    } catch (error) {
      thrown = error;
    }
    // The same object propagates, so the provision still recognizes it and retains the lock.
    expect(thrown).toBe(quarantineError);
    expect((thrown as WranglerQuarantineError).pid).toBe(54321);
    expect((thrown as Error).message).not.toContain('sup3r-secret');
    expect((thrown as Error).message).toContain('[REDACTED]');
    expect(existsSync(lockMutex)).toBe(true);
    // Cleanup the retained mutex + sidecar for later tests.
    rmSync(lockMutex, { recursive: true, force: true });
    rmSync(sidecar, { force: true });
  });

  it('a lister rejecting a plain STRING is redacted in the warning', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const warns: Array<string> = [];
    const { run } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: {
            binding: 'HYPERDRIVE',
            name: 'myapp-hd',
            connectionString: 'postgres://u:leaky-pass@h/db',
          },
        },
        {
          runWrangler: run,
          log: { info: () => {}, warn: (msg) => warns.push(msg) },
          listHyperdriveConfigs: () =>
            Promise.reject('fetch failed for postgres://u:leaky-pass@h/db'),
        },
      ),
    ).rejects.toThrow(/could not check whether/);
    const listerWarn = warns.find((w) => w.includes('existence check'));
    expect(listerWarn).toBeDefined();
    expect(listerWarn).not.toContain('leaky-pass');
    expect(listerWarn).toContain('[REDACTED]');
  });

  it('redacts a userinfo password from the Hyperdrive lister failure warning', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const warns: Array<string> = [];
    const { run } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: {
            binding: 'HYPERDRIVE',
            name: 'myapp-hd',
            connectionString: 'postgres://u:leaky-pass@h/db',
          },
        },
        {
          runWrangler: run,
          log: { info: () => {}, warn: (msg) => warns.push(msg) },
          listHyperdriveConfigs: async () => {
            throw new Error('fetch failed for postgres://u:leaky-pass@h/db');
          },
        },
      ),
    ).rejects.toThrow(/could not check whether/);
    const listerWarn = warns.find((w) => w.includes('existence check'));
    expect(listerWarn).toBeDefined();
    expect(listerWarn).not.toContain('leaky-pass');
    expect(listerWarn).toContain('[REDACTED]');
  });
});

describe('assertNoTransportRedirectInProjectDotenv — the files and keys wrangler loads', () => {
  const redirect = 'CLOUDFLARE_API_BASE_URL=https://api.staging.cloudflare.com/client/v4\n';

  type ProjectFiles = { name: string; files: Record<string, string> };

  function writeProjectFiles(files: Record<string, string>): void {
    setup(JSON.stringify({ name: 'app' }));
    for (const [file, content] of Object.entries(files)) {
      writeFileSync(join(tmpDir, file), content);
    }
  }

  it.each<ProjectFiles & { error: RegExp }>([
    {
      name: 'WRANGLER_OUTPUT_FILE_DIRECTORY in .env',
      files: { '.env': 'WRANGLER_OUTPUT_FILE_DIRECTORY=/tmp/wrangler-out\n' },
      error: /refusing to provision.*\.env.*WRANGLER_OUTPUT_FILE_DIRECTORY.*session output files/s,
    },
    {
      name: 'WRANGLER_OUTPUT_FILE_PATH in .env.local',
      files: { '.env.local': 'WRANGLER_OUTPUT_FILE_PATH=/tmp/out.json\n' },
      error: /WRANGLER_OUTPUT_FILE_PATH/,
    },
    {
      name: 'an export-prefixed redirect in .env',
      files: { '.env': `export ${redirect}` },
      error: /refusing to provision.*\.env.*CLOUDFLARE_API_BASE_URL.*redirect/s,
    },
    {
      name: 'a redirect in .env.',
      files: { '.env.': redirect },
      error: /refusing to provision.*"\.env\.".*CLOUDFLARE_API_BASE_URL.*redirect/s,
    },
    {
      name: 'a redirect in .env..local',
      files: { '.env..local': redirect },
      error: /refusing to provision.*"\.env\.\.local".*redirect/s,
    },
    {
      name: 'a redirect in .dev.vars.',
      files: { '.dev.vars.': redirect },
      error: /refusing to provision.*"\.dev\.vars\.".*CLOUDFLARE_API_BASE_URL/s,
    },
    {
      name: 'a redirect in .dev.vars when .dev.vars. is absent',
      files: { '.dev.vars': redirect },
      error: /refusing to provision.*"\.dev\.vars".*CLOUDFLARE_API_BASE_URL/s,
    },
  ])('rejects $name', ({ files, error }) => {
    writeProjectFiles(files);
    expect(() => assertNoTransportRedirectInProjectDotenv(tmpDir)).toThrow(error);
  });

  it.each<ProjectFiles>([
    {
      name: 'a .env with only unrelated vars',
      files: { '.env': 'export DATABASE_URL=postgres://localhost/app\nFOO=bar\n' },
    },
    // Wrangler never loads `.dev.vars.local`.
    { name: 'a redirect in .dev.vars.local', files: { '.dev.vars.local': redirect } },
    // Wrangler reads `.dev.vars` only when `.dev.vars.` is absent.
    {
      name: 'a redirect in .dev.vars when .dev.vars. exists',
      files: { '.dev.vars.': 'SOME_APP_SECRET=benign\n', '.dev.vars': redirect },
    },
  ])('allows $name', ({ files }) => {
    writeProjectFiles(files);
    expect(() => assertNoTransportRedirectInProjectDotenv(tmpDir)).not.toThrow();
  });

  it('dev-vars keys are case-SENSITIVE on every platform — a mixed-case spelling never trips the fence', () => {
    // `tryLoadDotDevDotVars` parses via `dotenv.parse` into a PLAIN object;
    // `caseInsensitiveEnv` applies only to wrangler's `loadDotEnv` (.env family). A
    // mixed-case key in dev-vars is a DIFFERENT key for wrangler even on win32.
    setup(JSON.stringify({ name: 'app' }));
    writeFileSync(join(tmpDir, '.dev.vars'), 'cloudflare_api_base_url=https://evil.example\n');
    expect(() => assertNoTransportRedirectInProjectDotenv(tmpDir, 'win32')).not.toThrow();
    expect(() => assertNoTransportRedirectInProjectDotenv(tmpDir, 'darwin')).not.toThrow();
    // The EXACT spelling still trips it everywhere.
    writeFileSync(join(tmpDir, '.dev.vars'), 'CLOUDFLARE_API_BASE_URL=https://evil.example\n');
    expect(() => assertNoTransportRedirectInProjectDotenv(tmpDir, 'win32')).toThrow(/\.dev\.vars/);
    expect(() => assertNoTransportRedirectInProjectDotenv(tmpDir, 'darwin')).toThrow(/\.dev\.vars/);
  });

  it('compares variable names case-insensitively on win32 (wrangler loads dotenv into a caseInsensitiveEnv there)', () => {
    setup(JSON.stringify({ name: 'app' }));
    writeFileSync(join(tmpDir, '.env'), 'cloudflare_api_base_url=https://evil.example\n');
    // Simulated win32: the mixed-case key IS the transport var (case-insensitive env).
    expect(() => assertNoTransportRedirectInProjectDotenv(tmpDir, 'win32')).toThrow(
      /refusing to provision.*\.env/s,
    );
    // POSIX: env vars are case-sensitive — the lowercase key is a different variable.
    expect(() => assertNoTransportRedirectInProjectDotenv(tmpDir, 'darwin')).not.toThrow();
    expect(() => assertNoTransportRedirectInProjectDotenv(tmpDir, 'linux')).not.toThrow();
  });

  it('the win32 case rule also covers the output-file sinks', () => {
    setup(JSON.stringify({ name: 'app' }));
    writeFileSync(join(tmpDir, '.env'), 'Wrangler_Output_File_Path=/tmp/out.json\n');
    expect(() => assertNoTransportRedirectInProjectDotenv(tmpDir, 'win32')).toThrow(
      /session output files/,
    );
    expect(() => assertNoTransportRedirectInProjectDotenv(tmpDir, 'darwin')).not.toThrow();
  });
});

describe('provisionEnv — win32 case-insensitive credential scrub', () => {
  const MIXED_CASE_KEYS = [
    'Wrangler_Output_File_Path',
    'wrangler_output_file_directory',
    'cloudflare_api_base_url',
    'Cf_Api_Base_Url',
    'Cloudflare_Env',
    'cf_access_client_id',
    'Cf_Access_Client_Secret',
    // A mixed-case 'false' must not shadow the pinned value.
    'Wrangler_Log_Sanitize',
  ] as const;

  beforeEach(() => {
    for (const key of MIXED_CASE_KEYS) {
      vi.stubEnv(key, key === 'Wrangler_Log_Sanitize' ? 'false' : 'ambient-value');
    }
  });

  it('on win32, EVERY case-insensitive spelling of every scrubbed key set is removed before pinning', () => {
    const env = provisionEnv({
      accountId: 'acct',
      apiBaseUrl: 'https://api.cloudflare.com/client/v4',
      platform: 'win32',
    });
    // A win32 child reads environment keys case-insensitively.
    for (const key of MIXED_CASE_KEYS) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.WRANGLER_LOG_SANITIZE).toBe('true');
    expect(env.CLOUDFLARE_API_BASE_URL).toBe('https://api.cloudflare.com/client/v4');
    expect(env.CLOUDFLARE_ACCOUNT_ID).toBe('acct');
  });

  it('on POSIX, mixed-case spellings are DIFFERENT variables and survive (exact-case scrub only)', () => {
    const env = provisionEnv({ accountId: 'acct', platform: 'linux' });
    expect(env.Wrangler_Output_File_Path).toBe('ambient-value');
    expect(env.cloudflare_api_base_url).toBe('ambient-value');
    expect(env.WRANGLER_LOG_SANITIZE).toBe('true');
  });
});

describe('provisionCloudflareResources — read-first stored-name identity', () => {
  it('D1: a stored database_name DIFFERENT from the desired name fails closed (no wrangler call, no reuse)', async () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'other-db', database_id: uuid('other') }],
      }),
    );
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(
      /D1 binding "DB".*stores database_name "other-db".*wants database "myapp-db".*contradicts the desired name/s,
    );
    // Fail closed — no discovery/create, config untouched.
    expect(calls).toEqual([]);
    expect((readConfig().d1_databases as Array<Record<string, unknown>>)[0].database_id).toBe(
      uuid('other'),
    );
  });

  it('D1: an entry with a real id but NO database_name keeps ID-only reuse', async () => {
    setup(JSON.stringify({ d1_databases: [{ binding: 'DB', database_id: uuid('db1') }] }));
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([]);
    expect(result.resources[0].action).toBe('reused');
    expect(result.resources[0].id).toBe(uuid('db1'));
  });

  it('R2: a stored bucket_name DIFFERENT from the desired name fails closed (contradiction, never silent reuse)', async () => {
    setup(
      JSON.stringify({ r2_buckets: [{ binding: 'STORAGE', bucket_name: 'someone-elses-bucket' }] }),
    );
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(
      /R2 binding "STORAGE".*stores bucket_name "someone-elses-bucket".*wants bucket "myapp-uploads".*contradicts the desired bucket/s,
    );
    expect(calls).toEqual([]);
  });

  it('R2: the `default` placeholder bucket_name still takes the discovery path (not a contradiction)', async () => {
    setup(JSON.stringify({ r2_buckets: [{ binding: 'STORAGE', bucket_name: 'default' }] }));
    const { run, calls } = makeRunner([
      {
        match: /^r2 bucket info /,
        reply: () => fail('', 'X [ERROR] The specified bucket does not exist [code: 10006]'),
      },
      {
        match: /^r2 bucket create /,
        reply: () => {
          simulateUpdateConfig('r2_buckets', { binding: 'STORAGE', bucket_name: 'myapp-uploads' });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls.some((c) => isCall(c, 'r2', 'bucket', 'create'))).toBe(true);
    expect(result.resources[0].action).toBe('created');
  });

  it('R2: a desired bucket named default reuses the matching stored bucket', async () => {
    setup(JSON.stringify({ r2_buckets: [{ binding: 'STORAGE', bucket_name: 'default' }] }));
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'default' } },
      { runWrangler: run, log: silentLog },
    );
    expect(result.resources[0]).toMatchObject({ kind: 'r2', name: 'default', action: 'reused' });
    expect(calls).toEqual([]);
  });
});

describe('provisionCloudflareResources — per-resource placeholder rules', () => {
  it('R2: a stored bucket_name of "local" is a REAL name — a different desired bucket fails closed (no silent rewrite)', async () => {
    // Only "default" is R2's placeholder; "local" is a real bucket name.
    setup(
      JSON.stringify({
        account_id: 'acct',
        r2_buckets: [{ binding: 'STORAGE', bucket_name: 'local' }],
      }),
    );
    const { run, calls } = makeRunner([
      { match: /^r2 bucket info /, reply: () => ok(JSON.stringify({ name: 'myapp-storage' })) },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-storage' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(
      /R2 binding "STORAGE".*stores.*bucket_name "local".*wants bucket "myapp-storage".*contradicts/s,
    );
    // Fail closed: no discovery/create, stored entry untouched.
    expect(calls).toEqual([]);
    expect((readConfig().r2_buckets as Array<Record<string, unknown>>)[0].bucket_name).toBe(
      'local',
    );
  });

  it('R2: a stored bucket_name of "local" EQUAL to the desired bucket is reused (real name, no wrangler call)', async () => {
    setup(
      JSON.stringify({
        account_id: 'acct',
        r2_buckets: [{ binding: 'STORAGE', bucket_name: 'local' }],
      }),
    );
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'local' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([]);
    expect(result.resources[0]).toEqual({
      kind: 'r2',
      binding: 'STORAGE',
      name: 'local',
      action: 'reused',
    });
  });

  it('R2: a bucket genuinely named "default" is created + verified via the remote probe (no false postcondition failure)', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    let created = false;
    const { run, calls } = makeRunner([
      {
        match: /^r2 bucket info /,
        reply: () =>
          created
            ? ok(JSON.stringify({ name: 'default' }))
            : fail('', 'X [ERROR] The specified bucket does not exist. [code: 10006]'),
      },
      {
        match: /^r2 bucket create /,
        reply: () => {
          created = true;
          simulateUpdateConfig('r2_buckets', { binding: 'STORAGE', bucket_name: 'default' });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'default' } },
      { runWrangler: run, log: silentLog },
    );
    // A created `default` bucket is verified by the remote probe, not the placeholder rule.
    expect(result.resources[0]).toEqual({
      kind: 'r2',
      binding: 'STORAGE',
      name: 'default',
      action: 'created',
    });
    const infoCalls = calls.filter((c) => isCall(c, 'r2', 'bucket', 'info'));
    expect(infoCalls.length).toBe(2); // the absence probe + the post-create verify probe
  });

  it('R2: a masked-killed create of a bucket named "default" fails closed when the verify probe cannot confirm it', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const { run } = makeRunner([
      {
        // Absence first, and STILL absent on the verify probe (the create was masked).
        match: /^r2 bucket info /,
        reply: () => fail('', 'X [ERROR] The specified bucket does not exist. [code: 10006]'),
      },
      {
        // The create "succeeds" (exit 0) and even writes the entry — but for the name
        // `default` that entry is indistinguishable from the local-dev placeholder.
        match: /^r2 bucket create /,
        reply: () => {
          simulateUpdateConfig('r2_buckets', { binding: 'STORAGE', bucket_name: 'default' });
          return ok();
        },
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'default' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/did not confirm the bucket exists/);
  });
});

describe('provisionCloudflareResources — D1 whole-list alias reconciliation', () => {
  it('a NON-target member with a valid uuid but a CONFLICTING/malformed database_id rejects the WHOLE list (no create)', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const { run, calls } = makeRunner([
      {
        // A member whose `uuid` alone is valid must not count as proof of absence.
        match: /^d1 list --json/,
        reply: () =>
          ok(JSON.stringify([{ name: 'other-db', uuid: uuid('other'), database_id: 'bogus' }])),
      },
      { match: /^d1 create /, reply: () => ok() },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/no valid id.*agreeing on one id/s);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
  });

  it('a NON-target member with TWO valid but DISAGREEING alias UUIDs rejects the whole list (no create)', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^d1 list --json/,
        reply: () =>
          ok(
            JSON.stringify([
              { name: 'other-db', uuid: uuid('alias-a'), database_id: uuid('alias-b') },
            ]),
          ),
      },
      { match: /^d1 create /, reply: () => ok() },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/no valid id/);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
  });

  it('a member with AGREEING aliases (uuid === database_id) passes the gate; absence stays authoritative', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const { run } = makeRunner([
      {
        match: /^d1 list --json/,
        reply: () =>
          ok(JSON.stringify([{ name: 'other-db', uuid: uuid('same'), database_id: uuid('same') }])),
      },
      {
        match: /^d1 create /,
        reply: () => {
          simulateUpdateConfig('d1_databases', {
            binding: 'DB',
            database_name: 'myapp-db',
            database_id: uuid('mine'),
          });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(result.resources[0].action).toBe('created');
  });

  it('the TARGET member with a non-string secondary alias (uuid: 123) fails closed as ambiguous — never adopted', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^d1 list --json/,
        reply: () => ok(JSON.stringify([{ name: 'myapp-db', database_id: uuid('db'), uuid: 123 }])),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/no valid id/);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
  });
});

describe('checkCloudflareProvisionDrift — id-drift vs the committed wrangler config', () => {
  it('reports every desired id-bearing resource as missing when the config file is absent', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    const { missing } = checkCloudflareProvisionDrift(wranglerPath, {
      d1: { binding: 'DB', name: 'myapp-db' },
      kvNamespaces: [
        { binding: 'KV', title: 'myapp-kv' },
        { binding: 'ISR_CACHE', title: 'myapp-isr-cache' },
      ],
      r2: { binding: 'STORAGE', bucketName: 'myapp-storage' },
      queues: ['jobs'],
      hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hyperdrive', connectionString: '' },
    });
    // Queues are name-bearing, not id-bearing → excluded from the id-drift check.
    expect(missing.map((m) => m.binding).sort()).toEqual([
      'DB',
      'HYPERDRIVE',
      'ISR_CACHE',
      'KV',
      'STORAGE',
    ]);
  });

  it('treats placeholder ids (local / default) as NOT provisioned', () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'default', database_id: 'local' }],
        kv_namespaces: [{ binding: 'ISR_CACHE', id: 'local' }],
        r2_buckets: [{ binding: 'STORAGE', bucket_name: 'default' }],
      }),
    );
    const { missing } = checkCloudflareProvisionDrift(wranglerPath, {
      d1: { binding: 'DB', name: 'myapp-db' },
      kvNamespaces: [{ binding: 'ISR_CACHE', title: 'myapp-isr-cache' }],
      r2: { binding: 'STORAGE', bucketName: 'myapp-storage' },
      queues: [],
    });
    expect(missing.map((m) => m.kind).sort()).toEqual(['d1', 'kv', 'r2']);
  });

  it('accepts a stored R2 bucket named default when that is the desired bucket', () => {
    setup(JSON.stringify({ r2_buckets: [{ binding: 'STORAGE', bucket_name: 'default' }] }));
    const { missing } = checkCloudflareProvisionDrift(wranglerPath, {
      ...emptyDesired,
      r2: { binding: 'STORAGE', bucketName: 'default' },
    });
    expect(missing).toEqual([]);
  });

  it('reports NO drift when every desired resource has a real id', () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: uuid('db') }],
        kv_namespaces: [
          { binding: 'KV', id: hex32('kv') },
          { binding: 'ISR_CACHE', id: hex32('isr') },
        ],
        r2_buckets: [{ binding: 'STORAGE', bucket_name: 'myapp-storage' }],
        hyperdrive: [{ binding: 'HYPERDRIVE', id: hex32('hd') }],
      }),
    );
    const { missing } = checkCloudflareProvisionDrift(wranglerPath, {
      d1: { binding: 'DB', name: 'myapp-db' },
      kvNamespaces: [
        { binding: 'KV', title: 'myapp-kv' },
        { binding: 'ISR_CACHE', title: 'myapp-isr-cache' },
      ],
      r2: { binding: 'STORAGE', bucketName: 'myapp-storage' },
      queues: [],
      hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hyperdrive', connectionString: '' },
    });
    expect(missing).toEqual([]);
  });

  it('flags only the newly-desired resource when the rest are already provisioned', () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: uuid('db') }],
        // ISR_CACHE not yet declared — routes just started using `revalidate`.
      }),
    );
    const { missing } = checkCloudflareProvisionDrift(wranglerPath, {
      d1: { binding: 'DB', name: 'myapp-db' },
      kvNamespaces: [{ binding: 'ISR_CACHE', title: 'myapp-isr-cache' }],
      queues: [],
    });
    expect(missing).toEqual([{ binding: 'ISR_CACHE', kind: 'kv', name: 'myapp-isr-cache' }]);
  });
});
