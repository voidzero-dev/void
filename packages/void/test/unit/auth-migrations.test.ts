import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';
import type { DBFieldAttribute } from 'better-auth/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { VoidAuthMigrationSchema } from '../../src/auth/drizzle.ts';
import { resolveVoidAuthMigrationSchema } from '../../src/auth/drizzle.ts';
import { runLocalVoidAuthMigrations } from '../../src/auth/node.ts';
import { getMiniflareDatabasePath } from '../../src/migrations/runner.ts';
import {
  applyMySqlAuthMigrations,
  applyPgAuthMigrations,
  applySqliteAuthMigrations,
  pgMigrationRunner,
} from '../../src/runtime/auth/migrations.ts';

// PGlite serves the `pg` clients, and each client records the database it names.
const state = vi.hoisted(() => ({ pg: null as PGlite | null, connections: [] as Array<string> }));
vi.mock('pg', () => ({
  Client: class {
    constructor(options: { connectionString: string }) {
      state.connections.push(options.connectionString);
    }
    async connect() {}
    async end() {}
    query(sql: string, params?: Array<unknown>) {
      return state.pg!.query(sql, params);
    }
  },
}));

beforeAll(async () => {
  // Load PostgreSQL once: Windows' cold WASM startup belongs to the hook budget.
  state.pg = new PGlite();
  await state.pg.waitReady;
}, 30_000);
beforeEach(async () => {
  await state.pg!.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
});
afterAll(async () => {
  await state.pg?.close();
  state.pg = null;
});

function resolveWithUserFields(
  dialect: VoidAuthMigrationSchema['dialect'],
  additionalFields: Record<string, DBFieldAttribute> = {},
): VoidAuthMigrationSchema {
  return resolveVoidAuthMigrationSchema({
    dialect,
    providers: null,
    userConfig: ({ defaults }) => ({ ...defaults, user: { additionalFields } }),
  });
}

function sqliteRunner(db: DatabaseSync) {
  return {
    async all<T extends Record<string, unknown>>(sql: string) {
      return db.prepare(sql).all() as Array<T>;
    },
    async run(sql: string) {
      db.prepare(sql).run();
    },
  };
}

