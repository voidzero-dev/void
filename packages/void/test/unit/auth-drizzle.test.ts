import { describe, expect, it, vi } from 'vite-plus/test';
import {
  generateVoidAuthDatabaseModule,
  generateVoidAuthDrizzleSchema,
  resolveVoidAuthMigrationSchema,
} from '../../src/auth/drizzle.ts';

describe('Better Auth Drizzle codegen', () => {
  it('generates sqlite auth tables with Drizzle-friendly types', () => {
    const code = generateVoidAuthDrizzleSchema({
      dialect: 'sqlite',
      providers: null,
    });

    expect(code).toContain('import { index, integer, sqliteTable, text } from "void/schema-d1"');
    expect(code).toContain('export const userTable = sqliteTable("user"');
    expect(code).toContain('"id": text("id").primaryKey().notNull()');
    expect(code).toContain(
      '"emailVerified": integer("emailVerified", { mode: "boolean" }).notNull()',
    );
    expect(code).toContain('"createdAt": integer("createdAt", { mode: "timestamp_ms" }).notNull()');
    expect(code).toContain(
      '"userId": text("userId").notNull().references(() => userTable["id"], { onDelete: "cascade" })',
    );
    expect(code).toContain('index("session_userId_idx").on(table["userId"])');
    expect(code).toContain('"user": userTable');
    expect(code).toContain('export const migrationSchema = {');
    expect(code).toContain('"dialect": "sqlite"');
  });

  it('keeps schema keys stable when users rename tables and columns', () => {
    const code = generateVoidAuthDrizzleSchema({
      dialect: 'postgresql',
      providers: ['github'],
      userConfig: ({ defaults }) => ({
        ...defaults,
        user: {
          modelName: 'members',
          fields: {
            email: 'email_address',
          },
        },
      }),
    });

    expect(code).toContain(
      'import { boolean, index, pgTable, text, timestamp } from "void/schema-pg"',
    );
    expect(code).toContain('export const userTable = pgTable("members"');
    expect(code).toContain('"email_address": text("email_address").notNull().unique()');
    expect(code).toContain('"user": userTable');
    expect(code).toContain('"name": "members"');
  });

  it('generates MySQL auth tables with native column types', () => {
    const code = generateVoidAuthDrizzleSchema({ dialect: 'mysql', providers: null });

    expect(code).toContain('mysqlTable');
    expect(code).toContain('from "void/schema-mysql"');
    expect(code).toContain('boolean("emailVerified")');
    expect(code).toContain('timestamp("createdAt", { mode: "date", fsp: 3 })');
    expect(code).toContain('"dialect": "mysql"');
  });

  it('uses unbounded MySQL text for OAuth tokens while preserving constrained strings', () => {
    const code = generateVoidAuthDrizzleSchema({
      dialect: 'mysql',
      providers: ['google'],
      userConfig: ({ defaults }) => ({
        ...defaults,
        account: {
          fields: { idToken: 'google_id_token' },
          additionalFields: {
            pluginLookup: { type: 'string', index: true },
          },
        },
      }),
    });

    expect(code).toContain('import { boolean, index, mysqlTable, text, timestamp, varchar }');
    expect(code).toContain('"accessToken": text("accessToken")');
    expect(code).toContain('"refreshToken": text("refreshToken")');
    expect(code).toContain('"google_id_token": text("google_id_token")');
    expect(code).toContain('"email": varchar("email", { length: 255 }).notNull().unique()');
    expect(code).toContain('"pluginLookup": varchar("pluginLookup", { length: 255 }).notNull()');
    expect(code).toContain('index("account_pluginLookup_idx").on(table["pluginLookup"])');
    expect(code).toContain('"google_id_token": {');
    expect(code).toContain('"unbounded": true');
  });

  it('gives PostgreSQL serial and uuid ids a database default', () => {
    const generate = (dialect: 'postgresql' | 'mysql', generateId: 'serial' | 'uuid') =>
      generateVoidAuthDrizzleSchema({
        dialect,
        providers: null,
        userConfig: ({ defaults }) => ({ ...defaults, advanced: { database: { generateId } } }),
      });

    expect(generate('postgresql', 'serial')).toContain(
      '"id": integer("id").primaryKey().generatedByDefaultAsIdentity().notNull()',
    );
    expect(generate('postgresql', 'uuid')).toContain(
      '"id": uuid("id").primaryKey().defaultRandom().notNull()',
    );
    expect(generate('mysql', 'serial')).toContain(
      'import { boolean, index, int, mysqlTable, text, timestamp, varchar } from "void/schema-mysql"',
    );
  });

  it('carries Better Auth update hooks and literal defaults onto the Drizzle columns', () => {
    const code = generateVoidAuthDrizzleSchema({
      dialect: 'sqlite',
      providers: null,
      userConfig: ({ defaults }) => ({
        ...defaults,
        user: {
          additionalFields: {
            banned: { type: 'boolean', required: false, defaultValue: false },
            plan: { type: 'string', required: false, defaultValue: 'free' },
            credits: { type: 'number', required: false, defaultValue: 10 },
            trialEndsAt: { type: 'date', required: false, defaultValue: () => new Date() },
            tags: { type: 'string[]', required: false, defaultValue: '[]' },
          },
        },
      }),
    });

    expect(code).toContain(
      '"emailVerified": integer("emailVerified", { mode: "boolean" }).notNull().$defaultFn(() => false)',
    );
    expect(code).toContain(
      '"updatedAt": integer("updatedAt", { mode: "timestamp_ms" }).notNull().$onUpdate(() => new Date())',
    );
    expect(code).toContain(
      '"banned": integer("banned", { mode: "boolean" }).$defaultFn(() => false)',
    );
    expect(code).toContain('"plan": text("plan").$defaultFn(() => "free")');
    expect(code).toContain('"credits": integer("credits").$defaultFn(() => 10)');
    expect(code).toContain('"trialEndsAt": integer("trialEndsAt", { mode: "timestamp_ms" }),');
    expect(code).toContain('"tags": text("tags", { mode: "json" }),');
    expect(code).toContain(
      '"createdAt": integer("createdAt", { mode: "timestamp_ms" }).notNull(),',
    );
  });

  it('emits update hooks in every dialect', () => {
    expect(generateVoidAuthDrizzleSchema({ dialect: 'postgresql', providers: null })).toContain(
      '"updatedAt": timestamp("updatedAt", { mode: "date", withTimezone: true }).notNull().$onUpdate(() => new Date())',
    );
    expect(generateVoidAuthDrizzleSchema({ dialect: 'mysql', providers: null })).toContain(
      '"updatedAt": timestamp("updatedAt", { mode: "date", fsp: 3 }).notNull().$onUpdate(() => new Date())',
    );
  });

  it.each(['sqlite', 'postgresql', 'mysql'] as const)(
    'leaves custom date update hooks out of the generated %s schema',
    (dialect) => {
      const onUpdate = vi.fn(() => new Date('2035-01-01T00:00:00.000Z'));
      const code = generateVoidAuthDrizzleSchema({
        dialect,
        providers: null,
        userConfig: ({ defaults }) => ({
          ...defaults,
          user: {
            additionalFields: {
              expiresAt: { type: 'date', required: false, onUpdate },
            },
          },
          plugins: [
            {
              id: 'custom-dates',
              schema: {
                audit: {
                  fields: { updatedAt: { type: 'date', onUpdate } },
                },
              },
            },
          ],
        }),
      });

      expect(code.split('\n').find((line) => line.includes('"expiresAt":'))).not.toContain(
        '.$onUpdate',
      );
      const audit = code.slice(code.indexOf('export const auditTable'));
      expect(audit.split('\n').find((line) => line.includes('"updatedAt":'))).not.toContain(
        '.$onUpdate',
      );
      expect(code.match(/\.\$onUpdate\(/g)).toHaveLength(4);
      expect(onUpdate).not.toHaveBeenCalled();
    },
  );

  it.each(['user', 'session', 'account', 'verification'] as const)(
    'does not replace a configured %s.updatedAt hook',
    (model) => {
      const onUpdate = vi.fn(() => new Date('2035-01-01T00:00:00.000Z'));
      for (const source of ['additionalFields', 'plugin'] as const) {
        const field = { type: 'date' as const, onUpdate };
        const code = generateVoidAuthDrizzleSchema({
          dialect: 'sqlite',
          providers: null,
          userConfig: ({ defaults }) => ({
            ...defaults,
            ...(source === 'additionalFields'
              ? { [model]: { additionalFields: { updatedAt: field } } }
              : {
                  plugins: [
                    {
                      id: 'custom-updated-at',
                      schema: { [model]: { fields: { updatedAt: field } } },
                    },
                  ],
                }),
          }),
        });

        const table = code.slice(code.indexOf(`export const ${model}Table`));
        expect(table.split('\n').find((line) => line.includes('"updatedAt":'))).not.toContain(
          '.$onUpdate',
        );
        expect(code.match(/\.\$onUpdate\(/g)).toHaveLength(3);
      }
      expect(onUpdate).not.toHaveBeenCalled();
    },
  );

  it('keeps the built-in update hook when its table and column are renamed', () => {
    const code = generateVoidAuthDrizzleSchema({
      dialect: 'sqlite',
      providers: null,
      userConfig: ({ defaults }) => ({
        ...defaults,
        user: { modelName: 'members', fields: { updatedAt: 'modifiedAt' } },
      }),
    });

    expect(code).toContain(
      '"modifiedAt": integer("modifiedAt", { mode: "timestamp_ms" }).notNull().$onUpdate(() => new Date())',
    );
    expect(code.match(/\.\$onUpdate\(/g)).toHaveLength(4);
  });

  it('keeps optional defaults out of the migration metadata', () => {
    const schema = resolveVoidAuthMigrationSchema({
      dialect: 'sqlite',
      providers: null,
      userConfig: ({ defaults }) => ({
        ...defaults,
        user: {
          additionalFields: {
            banned: { type: 'boolean', required: false, defaultValue: false },
          },
        },
      }),
    });
    const user = schema.tables.find((table) => table.name === 'user');

    expect(user?.fields.banned).not.toHaveProperty('defaultValue');
    expect(user?.fields.emailVerified).toHaveProperty('defaultValue', false);
  });

  it('does not add MySQL storage metadata to PostgreSQL or SQLite schemas', () => {
    for (const dialect of ['postgresql', 'sqlite'] as const) {
      const code = generateVoidAuthDrizzleSchema({ dialect, providers: ['google'] });
      expect(code).not.toContain('"unbounded"');
    }
  });

  it('lazily creates an auth database adapter that reuses void/db', () => {
    const code = generateVoidAuthDatabaseModule({
      dialect: 'postgresql',
      schemaImportPath: '/project/.void/better-auth-schema.ts',
      drizzleAdapterPath: '/resolved/better-auth/adapters/drizzle.mjs',
    });

    expect(code).toContain('import { db as __voidDb } from "void/db"');
    expect(code).toContain(
      'let __voidAuthDatabaseInstance: ReturnType<typeof drizzleAdapter> | undefined;',
    );
    expect(code).toContain(
      'export const __voidAuthDatabase: ReturnType<typeof drizzleAdapter> = (options) => {',
    );
    expect(code).toContain('__voidAuthDatabaseInstance ??= drizzleAdapter(__voidDb');
    expect(code).toContain('return __voidAuthDatabaseInstance(options);');
    expect(code).not.toContain('export const __voidAuthDatabase = drizzleAdapter(__voidDb');
    expect(code).not.toContain('import pg from');
  });
});
