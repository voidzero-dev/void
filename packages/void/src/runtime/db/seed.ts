import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export type SqliteSeedContext<TSchema extends Record<string, unknown> = Record<string, never>> = {
  dialect: 'sqlite';
  db: BetterSQLite3Database<TSchema>;
  schema: TSchema;
};

export type PostgresSeedContext<TSchema extends Record<string, unknown> = Record<string, never>> = {
  dialect: 'postgresql';
  db: NodePgDatabase<TSchema>;
  schema: TSchema;
};

export type MySqlSeedContext<TSchema extends Record<string, unknown> = Record<string, never>> = {
  dialect: 'mysql';
  db: MySql2Database<TSchema>;
  schema: TSchema;
};

type DrizzleTableForDialect<TDialect extends string> = {
  readonly _: {
    readonly config: {
      readonly dialect: TDialect;
    };
  };
};

type SchemaHasTableDialect<TSchema extends Record<string, unknown>, TDialect extends string> = [
  Extract<TSchema[keyof TSchema], DrizzleTableForDialect<TDialect>>,
] extends [never]
  ? false
  : true;

type SchemaHasSqliteTables<TSchema extends Record<string, unknown>> = SchemaHasTableDialect<
  TSchema,
  'sqlite'
>;

type SchemaHasPostgresTables<TSchema extends Record<string, unknown>> = SchemaHasTableDialect<
  TSchema,
  'pg'
>;

type SchemaHasMySqlTables<TSchema extends Record<string, unknown>> = SchemaHasTableDialect<
  TSchema,
  'mysql'
>;

type FallbackSeedContext<TSchema extends Record<string, unknown>> =
  SchemaHasSqliteTables<TSchema> extends false
    ? SchemaHasPostgresTables<TSchema> extends false
      ? SchemaHasMySqlTables<TSchema> extends false
        ? SqliteSeedContext<TSchema> | PostgresSeedContext<TSchema> | MySqlSeedContext<TSchema>
        : never
      : never
    : never;

export type SeedContext<TSchema extends Record<string, unknown> = Record<string, never>> =
  | (SchemaHasSqliteTables<TSchema> extends true ? SqliteSeedContext<TSchema> : never)
  | (SchemaHasPostgresTables<TSchema> extends true ? PostgresSeedContext<TSchema> : never)
  | (SchemaHasMySqlTables<TSchema> extends true ? MySqlSeedContext<TSchema> : never)
  | FallbackSeedContext<TSchema>;

export type SeedFn<TSchema extends Record<string, unknown> = Record<string, never>> = (
  context: SeedContext<TSchema>,
) => void | Promise<void>;

export function defineSeed<TSchema extends Record<string, unknown> = Record<string, never>>(
  seed: SeedFn<TSchema>,
): SeedFn<TSchema> {
  return seed;
}
