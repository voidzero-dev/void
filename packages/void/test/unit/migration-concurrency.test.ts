import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { buildMigrationPlanBundle } from '../../src/migrations/plan.ts';
import { createMigrationHandler } from '../../src/runtime/db/migrations/d1-handler.ts';
import type {
  MigrationEntry,
  MigrationResponse,
} from '../../src/runtime/db/migrations/d1-handler.ts';

const databases: Array<DatabaseSync> = [];
afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createDatabase(
  hooks: {
    beforeBatch?: (sql: Array<string>) => Promise<void>;
    afterLockWrite?: () => Promise<void>;
  } = {},
) {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  sqlite.exec('CREATE TABLE balance (amount INTEGER); INSERT INTO balance VALUES (100);');
  const prepare = (sql: string) => {
    let params: Array<SQLInputValue> = [];
    return {
      sql,
      get params() {
        return params;
      },
      bind(...values: Array<SQLInputValue>) {
        params = values;
        return this;
      },
      async run() {
        const result = sqlite.prepare(sql).run(...params);
        if (sql.startsWith('INSERT INTO _void_migration_lock')) {
          await hooks.afterLockWrite?.();
        }
        return result;
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...params) };
      },
      async first() {
        return sqlite.prepare(sql).get(...params) ?? null;
      },
    };
  };
  const db = {
    prepare,
    async exec(sql: string) {
      sqlite.exec(sql);
    },
    async batch(statements: Array<ReturnType<typeof prepare>>) {
      await hooks.beforeBatch?.(statements.map((statement) => statement.sql));
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((statement) =>
          sqlite.prepare(statement.sql).run(...statement.params),
        );
        sqlite.exec('COMMIT');
        if (
          statements.some((statement) =>
            statement.sql.startsWith('INSERT INTO _void_migration_lock'),
          )
        ) {
          await hooks.afterLockWrite?.();
        }
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  const handler = (migrations: Array<MigrationEntry>) =>
    createMigrationHandler(
      { DB: db, __VOID_PROXY_TOKEN: 'test-token' },
      migrations,
      undefined,
      buildMigrationPlanBundle(migrations),
    );
  return { sqlite, handler };
}

const migrations = [{ name: '0001_debit.sql', sql: 'UPDATE balance SET amount = amount - 10;' }];
function apply(attemptId: string) {
  return new Request('https://example.test/__void/migrate/app', {
    method: 'POST',
    headers: { 'x-void-internal': 'test-token' },
    body: JSON.stringify({ attemptId }),
  });
}
function reconcile(attemptId: string) {
  return new Request(`https://example.test/__void/migrate/app/attempt/${attemptId}`, {
    headers: { 'x-void-internal': 'test-token' },
  });
}

describe('D1 migration ownership', () => {
  it('reconciles the committed prefix and retries remaining migrations under a new owner', async () => {
    const paused = deferred();
    const resume = deferred();
    const second = { name: '0002_debit.sql', sql: 'UPDATE balance SET amount = amount - 20;' };
    let once = true;
    const { sqlite, handler } = createDatabase({
      beforeBatch: async (sql) => {
        if (once && sql.includes(second.sql)) {
          once = false;
          paused.resolve();
          await resume.promise;
        }
      },
    });
    const owner = handler([...migrations, second]);
    const pending = owner(apply('owner'));
    await paused.promise;
    try {
      const recovered = await (await owner(reconcile('owner'))).json<MigrationResponse>();
      expect(recovered.ok).toBe(false);
      expect(recovered.confirmedSkipped).toEqual(['0001_debit.sql']);
      const successor = await (await owner(apply('successor'))).json<MigrationResponse>();
      expect(successor.ok).toBe(true);
      expect(successor.confirmedApplied).toEqual(['0002_debit.sql']);
      expect(successor.confirmedSkipped).toEqual(['0001_debit.sql']);
    } finally {
      resume.resolve();
      await pending;
    }
    expect(sqlite.prepare('SELECT amount FROM balance').get()?.amount).toBe(70);
    expect(
      sqlite.prepare("SELECT status FROM _void_migration_attempts WHERE attempt_id = 'owner'").get()
        ?.status,
    ).toBe('unknown');
  });

  it('keeps the lock while an unfenced legacy migration is in flight', async () => {
    const paused = deferred();
    const resume = deferred();
    const { sqlite, handler } = createDatabase({
      beforeBatch: async (sql) => {
        if (sql.includes('UPDATE balance SET amount = amount - 10;')) {
          paused.resolve();
          await resume.promise;
        }
      },
    });
    const owner = handler([
      {
        name: 'legacy.sql',
        sql: 'UPDATE balance SET amount = amount - 10; UPDATE balance SET amount = amount - 10;',
      },
    ]);
    const pending = owner(apply('legacy'));
    await paused.promise;
    try {
      const recovered = await (await owner(reconcile('legacy'))).json<MigrationResponse>();
      expect(recovered.error).toContain(
        'wait for this migration to finish before retrying recovery',
      );
      expect(
        sqlite
          .prepare("SELECT status FROM _void_migration_attempts WHERE attempt_id = 'legacy'")
          .get()?.status,
      ).toBe('running');
      expect((await handler([])(apply('contender'))).status).toBe(409);
    } finally {
      resume.resolve();
      await pending;
    }
    expect(sqlite.prepare('SELECT amount FROM balance').get()?.amount).toBe(80);
    expect((await handler([])(apply('successor'))).status).toBe(200);
  });

  it('applies splittable SQL without warning about missing statement breakpoints', async () => {
    const { handler } = createDatabase();
    const owner = handler([
      {
        name: 'legacy.sql',
        sql: 'UPDATE balance SET amount = amount - 10; UPDATE balance SET amount = amount - 10;',
      },
    ]);
    const first = await (await owner(apply('first'))).json<MigrationResponse>();
    expect(first.confirmedApplied).toEqual(['legacy.sql']);
    expect(first.warnings ?? []).toEqual([]);
    const later = await (await owner(apply('later'))).json<MigrationResponse>();
    expect(later.confirmedSkipped).toEqual(['legacy.sql']);
    expect(later.warnings ?? []).toEqual([]);
  });

  it('warns about compound SQL only while the migration is pending', async () => {
    const { handler } = createDatabase();
    const owner = handler([
      {
        name: 'trigger.sql',
        sql: 'CREATE TRIGGER balance_change AFTER UPDATE ON balance BEGIN SELECT 1; END;',
      },
    ]);
    const first = await (await owner(apply('first'))).json<MigrationResponse>();
    expect(first.confirmedApplied).toEqual(['trigger.sql']);
    expect(first.warnings).toEqual([
      'Add a `--> statement-breakpoint` line after each complete SQL statement in migration trigger.sql.',
    ]);
    const later = await (await owner(apply('later'))).json<MigrationResponse>();
    expect(later.confirmedSkipped).toEqual(['trigger.sql']);
    expect(later.warnings ?? []).toEqual([]);
  });

  it('keeps completed attempts idempotent and rolls back failing migration batches', async () => {
    const { sqlite, handler } = createDatabase();
    const owner = handler(migrations);
    expect((await owner(apply('complete'))).status).toBe(200);
    expect((await owner(apply('complete'))).status).toBe(200);
    expect((await owner(reconcile('complete'))).status).toBe(200);
    const failing = handler([
      {
        name: '0002_fail.sql',
        sql: 'UPDATE balance SET amount = amount - 20;\n--> statement-breakpoint\nINSERT INTO missing_table VALUES (1);',
      },
    ]);
    expect((await failing(apply('failure'))).status).toBe(500);
    expect(sqlite.prepare('SELECT amount FROM balance').get()?.amount).toBe(90);
    expect(
      sqlite.prepare("SELECT name FROM _void_migrations WHERE name = '0002_fail.sql'").get(),
    ).toBeUndefined();
    expect((await handler([])(apply('successor'))).status).toBe(200);
  });

  it('prevents a recovered executor from applying SQL after its successor finishes', async () => {
    const paused = deferred();
    const resume = deferred();
    const { sqlite, handler } = createDatabase({
      beforeBatch: async (sql) => {
        if (sql.includes(migrations[0].sql)) {
          paused.resolve();
          await resume.promise;
        }
      },
    });
    const owner = handler(migrations);
    const pending = owner(apply('owner'));
    await paused.promise;
    try {
      expect((await owner(reconcile('owner'))).status).toBe(409);
      // A later deployment no longer contains the abandoned migration.
      expect((await handler([])(apply('successor'))).status).toBe(200);
    } finally {
      resume.resolve();
    }
    const result = await pending;
    expect(sqlite.prepare('SELECT amount FROM balance').get()?.amount).toBe(100);
    expect((await result.json<MigrationResponse>()).ok).toBe(false);
  });

  it('does not release ownership when the same attempt is submitted again', async () => {
    const paused = deferred();
    const resume = deferred();
    const { sqlite, handler } = createDatabase({
      beforeBatch: async (sql) => {
        if (sql.includes(migrations[0].sql)) {
          paused.resolve();
          await resume.promise;
        }
      },
    });
    const owner = handler(migrations);
    const pending = owner(apply('owner'));
    await paused.promise;
    try {
      expect((await owner(apply('owner'))).status).toBe(409);
      expect((await handler([])(apply('contender'))).status).toBe(409);
    } finally {
      resume.resolve();
      await pending;
    }
    expect(sqlite.prepare('SELECT amount FROM balance').get()?.amount).toBe(90);
  });

  it('publishes the attempt and its lock atomically', async () => {
    const paused = deferred();
    const resume = deferred();
    let once = true;
    const { sqlite, handler } = createDatabase({
      afterLockWrite: async () => {
        if (once) {
          once = false;
          paused.resolve();
          await resume.promise;
        }
      },
    });
    const owner = handler(migrations);
    const pending = owner(apply('owner'));
    await paused.promise;
    try {
      // The contender gets 409 with or without the owner's attempt row, so check the row too.
      expect(
        sqlite
          .prepare("SELECT status FROM _void_migration_attempts WHERE attempt_id = 'owner'")
          .get(),
      ).toEqual({ status: 'running' });
      expect((await handler([])(apply('contender'))).status).toBe(409);
    } finally {
      resume.resolve();
      await pending;
    }
  });
});