function sqliteColumns(db: DatabaseSync, table: string): Array<string> {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

describe('auth migration runner', () => {
  it.each(['sqlite', 'postgresql', 'mysql'] as const)(
    'creates plugin table indexes idempotently on fresh and existing %s tables',
    async (dialect) => {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(':memory:');
      const statements: Array<string> = [];
      const mysqlIndexes = new Set<string>();
      const mysqlTables = new Set<string>();
      const schema = resolveVoidAuthMigrationSchema({
        dialect,
        providers: null,
        userConfig: {
          user: { modelName: 'members', fields: { createdAt: 'joined_at' } },
          plugins: [
            {
              id: 'table-indexes',
              schema: {
                user: {
                  fields: {},
                  indexes: [
                    { name: 'members_joined_idx', fields: ['createdAt'] as const },
                    {
                      name: 'members_name_joined_uidx',
                      fields: ['name', 'createdAt'] as const,
                      unique: true,
                    },
                  ],
                },
              },
            },
          ],
        },
      });
      const mysqlRunner = {
        async all<T extends Record<string, unknown>>(sql: string, params?: Array<unknown>) {
          if (sql.includes('SELECT DATABASE()')) {
            return [{ database_name: 'app' }] as unknown as Array<T>;
          }
          if (sql.includes('information_schema.tables')) {
            return [...mysqlTables].map((table_name) => ({ table_name })) as unknown as Array<T>;
          }
          if (sql.includes('information_schema.columns')) {
            return [
              'id',
              ...Object.keys(schema.tables.find((table) => table.name === params?.[1])!.fields),
            ].map((column_name) => ({ column_name, data_type: 'varchar' })) as unknown as Array<T>;
          }
          if (sql.includes('information_schema.statistics')) {
            return [...mysqlIndexes].map((index_name) => ({ index_name })) as unknown as Array<T>;
          }
          return [] as Array<T>;
        },
        async run(sql: string) {
          statements.push(sql);
          const table = sql.match(/^CREATE TABLE(?: IF NOT EXISTS)? `([^`]+)`/);
          if (table) {
            expect(mysqlTables.has(table[1])).toBe(false);
            mysqlTables.add(table[1]);
          }
          const index = sql.match(/^CREATE (?:UNIQUE )?INDEX `([^`]+)`/);
          if (index) {
            mysqlIndexes.add(index[1]);
          }
        },
      };
      const apply = (target: VoidAuthMigrationSchema) =>
        dialect === 'sqlite'
          ? applySqliteAuthMigrations(sqliteRunner(db), target)
          : dialect === 'postgresql'
            ? applyPgAuthMigrations(pgMigrationRunner(state.pg!), target)
            : applyMySqlAuthMigrations(mysqlRunner, target);
      try {
        for (const existing of [false, true]) {
          db.exec(
            'DROP TABLE IF EXISTS session; DROP TABLE IF EXISTS account; DROP TABLE IF EXISTS members; DROP TABLE IF EXISTS verification',
          );
          await state.pg!.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
          mysqlIndexes.clear();
          mysqlTables.clear();
          statements.length = 0;
          if (existing) {
            await apply(
              resolveVoidAuthMigrationSchema({
                dialect,
                providers: null,
                userConfig: { user: { modelName: 'members', fields: { createdAt: 'joined_at' } } },
              }),
            );
          }
          await apply(schema);
          await apply(schema);
          if (dialect === 'sqlite') {
            expect(db.prepare("PRAGMA index_list('members')").all()).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ name: 'members_joined_idx', unique: 0 }),
                expect.objectContaining({ name: 'members_name_joined_uidx', unique: 1 }),
                expect.objectContaining({ name: 'members_email_uidx', unique: 1 }),
              ]),
            );
            expect(
              db
                .prepare("PRAGMA index_info('members_name_joined_uidx')")
                .all()
                .map((column) => column.name),
            ).toEqual(['name', 'joined_at']);
          } else if (dialect === 'postgresql') {
            const indexes = (
              await state.pg!.query<{ indexname: string; indexdef: string }>(
                "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'members'",
              )
            ).rows;
            expect(indexes).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ indexname: 'members_joined_idx' }),
                expect.objectContaining({
                  indexname: 'members_name_joined_uidx',
                  indexdef: expect.stringContaining('UNIQUE INDEX'),
                }),
                expect.objectContaining({ indexname: 'members_email_uidx' }),
              ]),
            );
            expect(
              indexes.find((index) => index.indexname === 'members_name_joined_uidx')?.indexdef,
            ).toContain('(name, joined_at)');
          } else {
            expect(statements.filter((sql) => sql.includes('`members_joined_idx`'))).toEqual([
              'CREATE INDEX `members_joined_idx` ON `members` (`joined_at`)',
            ]);
            expect(statements.filter((sql) => sql.includes('`members_name_joined_uidx`'))).toEqual([
              'CREATE UNIQUE INDEX `members_name_joined_uidx` ON `members` (`name`, `joined_at`)',
            ]);
          }
        }
      } finally {
        db.close();
      }
    },
  );

  it('applies the sqlite auth schema idempotently', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    const schema = resolveVoidAuthMigrationSchema({
      dialect: 'sqlite',
      providers: null,
    });

    try {
      const runner = {
        async all<T extends Record<string, unknown>>(sql: string) {
          return db.prepare(sql).all() as Array<T>;
        },
        async run(sql: string) {
          db.prepare(sql).run();
        },
      };

      await applySqliteAuthMigrations(runner, schema);
      await applySqliteAuthMigrations(runner, schema);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const sessionIndexes = db.prepare('PRAGMA index_list("session")').all() as Array<{
        name: string;
      }>;

      expect(tables.map((table) => table.name)).toEqual([
        'account',
        'session',
        'user',
        'verification',
      ]);
      expect(sessionIndexes.some((index) => index.name === 'session_userId_idx')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('uses identity columns for postgres serial auth ids', async () => {
    const statements: Array<string> = [];
    const schema: VoidAuthMigrationSchema = {
      dialect: 'postgresql',
      idStrategy: 'serial',
      tables: [
        {
          name: 'user',
          order: 0,
          fields: {
            email: {
              type: 'string',
              required: true,
              unique: true,
              index: false,
              bigint: false,
            },
          },
        },
      ],
    };

    await applyPgAuthMigrations(
      {
        async all<T extends Record<string, unknown>>(sql: string) {
          if (sql.includes('current_schema')) {
            return [{ schema: 'public' }] as unknown as Array<T>;
          }
          return [] as Array<T>;
        },
        async run(sql: string) {
          statements.push(sql);
        },
      },
      schema,
    );

    expect(statements[0]).toContain(
      '"id" integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY NOT NULL',
    );
    expect(statements[1]).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "user_email_uidx" ON "user" ("email")',
    );
  });

  it('gives postgres uuid auth ids a random default', async () => {
    const statements: Array<string> = [];
    const schema = resolveVoidAuthMigrationSchema({
      dialect: 'postgresql',
      providers: null,
      userConfig: ({ defaults }) => ({
        ...defaults,
        advanced: { database: { generateId: 'uuid' } },
      }),
    });

    await applyPgAuthMigrations(
      {
        async all<T extends Record<string, unknown>>(sql: string) {
          if (sql.includes('current_schema')) {
            return [{ schema: 'public' }] as unknown as Array<T>;
          }
          return [] as Array<T>;
        },
        async run(sql: string) {
          statements.push(sql);
        },
      },
      schema,
    );

    const session = statements.find(
      (sql) => sql.startsWith('CREATE TABLE') && sql.includes('"session"'),
    );
    expect(session).toContain('"id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL');
    expect(session).toContain('"userId" uuid NOT NULL REFERENCES');
  });

  it('uses string-literal table names for sqlite PRAGMA introspection', async () => {
    const reads: Array<string> = [];

    await applySqliteAuthMigrations(
      {
        async all<T extends Record<string, unknown>>(sql: string) {
          reads.push(sql);
          if (sql === "SELECT name FROM sqlite_master WHERE type = 'table'") {
            return [{ name: 'user' }] as unknown as Array<T>;
          }
          if (sql === "PRAGMA table_info('user')") {
            return [{ name: 'id' }] as unknown as Array<T>;
          }
          return [] as Array<T>;
        },
        async run() {},
      },
      {
        dialect: 'sqlite',
        idStrategy: 'text',
        tables: [
          {
            name: 'user',
            order: 0,
            fields: {},
          },
        ],
      },
    );

    expect(reads).toContain("PRAGMA table_info('user')");
    expect(reads).toContain("PRAGMA index_list('user')");
    expect(reads).not.toContain('PRAGMA table_info("user")');
    expect(reads).not.toContain('PRAGMA index_list("user")');
  });

  it('creates MySQL OAuth token columns as unbounded text', async () => {
    const statements: Array<string> = [];
    const schema = resolveVoidAuthMigrationSchema({
      dialect: 'mysql',
      providers: ['google'],
      userConfig: ({ defaults }) => ({
        ...defaults,
        account: { fields: { idToken: 'google_id_token' } },
      }),
    });

    await applyMySqlAuthMigrations(
      {
        async all<T extends Record<string, unknown>>(sql: string) {
          if (sql.includes('SELECT DATABASE()')) {
            return [{ database_name: 'app' }] as unknown as Array<T>;
          }
          return [] as Array<T>;
        },
        async run(sql: string) {
          statements.push(sql);
        },
      },
      schema,
    );

    const account = statements.find(
      (sql) => sql.startsWith('CREATE TABLE') && sql.includes('`account`'),
    );
    const user = statements.find((sql) => sql.startsWith('CREATE TABLE') && sql.includes('`user`'));
    expect(account).toContain('`accessToken` text');
    expect(account).toContain('`refreshToken` text');
    expect(account).toContain('`google_id_token` text');
    expect(account).toContain('`userId` varchar(255)');
    expect(user).toContain('`email` varchar(255) NOT NULL');
  });

  it('widens existing renamed MySQL OAuth token columns without changing indexed strings', async () => {
    const statements: Array<string> = [];
    const resolved = resolveVoidAuthMigrationSchema({
      dialect: 'mysql',
      providers: ['google'],
      userConfig: ({ defaults }) => ({
        ...defaults,
        account: { fields: { idToken: 'google_id_token' } },
      }),
    });
    const account = resolved.tables.find((table) => table.name === 'account')!;
    const schema: VoidAuthMigrationSchema = { ...resolved, tables: [account] };
    const columnTypes = new Map([
      ['id', 'varchar'],
      ...Object.keys(account.fields).map((fieldName) => [fieldName, 'varchar'] as const),
    ]);

    const runner = {
      async all<T extends Record<string, unknown>>(sql: string) {
        if (sql.includes('SELECT DATABASE()')) {
          return [{ database_name: 'app' }] as unknown as Array<T>;
        }
        if (sql.includes('information_schema.tables')) {
          return [{ table_name: 'account' }] as unknown as Array<T>;
        }
        if (sql.includes('information_schema.columns')) {
          return [...columnTypes].map(([column_name, data_type]) => ({
            column_name,
            data_type,
            character_maximum_length: data_type === 'varchar' ? 255 : 65_535,
          })) as unknown as Array<T>;
        }
        if (sql.includes('information_schema.statistics')) {
          return [{ index_name: 'account_userId_idx' }] as unknown as Array<T>;
        }
        return [] as Array<T>;
      },
      async run(sql: string) {
        statements.push(sql);
        const changedColumn = sql.match(/MODIFY COLUMN `([^`]+)` text$/)?.[1];
        if (changedColumn) {
          columnTypes.set(changedColumn, 'text');
        }
      },
    };

    await applyMySqlAuthMigrations(runner, schema);
    await applyMySqlAuthMigrations(runner, schema);

    expect(statements).toEqual([
      'ALTER TABLE `account` MODIFY COLUMN `accessToken` text',
      'ALTER TABLE `account` MODIFY COLUMN `refreshToken` text',
      'ALTER TABLE `account` MODIFY COLUMN `google_id_token` text',
    ]);
    expect(statements.some((sql) => sql.includes('`userId`'))).toBe(false);
  });

  it('re-runs MySQL auth migrations against MySQL 8 uppercase information_schema labels', async () => {
    const statements: Array<string> = [];
    const resolved = resolveVoidAuthMigrationSchema({ dialect: 'mysql', providers: null });
    const user = resolved.tables.find((table) => table.name === 'user')!;
    const schema: VoidAuthMigrationSchema = {
      ...resolved,
      tables: [
        {
          ...user,
          fields: {
            ...user.fields,
            nickname: {
              type: 'string',
              required: false,
              unique: false,
              index: false,
              bigint: false,
            },
          },
        },
      ],
    };
    // MySQL 8 labels an unaliased information_schema column with its uppercase name.
    const row = (sql: string, values: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(values).map(([column, value]) => [
          new RegExp(`\\bAS ${column}\\b`).test(sql) ? column : column.toUpperCase(),
          value,
        ]),
      );

    await applyMySqlAuthMigrations(
      {
        async all<T extends Record<string, unknown>>(sql: string) {
          if (sql.includes('SELECT DATABASE()')) {
            return [row(sql, { database_name: 'app' })] as unknown as Array<T>;
          }
          if (sql.includes('information_schema.tables')) {
            return [row(sql, { table_name: 'user' })] as unknown as Array<T>;
          }
          if (sql.includes('information_schema.columns')) {
            return ['id', ...Object.keys(user.fields)].map((column_name) =>
              row(sql, { column_name, data_type: 'varchar' }),
            ) as unknown as Array<T>;
          }
          if (sql.includes('information_schema.statistics')) {
            return ['PRIMARY', 'user_email_uidx'].map((index_name) =>
              row(sql, { index_name }),
            ) as unknown as Array<T>;
          }
          return [] as Array<T>;
        },
        async run(sql: string) {
          statements.push(sql);
        },
      },
      schema,
    );

    expect(statements).toEqual(['ALTER TABLE `user` ADD COLUMN `nickname` varchar(255)']);
  });

  it('fills rows that exist with the fixed default of a new required field (sqlite)', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
      const runner = sqliteRunner(db);
      await applySqliteAuthMigrations(runner, resolveWithUserFields('sqlite'));
      db.prepare(
        "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u1', 'A', 'a@example.com', 0, 0, 0)",
      ).run();

      await applySqliteAuthMigrations(
        runner,
        resolveWithUserFields('sqlite', {
          plan: { type: 'string', defaultValue: 'free' },
          banned: { type: 'boolean', defaultValue: false },
          credits: { type: 'number', defaultValue: -3 },
        }),
      );

      expect(db.prepare('SELECT plan, banned, credits FROM user').get()).toEqual({
        plan: 'free',
        banned: 0,
        credits: -3,
      });
    } finally {
      db.close();
    }
  });

  it('fills rows that exist with the fixed default of a new required field (postgres)', async () => {
    const pg = state.pg!;
    const runner = pgMigrationRunner(pg);
    // With standard_conforming_strings off, a backslash in '...' starts an escape.
    for (const mode of ['on', 'off']) {
      await pg.exec(
        `DROP SCHEMA public CASCADE; CREATE SCHEMA public; SET standard_conforming_strings = ${mode}`,
      );
      try {
        await applyPgAuthMigrations(runner, resolveWithUserFields('postgresql'));
        await pg.query(
          `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('u1', 'A', 'a@example.com', false, now(), now())`,
        );

        await applyPgAuthMigrations(
          runner,
          resolveWithUserFields('postgresql', {
            plan: { type: 'string', defaultValue: "it's free" },
            motto: { type: 'string', defaultValue: "it's a\\b" },
            folder: { type: 'string', defaultValue: 'end\\' },
            banned: { type: 'boolean', defaultValue: true },
          }),
        );

        expect(
          (await pg.query('SELECT plan, motto, folder, banned FROM "user"')).rows,
          `standard_conforming_strings = ${mode}`,
        ).toEqual([{ plan: "it's free", motto: "it's a\\b", folder: 'end\\', banned: true }]);
      } finally {
        await pg.exec('RESET standard_conforming_strings');
      }
    }
  });

  it('refuses a required field without a default only when the table has rows', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
      const runner = sqliteRunner(db);
      await applySqliteAuthMigrations(runner, resolveWithUserFields('sqlite'));
      // An empty table takes the column: no row needs a value.
      await applySqliteAuthMigrations(
        runner,
        resolveWithUserFields('sqlite', { nickname: { type: 'string' } }),
      );
      expect(sqliteColumns(db, 'user')).toContain('nickname');
      db.prepare(
        "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, nickname) VALUES ('u1', 'A', 'a@example.com', 0, 0, 0, 'a')",
      ).run();

      await expect(
        applySqliteAuthMigrations(
          runner,
          resolveWithUserFields('sqlite', {
            nickname: { type: 'string' },
            plan: { type: 'string' },
          }),
        ),
      ).rejects.toThrow(
        'Cannot add required auth field "plan" to table "user": the table has rows, and there is no fixed default value to fill them. Set `required: false` on the field.',
      );
      expect(sqliteColumns(db, 'user')).not.toContain('plan');
    } finally {
      db.close();
    }
  });

  it('refuses a required postgres field without a default when the table has rows', async () => {
    const pg = state.pg!;
    const runner = pgMigrationRunner(pg);
    await applyPgAuthMigrations(runner, resolveWithUserFields('postgresql'));
    await pg.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('u1', 'A', 'a@example.com', false, now(), now())`,
    );

    await expect(
      applyPgAuthMigrations(
        runner,
        resolveWithUserFields('postgresql', { plan: { type: 'string' } }),
      ),
    ).rejects.toThrow(
      'Cannot add required auth field "plan" to table "user": the table has rows, and there is no fixed default value to fill them. Set `required: false` on the field.',
    );
    const columns = await pg.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'user'",
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain('plan');
  });

  it('refuses a required unique field only when the table has more than one row', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
      const runner = sqliteRunner(db);
      await applySqliteAuthMigrations(runner, resolveWithUserFields('sqlite'));
      db.prepare(
        "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u1', 'A', 'a@example.com', 0, 0, 0)",
      ).run();
      // One row can take the default of a unique field.
      await applySqliteAuthMigrations(
        runner,
        resolveWithUserFields('sqlite', {
          code: { type: 'string', unique: true, defaultValue: 'a' },
        }),
      );
      expect(sqliteColumns(db, 'user')).toContain('code');
      db.prepare(
        "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, code) VALUES ('u2', 'B', 'b@example.com', 0, 0, 0, 'b')",
      ).run();

      await expect(
        applySqliteAuthMigrations(
          runner,
          resolveWithUserFields('sqlite', {
            code: { type: 'string', unique: true, defaultValue: 'a' },
            handle: { type: 'string', unique: true, defaultValue: 'x' },
          }),
        ),
      ).rejects.toThrow(
        'Cannot add required unique auth field "handle" to table "user": the table has more than one row, and a new column gives every row the same value. Set `required: false` on the field, or add the column in a migration that gives each row its own value.',
      );
      expect(sqliteColumns(db, 'user')).not.toContain('handle');
    } finally {
      db.close();
    }
  });

  it('adds a new required MySQL column with its fixed default', async () => {
    const statements: Array<string> = [];
    const resolved = resolveWithUserFields('mysql', {
      plan: { type: 'string', defaultValue: 'free' },
      motto: { type: 'string', defaultValue: "it's a\\b" },
      nickname: { type: 'string' },
    });
    const user = resolved.tables.find((table) => table.name === 'user')!;
    const existing = ['id', 'name', 'email', 'emailVerified', 'image', 'createdAt', 'updatedAt'];

    await applyMySqlAuthMigrations(
      {
        async all<T extends Record<string, unknown>>(sql: string) {
          if (sql.includes('SELECT DATABASE()')) {
            return [{ database_name: 'app' }] as unknown as Array<T>;
          }
          if (sql.includes('information_schema.tables')) {
            return [{ table_name: 'user' }] as unknown as Array<T>;
          }
          if (sql.includes('information_schema.columns')) {
            return existing.map((column_name) => ({
              column_name,
              data_type: 'varchar',
            })) as unknown as Array<T>;
          }
          if (sql.includes('information_schema.statistics')) {
            return [{ index_name: 'user_email_uidx' }] as unknown as Array<T>;
          }
          // The user table has rows.
          return [{ present: 1 }] as unknown as Array<T>;
        },
        async run(sql: string) {
          statements.push(sql);
        },
      },
      { ...resolved, tables: [user] },
    );

    expect(statements).toEqual([
      "ALTER TABLE `user` ADD COLUMN `plan` varchar(255) NOT NULL DEFAULT 'free'",
      // A hex string keeps the backslash when the server sets NO_BACKSLASH_ESCAPES.
      "ALTER TABLE `user` ADD COLUMN `motto` varchar(255) NOT NULL DEFAULT _utf8mb4 X'6974277320615c62'",
      'ALTER TABLE `user` ADD COLUMN `nickname` varchar(255) NOT NULL',
    ]);
  });

  it('refuses a required unique MySQL field when the table has more than one row', async () => {
    const statements: Array<string> = [];
    const resolved = resolveWithUserFields('mysql', {
      code: { type: 'string', unique: true, defaultValue: 'x' },
      handle: { type: 'string', unique: true },
    });
    const user = resolved.tables.find((table) => table.name === 'user')!;
    const existing = ['id', 'name', 'email', 'emailVerified', 'image', 'createdAt', 'updatedAt'];

    await expect(
      applyMySqlAuthMigrations(
        {
          async all<T extends Record<string, unknown>>(sql: string) {
            if (sql.includes('SELECT DATABASE()')) {
              return [{ database_name: 'app' }] as unknown as Array<T>;
            }
            if (sql.includes('information_schema.tables')) {
              return [{ table_name: 'user' }] as unknown as Array<T>;
            }
            if (sql.includes('information_schema.columns')) {
              return existing.map((column_name) => ({
                column_name,
                data_type: 'varchar',
              })) as unknown as Array<T>;
            }
            if (sql === 'SELECT 1 AS present FROM `user` LIMIT 2') {
              return [{ present: 1 }, { present: 1 }] as unknown as Array<T>;
            }
            return [] as Array<T>;
          },
          async run(sql: string) {
            statements.push(sql);
          },
        },
        { ...resolved, tables: [user] },
      ),
    ).rejects.toThrow(
      'Cannot add required unique auth fields "code", "handle" to table "user": the table has more than one row, and a new column gives every row the same value. Set `required: false` on the fields, or add the columns in a migration that gives each row its own value.',
    );
    expect(statements).toEqual([]);
  });
});

