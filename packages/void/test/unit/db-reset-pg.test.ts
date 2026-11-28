import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { toSlash } from 'pathslash';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import { runDbCommand } from '../../src/cli/db.ts';

const state = vi.hoisted(() => ({ pg: null as PGlite | null }));
vi.mock('pg', () => ({
  Client: class {
    async connect() {}
    async end() {}
    async query(sql: string, params?: Array<unknown>) {
      return params
        ? state.pg!.query(sql, params)
        : ((await state.pg!.exec(sql)).at(-1) ?? { rows: [] });
    }
  },
}));
vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  intro() {},
  outro() {},
  confirm: async () => true,
  isCancel: () => false,
  log: { error() {}, info() {}, step() {}, success() {} },
}));

const BREAKPOINT = '--> statement-breakpoint\n';
const roots: Array<string> = [];

beforeAll(async () => {
  // Load PostgreSQL once: Windows' cold WASM startup belongs to the hook budget.
  state.pg = new PGlite({ extensions: { citext } });
  await state.pg.waitReady;
}, 30_000);
beforeEach(async () => {
  await state.pg!.exec(
    'DROP SCHEMA IF EXISTS analytics CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public',
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as never);
});
afterAll(async () => {
  await state.pg?.close();
  state.pg = null;
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(statements: Array<string>): string {
  const root = mkdtempSync(join(tmpdir(), 'void-reset-pg-'));
  roots.push(root);
  mkdirSync(join(root, 'db', 'migrations'), { recursive: true });
  writeFileSync(join(root, 'void.json'), JSON.stringify({ database: 'pg' }));
  writeFileSync(join(root, '.env'), 'DATABASE_URL=postgres://unused:unused@localhost/isolated');
  writeFileSync(join(root, 'db', 'migrations', '0000_init.sql'), statements.join(BREAKPOINT));
  return root;
}

describe('void db reset on PostgreSQL', () => {
  it('refuses a nested migration folder before migrating or resetting PostgreSQL', async () => {
    const root = project(['CREATE TABLE new_flat (id integer PRIMARY KEY);']);
    const folder = join(root, 'db', 'migrations', '20261127010000_create_users');
    mkdirSync(folder);
    writeFileSync(join(folder, 'migration.sql'), 'CREATE TABLE users (id integer PRIMARY KEY);');
    await state.pg!.exec('CREATE TABLE keep_on_refusal (id integer PRIMARY KEY)');

    const message = "Unsupported nested migration folder '" + toSlash(folder) + "'";
    await expect(runDbCommand(root, { action: 'migrate' })).rejects.toThrow(message);
    await expect(runDbCommand(root, { action: 'reset', yes: true })).rejects.toThrow(message);
    expect(
      (await state.pg!.query("SELECT to_regclass('public.keep_on_refusal') AS name")).rows,
    ).toEqual([{ name: 'keep_on_refusal' }]);
  });

  it('drops types, sequences and views so the migrations apply again, and keeps extensions', async () => {
    const pg = state.pg!;
    // Installed by hand, outside the migrations.
    await pg.exec('CREATE EXTENSION citext');
    const root = project([
      `CREATE TYPE "public"."mood" AS ENUM('happy', 'sad');`,
      'CREATE SEQUENCE "public"."order_no" START WITH 1000;',
      'CREATE DOMAIN "public"."score" AS integer CHECK (VALUE >= 0);',
      'CREATE TABLE "users" ("id" serial PRIMARY KEY NOT NULL, "mood" "mood" NOT NULL, "email" citext, "points" "score");',
      `CREATE VIEW "public"."app_info" AS (select 'v1'::text as version);`,
    ]);
    await runDbCommand(root, { action: 'migrate' });
    await pg.exec(
      "INSERT INTO users (mood, email, points) VALUES ('happy', 'Ada@example.com', 1); SELECT nextval('order_no');",
    );

    await runDbCommand(root, { action: 'reset', yes: true });

    expect((await pg.query('SELECT count(*)::int AS count FROM users')).rows).toEqual([
      { count: 0 },
    ]);
    expect((await pg.query("SELECT nextval('order_no')::int AS next")).rows).toEqual([
      { next: 1000 },
    ]);
    expect((await pg.query('SELECT name FROM _void_migrations')).rows).toEqual([
      { name: '0000_init.sql' },
    ]);
    expect(
      (await pg.query("SELECT extname FROM pg_extension WHERE extname = 'citext'")).rows,
    ).toEqual([{ extname: 'citext' }]);
  });

  it('drops a type that has the name of a built-in type', async () => {
    const pg = state.pg!;
    const root = project([
      `CREATE TYPE "public"."interval" AS ENUM('month', 'year');`,
      'CREATE TABLE "plans" ("id" serial PRIMARY KEY NOT NULL, "every" "public"."interval" NOT NULL);',
    ]);
    await runDbCommand(root, { action: 'migrate' });

    await runDbCommand(root, { action: 'reset', yes: true });

    expect(
      (await pg.query('SELECT enum_range(NULL::public.interval)::text AS labels')).rows,
    ).toEqual([{ labels: '{month,year}' }]);
  });

  it('stops before dropping anything when another schema uses a public type or sequence', async () => {
    const pg = state.pg!;
    const root = project([
      `CREATE TYPE "public"."mood" AS ENUM('happy', 'sad');`,
      'CREATE SEQUENCE "public"."order_no" START WITH 1000;',
      'CREATE TABLE "users" ("id" serial PRIMARY KEY NOT NULL, "mood" "mood" NOT NULL);',
    ]);
    await runDbCommand(root, { action: 'migrate' });
    // Made by hand, outside the migrations.
    await pg.exec(`
      INSERT INTO users (mood) VALUES ('happy');
      CREATE DOMAIN public.score AS integer;
      CREATE SCHEMA analytics;
      CREATE TABLE analytics.events (
        id integer DEFAULT nextval('public.order_no'),
        mood public.mood,
        moods public.mood[],
        score public.score
      );
      INSERT INTO analytics.events VALUES (1, 'sad', '{happy}', 7);
    `);

    const error = await runDbCommand(root, { action: 'reset', yes: true }).catch(
      (err: unknown) => err,
    );

    const message = String(error);
    expect(message).toContain('column mood of table analytics.events');
    expect(message).toContain('column moods of table analytics.events');
    expect(message).toContain('column score of table analytics.events');
    expect(message).toContain('default value for column id of table analytics.events');
    expect(
      (await pg.query('SELECT id, mood, moods::text, score FROM analytics.events')).rows,
    ).toEqual([{ id: 1, mood: 'sad', moods: '{happy}', score: 7 }]);
    expect(
      (
        await pg.query(
          "SELECT pg_get_expr(adbin, adrelid) AS expr FROM pg_attrdef WHERE adrelid = 'analytics.events'::regclass",
        )
      ).rows,
    ).toEqual([{ expr: "nextval('order_no'::regclass)" }]);
    expect((await pg.query('SELECT count(*)::int AS count FROM users')).rows).toEqual([
      { count: 1 },
    ]);
  });

  it('stops before dropping anything when another schema uses a public view', async () => {
    const pg = state.pg!;
    const root = project([`CREATE VIEW "public"."app_info" AS (select 'v1'::text as version);`]);
    await runDbCommand(root, { action: 'migrate' });
    // Made by hand, outside the migrations.
    await pg.exec(`
      CREATE SCHEMA analytics;
      CREATE VIEW analytics.versions AS SELECT version FROM public.app_info;
    `);

    const error = await runDbCommand(root, { action: 'reset', yes: true }).catch(
      (err: unknown) => err,
    );

    expect(String(error)).toContain('rule _RETURN on view analytics.versions uses view app_info');
    expect((await pg.query('SELECT version FROM analytics.versions')).rows).toEqual([
      { version: 'v1' },
    ]);
  });
});
