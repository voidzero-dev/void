import { PGlite } from '@electric-sql/pglite';
import {
  AI_LOGGING_CLEARED_TTL_SECONDS,
  AI_LOGGING_ORPHAN_GRACE_MS,
} from '@void/platform/ai-logging';
import { getPlatformRuntimeDirectory, readPlatformRuntimeManifest } from '@void/platform/installer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  projectPlatformAiLoggingConnection,
  publishInstallationAiLogging,
  type AiLoggingProjectionKv,
} from '../../src/cli/platform-ai-logging-projection.ts';
import type { CloudflareKvBulkEntry } from '../../src/cli/platform-cloudflare.ts';
import { preparePlatformDatabaseConnection } from '../../src/cli/platform-installer-database.ts';
import type { QueryConnection } from '../../src/cli/platform-zero-trust-uninstall.ts';

const NOW = 1_800_000_000_000;

let database: PGlite;
let connection: QueryConnection;

/** An in-memory ROUTING namespace that records every bulk call. */
function memoryKv(initial: Record<string, { value: string; metadata?: unknown }> = {}) {
  const store = new Map(Object.entries(initial));
  const calls: Array<string> = [];
  const expirations = new Map<string, number>();
  const kv: AiLoggingProjectionKv = {
    list: async (prefix) => {
      calls.push('list');
      return [...store]
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, entry]) =>
          entry.metadata === undefined ? { name } : { name, metadata: entry.metadata },
        );
    },
    put: async (entries: ReadonlyArray<CloudflareKvBulkEntry>) => {
      calls.push('put');
      for (const entry of entries) {
        store.set(entry.key, { value: entry.value, metadata: entry.metadata });
        if (entry.expiration_ttl !== undefined) {
          expirations.set(entry.key, entry.expiration_ttl);
        }
      }
    },
    delete: async (keys) => {
      calls.push('delete');
      for (const key of keys) {
        store.delete(key);
      }
    },
  };
  return { kv, store, calls, expirations };
}

/** Records each statement so tests can check lock and transaction order. */
function recording(statements: Array<string>, onStatement?: (sql: string) => void) {
  return {
    query: async (sql: string, values?: ReadonlyArray<unknown>) => {
      statements.push(sql);
      onStatement?.(sql);
      return connection.query(sql, values);
    },
  } as QueryConnection;
}

async function seed(sql: string) {
  await database.exec(sql);
}

beforeAll(async () => {
  database = new PGlite();
  await database.waitReady;
  connection = database as unknown as QueryConnection;
  const runtime = readPlatformRuntimeManifest();
  await preparePlatformDatabaseConnection(
    connection as Parameters<typeof preparePlatformDatabaseConnection>[0],
    getPlatformRuntimeDirectory(),
    runtime.database,
    null,
    false,
  );
}, 60_000);

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await seed(`DELETE FROM project_ai_logging; DELETE FROM projects; DELETE FROM users;
    DELETE FROM platform_settings WHERE key IN ('plans:catalog', 'plans:ai-logging');`);
});