describe('runLocalVoidAuthMigrations', () => {
  // This test writes a SQLite file on disk. Windows CI disk writes can stall for 30 seconds.
  it(
    'creates the local D1 directory on the first dev run',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'void-auth-migrations-'));
      try {
        const persistRoot = join(root, '.void');
        await runLocalVoidAuthMigrations(root, 'sqlite', persistRoot, 'local', null);

        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(getMiniflareDatabasePath(persistRoot, 'local'));
        try {
          const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .all() as Array<{ name: string }>;
          expect(tables.map((table) => table.name)).toEqual([
            'account',
            'session',
            'user',
            'verification',
          ]);
        } finally {
          db.close();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    process.platform === 'win32' ? 60_000 : undefined,
  );

  // An empty DATABASE_URL in the shell counts as unset, so the one in .env is used.
  it('uses DATABASE_URL from .env when the shell value is empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-auth-migrations-'));
    writeFileSync(join(root, '.env'), 'DATABASE_URL=postgres://localhost/app\n');
    vi.stubEnv('DATABASE_URL', '');
    state.connections.length = 0;
    try {
      await runLocalVoidAuthMigrations(root, 'postgresql', join(root, '.void'), 'local', null);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }

    expect(state.connections).toEqual(['postgres://localhost/app']);
    const tables = await state.pg!.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'account',
      'session',
      'user',
      'verification',
    ]);
  });

  it('gives a function-form config the DATABASE_URL that the migration uses', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-auth-migrations-'));
    writeFileSync(join(root, '.env'), 'DATABASE_URL=postgres://localhost/app\n');
    const configPath = join(root, 'auth.mjs');
    writeFileSync(
      configPath,
      'export default ({ defaults, env }) => { globalThis.authConfigDatabaseUrl = env.DATABASE_URL; return defaults; };',
    );
    vi.stubEnv('DATABASE_URL', '');
    const recorded = globalThis as { authConfigDatabaseUrl?: unknown };
    try {
      await runLocalVoidAuthMigrations(
        root,
        'postgresql',
        join(root, '.void'),
        'local',
        configPath,
      );
      expect(recorded.authConfigDatabaseUrl).toBe('postgres://localhost/app');
    } finally {
      delete recorded.authConfigDatabaseUrl;
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