describe('installer AI logging projection', () => {
  it('skips an older schema without the AI logging table', async () => {
    const empty = new PGlite();
    await empty.waitReady;
    try {
      const { kv, calls } = memoryKv();
      await expect(
        projectPlatformAiLoggingConnection(empty as unknown as QueryConnection, kv),
      ).resolves.toEqual({ skipped: true });
      expect(calls).toEqual([]);
    } finally {
      await empty.close();
    }
  });

  it('publishes overrides and plan defaults with metadata and deletes stale keys', async () => {
    await seed(`
      INSERT INTO users (id, login, provider_id, plan) VALUES
        ('u-pro', 'pro', '1', 'pro'), ('u-free', 'free', '2', 'free'),
        ('u-legacy', 'legacy', '3', 'legacy-x');
      INSERT INTO projects (id, user_id, slug) VALUES
        ('p-override', 'u-free', 'override'), ('p-plan', 'u-pro', 'plan'),
        ('p-inherit', 'u-free', 'inherit'), ('p-stale', 'u-free', 'stale'),
        ('p-legacy', 'u-legacy', 'legacy'), ('p-wins', 'u-pro', 'wins'),
        ('p-deleting', 'u-free', 'deleting');
      UPDATE projects SET status = 'deleting' WHERE id = 'p-deleting';
      INSERT INTO project_ai_logging (project_id, mode) VALUES
        ('p-override', 'off'), ('p-wins', 'full'), ('p-deleting', 'off');
      INSERT INTO platform_settings (key, value) VALUES
        ('plans:ai-logging', '{"modes":{"pro":"metadata","custom":"off"},"publish":null}');
    `);
    const { kv, store, expirations } = memoryKv({
      'ai-logging:p-stale': { value: 'off', metadata: { mode: 'off', at: 1 } },
      'ai-logging:p-plan': { value: 'full', metadata: { mode: 'full', at: 1 } },
      'ai-logging:p-gone-old': { value: 'off', metadata: { mode: 'off', at: 1 } },
      'ai-logging:p-gone-bare': { value: 'off' },
      'ai-logging:p-just-created': {
        value: 'off',
        metadata: { mode: 'off', at: NOW - AI_LOGGING_ORPHAN_GRACE_MS + 1_000 },
      },
      'ai-block:p-plan': { value: '1' },
    });
    const progress: Array<string> = [];

    const result = await projectPlatformAiLoggingConnection(connection, kv, {
      now: () => NOW,
      onProgress: (message) => progress.push(message),
    });

    expect(result).toEqual({ skipped: false, projects: 6, written: 4, deleted: 3 });
    expect(progress).toEqual(['Publishing AI logging settings (6 projects)']);
    expect(Object.fromEntries(store)).toEqual({
      'ai-logging:p-override': { value: 'off', metadata: { mode: 'off', at: NOW } },
      'ai-logging:p-plan': { value: 'metadata', metadata: { mode: 'metadata', at: NOW } },
      'ai-logging:p-wins': { value: 'full', metadata: { mode: 'full', at: NOW } },
      // A plan ID missing from the catalog follows the default plan (custom on installs).
      'ai-logging:p-legacy': { value: 'off', metadata: { mode: 'off', at: NOW } },
      // Too young to call an orphan: its create transaction may still commit.
      'ai-logging:p-just-created': {
        value: 'off',
        metadata: { mode: 'off', at: NOW - AI_LOGGING_ORPHAN_GRACE_MS + 1_000 },
      },
      'ai-block:p-plan': { value: '1' },
      // A project that now inherits leaves a short-lived marker so readback says pending.
      'ai-logging-cleared:p-stale': { value: 'inherit', metadata: { at: NOW } },
    });
    expect(Object.fromEntries(expirations)).toEqual({
      'ai-logging-cleared:p-stale': AI_LOGGING_CLEARED_TTL_SECONDS,
    });
  });

  it('stamps keys with the database clock, not the operator machine clock', async () => {
    await seed(`
      INSERT INTO users (id, login, plan) VALUES ('u1', 'one', 'free');
      INSERT INTO projects (id, user_id, slug) VALUES ('p1', 'u1', 'one');
      INSERT INTO project_ai_logging (project_id, mode) VALUES ('p1', 'off');
    `);
    // An orphan the API wrote 5 minutes ago by its own clock: inside the grace period.
    const { kv, store } = memoryKv({
      'ai-logging:p-young': { value: 'off', metadata: { mode: 'off', at: NOW - 300_000 } },
    });
    const databaseClock = {
      query: async (sql: string, values?: ReadonlyArray<unknown>) =>
        sql.includes('clock_timestamp()')
          ? { rows: [{ now: NOW }] }
          : connection.query(sql, values),
    } as QueryConnection;
    // The operator machine runs an hour fast.
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 3_600_000);
    try {
      await projectPlatformAiLoggingConnection(databaseClock, kv);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
    expect(Object.fromEntries(store)).toEqual({
      'ai-logging:p1': { value: 'off', metadata: { mode: 'off', at: NOW } },
      'ai-logging:p-young': { value: 'off', metadata: { mode: 'off', at: NOW - 300_000 } },
    });
  });

  it('reads the clock from a real database', async () => {
    await seed(`
      INSERT INTO users (id, login, plan) VALUES ('u1', 'one', 'free');
      INSERT INTO projects (id, user_id, slug) VALUES ('p1', 'u1', 'one');
      INSERT INTO project_ai_logging (project_id, mode) VALUES ('p1', 'off');
    `);
    const { kv, store } = memoryKv();
    const before = Date.now();
    await projectPlatformAiLoggingConnection(connection, kv);
    const { at } = store.get('ai-logging:p1')!.metadata as { at: number };
    expect(Number.isSafeInteger(at)).toBe(true);
    expect(at).toBeGreaterThanOrEqual(before - 60_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('holds the project row locks while it reads inputs and writes KV', async () => {
    await seed(`
      INSERT INTO users (id, login, plan) VALUES ('u1', 'one', 'free');
      INSERT INTO projects (id, user_id, slug) VALUES ('p1', 'u1', 'one'), ('p2', 'u1', 'two');
      INSERT INTO project_ai_logging (project_id, mode) VALUES ('p1', 'metadata');
    `);
    const statements: Array<string> = [];
    const { kv, calls } = memoryKv();
    const order: Array<string> = [];
    const wrapped: AiLoggingProjectionKv = {
      list: async (prefix) => {
        order.push('kv list');
        return kv.list(prefix);
      },
      put: async (entries) => {
        order.push('kv put');
        // The change the API saved while the projection waited for the lock is the
        // one written, because the inputs are read again under the lock.
        expect(entries).toEqual([
          { key: 'ai-logging:p1', value: 'off', metadata: { mode: 'off', at: NOW } },
        ]);
        return kv.put(entries);
      },
      delete: kv.delete,
    };
    const client = recording(statements, (sql) => {
      if (sql.includes('FOR NO KEY UPDATE')) {
        order.push('lock');
      } else if (sql === 'COMMIT') {
        order.push('commit');
      }
    });
    // Simulate the API saving a newer override just before the lock is granted.
    const lockingClient = {
      query: async (sql: string, values?: ReadonlyArray<unknown>) => {
        if (sql.includes('FOR NO KEY UPDATE')) {
          await connection.query(
            `UPDATE project_ai_logging SET mode = 'off' WHERE project_id = 'p1'`,
          );
        }
        return client.query(sql, values);
      },
    } as QueryConnection;

    await projectPlatformAiLoggingConnection(lockingClient, wrapped, { now: () => NOW });

    expect(order).toEqual(['kv list', 'lock', 'kv put', 'commit']);
    const lock = statements.find((sql) => sql.includes('FOR NO KEY UPDATE'))!;
    expect(lock).toContain('FROM "projects"');
    expect(lock).toContain('ORDER BY "id"');
    expect(statements[statements.indexOf('BEGIN') + 1]).toContain('lock_timeout');
    expect(calls).toEqual(['list', 'put']);
  });

  it('reads plan defaults again once the project row locks are held', async () => {
    await seed(`
      INSERT INTO users (id, login, plan) VALUES ('u1', 'one', 'pro');
      INSERT INTO projects (id, user_id, slug) VALUES ('p1', 'u1', 'one');
      INSERT INTO platform_settings (key, value) VALUES
        ('plans:ai-logging', '{"modes":{"pro":"metadata"},"publish":null}');
    `);
    const { kv, store } = memoryKv();
    // Simulate the API saving a newer plan default just before the lock is granted.
    const lockingClient = {
      query: async (sql: string, values?: ReadonlyArray<unknown>) => {
        if (sql.includes('FOR NO KEY UPDATE')) {
          await connection.query(
            `UPDATE platform_settings SET value = '{"modes":{"pro":"off"},"publish":null}'
              WHERE key = 'plans:ai-logging'`,
          );
        }
        return connection.query(sql, values);
      },
    } as QueryConnection;

    await projectPlatformAiLoggingConnection(lockingClient, kv, { now: () => NOW });

    expect(Object.fromEntries(store)).toEqual({
      'ai-logging:p1': { value: 'off', metadata: { mode: 'off', at: NOW } },
    });
  });

  it('rolls back and fails when a bulk write fails', async () => {
    await seed(`
      INSERT INTO users (id, login, plan) VALUES ('u1', 'one', 'free');
      INSERT INTO projects (id, user_id, slug) VALUES ('p1', 'u1', 'one');
      INSERT INTO project_ai_logging (project_id, mode) VALUES ('p1', 'off');
    `);
    const statements: Array<string> = [];
    const { kv } = memoryKv();
    const failing = {
      ...kv,
      put: vi.fn(async () => {
        throw new Error('KV down');
      }),
    };
    await expect(
      projectPlatformAiLoggingConnection(recording(statements), failing),
    ).rejects.toThrow('KV down');
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
  });

  it('changes nothing visible when run again', async () => {
    await seed(`
      INSERT INTO users (id, login, plan) VALUES ('u1', 'one', 'free');
      INSERT INTO projects (id, user_id, slug) VALUES ('p1', 'u1', 'one'), ('p2', 'u1', 'two');
      INSERT INTO project_ai_logging (project_id, mode) VALUES ('p1', 'full');
    `);
    const { kv, store } = memoryKv();
    await projectPlatformAiLoggingConnection(connection, kv, { now: () => NOW });
    const first = Object.fromEntries(store);
    await expect(
      projectPlatformAiLoggingConnection(connection, kv, { now: () => NOW }),
    ).resolves.toEqual({ skipped: false, projects: 1, written: 1, deleted: 0 });
    expect(Object.fromEntries(store)).toEqual(first);
    // Inherit projects never get a key.
    expect(store.has('ai-logging:p2')).toBe(false);
  });

  it('refuses to publish from invalid saved plan defaults', async () => {
    await seed(`INSERT INTO platform_settings (key, value)
      VALUES ('plans:ai-logging', '{"modes":{"pro":"loud"}}');`);
    const { kv, calls } = memoryKv();
    await expect(projectPlatformAiLoggingConnection(connection, kv)).rejects.toThrow(
      'The saved plan settings are not valid for this platform version',
    );
    expect(calls).toEqual(['list']);
  });

  it('runs through the database lock with a KV client bound to the routing namespace', async () => {
    const client = {
      listKvKeys: vi.fn(async () => []),
      putKvBulk: vi.fn(async () => {}),
      deleteKvBulk: vi.fn(async () => {}),
    };
    const progress: Array<string> = [];
    const publishAiLogging = vi.fn(async (kv: AiLoggingProjectionKv) => {
      await kv.list('ai-logging:');
      await kv.put([{ key: 'ai-logging:p1', value: 'off' }]);
      await kv.delete(['ai-logging:p2']);
      return { skipped: false as const, projects: 2, written: 1, deleted: 1 };
    });
    await publishInstallationAiLogging({
      client,
      accountId: 'account',
      routingKvId: 'routing',
      databaseLock: { publishAiLogging },
      onProgress: (message) => progress.push(message),
    });
    expect(progress).toEqual(['Publishing AI logging settings']);
    expect(client.listKvKeys).toHaveBeenCalledWith('account', 'routing', 'ai-logging:');
    expect(client.putKvBulk).toHaveBeenCalledWith('account', 'routing', [
      { key: 'ai-logging:p1', value: 'off' },
    ]);
    expect(client.deleteKvBulk).toHaveBeenCalledWith('account', 'routing', ['ai-logging:p2']);
    await expect(
      publishInstallationAiLogging({
        client,
        accountId: 'account',
        routingKvId: 'routing',
        databaseLock: {},
      }),
    ).resolves.toBeNull();
  });
});
