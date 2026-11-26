import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import Database from 'better-sqlite3';
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
import { getLocalD1Target, runDbCommand } from '../../src/cli/db.ts';
import { Buffer } from '../../src/cli/node-buffer.ts';

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
const roots: Array<string> = [];
beforeAll(async () => {
  // Load PostgreSQL once: Windows' cold WASM startup belongs to the hook budget,
  // while each export assertion retains its normal short test deadline.
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
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
function project(pg = false) {
  const root = mkdtempSync(join(tmpdir(), 'void-export-'));
  roots.push(root);
  writeFileSync(join(root, 'void.json'), JSON.stringify(pg ? { database: 'pg' } : {}));
  writeFileSync(join(root, '.env'), 'DATABASE_URL=postgres://unused:unused@localhost/isolated');
  return root;
}

describe('SQL export restore', () => {
  it('rejects PostgreSQL schema objects the exporter cannot restore', async () => {
    const pg = state.pg!;
    const root = project(true);
    await pg.exec(
      'CREATE TABLE entries (id integer); CREATE VIEW entry_ids AS SELECT id FROM entries;',
    );
    await expect(runDbCommand(root, { action: 'export', output: 'dump.sql' })).rejects.toThrow(
      /pg_dump/,
    );
  });

  it('preserves PostgreSQL column modifiers and generated columns', async () => {
    const pg = state.pg!;
    const root = project(true);
    await pg.exec(`CREATE TABLE products (
      code varchar(8) NOT NULL,
      price numeric(9,2) NOT NULL,
      display text GENERATED ALWAYS AS (code || ':' || price::text) STORED
    ); INSERT INTO products (code, price) VALUES ('widget', 12.50);`);
    await runDbCommand(root, { action: 'export', output: 'dump.sql' });
    const dump = readFileSync(join(root, 'dump.sql'), 'utf8');
    await pg.exec('DROP TABLE products');
    await pg.exec(dump);
    expect((await pg.query('SELECT display FROM products')).rows).toEqual([
      { display: 'widget:12.50' },
    ]);
    await expect(
      pg.exec("INSERT INTO products (code, price, display) VALUES ('x', 1, 'manual')"),
    ).rejects.toThrow();
    await expect(
      pg.exec("INSERT INTO products (code, price) VALUES ('too-long-code', 1)"),
    ).rejects.toThrow();
    await expect(
      pg.exec("INSERT INTO products (code, price) VALUES ('short', 123456789)"),
    ).rejects.toThrow();
  });

  it('preserves PostgreSQL identity columns and their next value', async () => {
    const pg = state.pg!;
    const root = project(true);
    await pg.exec(
      "CREATE TABLE entries (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, title text); INSERT INTO entries (title) VALUES ('first');",
    );
    await runDbCommand(root, { action: 'export', output: 'dump.sql' });
    const dump = readFileSync(join(root, 'dump.sql'), 'utf8');
    expect(dump).toContain('setval');
    await pg.exec('DROP TABLE entries');
    await pg.exec(dump);
    expect(
      (await pg.query("INSERT INTO entries (title) VALUES ('second') RETURNING id::text AS id"))
        .rows,
    ).toEqual([{ id: '2' }]);
  });

  it('restores SQLite indexes, triggers, and views after data', async () => {
    const root = project();
    const { databasePath } = getLocalD1Target(root);
    mkdirSync(join(databasePath, '..'), { recursive: true });
    const source = new Database(databasePath);
    source.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
      CREATE TABLE audit (title TEXT);
      CREATE UNIQUE INDEX notes_title ON notes (title);
      CREATE TRIGGER notes_audit AFTER INSERT ON notes BEGIN INSERT INTO audit (title) VALUES (new.title); END;
      CREATE VIEW note_titles AS SELECT title FROM notes;
      INSERT INTO notes VALUES (1, 'first');`);
    source.close();
    await runDbCommand(root, { action: 'export', output: 'dump.sql' });
    const dump = readFileSync(join(root, 'dump.sql'), 'utf8');
    const restored = new Database(':memory:');
    try {
      restored.exec(dump);
      expect(restored.prepare('SELECT * FROM note_titles').all()).toEqual([{ title: 'first' }]);
      expect(restored.prepare('SELECT * FROM audit').all()).toEqual([{ title: 'first' }]);
      restored.prepare('INSERT INTO notes (title) VALUES (?)').run('second');
      expect(restored.prepare('SELECT * FROM audit').all()).toEqual([
        { title: 'first' },
        { title: 'second' },
      ]);
      expect(() =>
        restored.prepare('INSERT INTO notes (title) VALUES (?)').run('second'),
      ).toThrow();
    } finally {
      restored.close();
    }
  });

  it('exports SQLite app tables and views whose names start with an underscore', async () => {
    const root = project();
    const { databasePath } = getLocalD1Target(root);
    mkdirSync(join(databasePath, '..'), { recursive: true });
    const source = new Database(databasePath);
    source.exec(`CREATE TABLE _drafts (id INTEGER PRIMARY KEY, title TEXT);
      CREATE VIEW _draft_titles AS SELECT title FROM _drafts;
      CREATE TABLE _void_migrations (name TEXT PRIMARY KEY, applied_at TEXT);
      CREATE TABLE _cf_METADATA (key INTEGER PRIMARY KEY, value BLOB);
      INSERT INTO _drafts VALUES (1, 'draft');`);
    source.close();
    await runDbCommand(root, { action: 'export', output: 'dump.sql' });
    const dump = readFileSync(join(root, 'dump.sql'), 'utf8');
    expect(dump).not.toContain('_void_migrations');
    expect(dump).not.toContain('_cf_METADATA');
    const restored = new Database(':memory:');
    try {
      restored.exec(dump);
      expect(restored.prepare('SELECT * FROM _draft_titles').all()).toEqual([{ title: 'draft' }]);
    } finally {
      restored.close();
    }
  });

  it('exports PostgreSQL app tables whose names start with an underscore', async () => {
    const pg = state.pg!;
    const root = project(true);
    await pg.exec(`CREATE TABLE _drafts (id integer PRIMARY KEY, title text);
      CREATE TABLE posts (id integer PRIMARY KEY, draft_id integer REFERENCES _drafts(id));
      CREATE TABLE _void_migrations (name text PRIMARY KEY, applied_at text NOT NULL);
      INSERT INTO _drafts VALUES (1, 'draft'); INSERT INTO posts VALUES (1, 1);`);
    await runDbCommand(root, { action: 'export', output: 'dump.sql' });
    const dump = readFileSync(join(root, 'dump.sql'), 'utf8');
    expect(dump).not.toContain('_void_migrations');
    await pg.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await pg.exec(dump);
    expect(
      (await pg.query('SELECT title FROM posts JOIN _drafts ON _drafts.id = posts.draft_id')).rows,
    ).toEqual([{ title: 'draft' }]);
  });

  it('writes an export to an absolute --output path', async () => {
    const root = project();
    const outDir = mkdtempSync(join(tmpdir(), 'void-export-out-'));
    roots.push(outDir);
    const { databasePath } = getLocalD1Target(root);
    mkdirSync(join(databasePath, '..'), { recursive: true });
    const source = new Database(databasePath);
    source.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY)');
    source.close();
    await runDbCommand(root, { action: 'export', output: join(outDir, 'dump.sql') });
    expect(readFileSync(join(outDir, 'dump.sql'), 'utf8')).toContain('CREATE TABLE notes');
  });

  it('round-trips SQLite blobs and generated columns', async () => {
    const root = project();
    const { databasePath } = getLocalD1Target(root);
    mkdirSync(join(databasePath, '..'), { recursive: true });
    const source = new Database(databasePath);
    source.exec(
      'CREATE TABLE files (id INTEGER PRIMARY KEY, payload BLOB, label TEXT GENERATED ALWAYS AS (hex(payload)) STORED)',
    );
    source
      .prepare('INSERT INTO files (id, payload) VALUES (?, ?)')
      .run(1, Buffer.from([0, 255, 39]));
    source.close();
    await runDbCommand(root, { action: 'export', output: 'dump.sql' });
    const restored = new Database(':memory:');
    try {
      restored.exec(readFileSync(join(root, 'dump.sql'), 'utf8'));
      expect(restored.prepare('SELECT id, payload, label FROM files').all()).toEqual([
        { id: 1, payload: Buffer.from([0, 255, 39]), label: '00FF27' },
      ]);
      expect(() =>
        restored.prepare("INSERT INTO files (id, payload, label) VALUES (2, X'01', 'bad')").run(),
      ).toThrow();
    } finally {
      restored.close();
    }
  });

  it('round-trips generated PostgreSQL timestamp defaults without locale or time-zone conversion', async () => {
    const pg = state.pg!;
    const root = project(true);
    await pg.exec(`CREATE TABLE users (
      id SERIAL PRIMARY KEY, name text NOT NULL,
      created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
    ); INSERT INTO users(name, created_at, updated_at)
      VALUES ('Alice', '2026-01-01 12:34:56.123456', '2026-01-02 23:45:00');`);
    const select = 'SELECT id, name, created_at::text, updated_at::text FROM users';
    const original = await pg.query(select);
    await runDbCommand(root, { action: 'export', output: 'dump.sql' });
    const dump = readFileSync(join(root, 'dump.sql'), 'utf8');
    await pg.exec('DROP TABLE users');
    await pg.exec(dump);
    expect((await pg.query(select)).rows).toEqual(original.rows);
  });

  it('restores a schema-only PostgreSQL export with a fresh serial counter', async () => {
    const pg = state.pg!;
    const root = project(true);
    await pg.exec(
      "CREATE TABLE users(id SERIAL PRIMARY KEY); SELECT setval('users_id_seq', 100, true);",
    );
    await runDbCommand(root, { action: 'export', output: 'dump.sql', noData: true });
    const dump = readFileSync(join(root, 'dump.sql'), 'utf8');
    await pg.exec('DROP TABLE users');
    await pg.exec(dump);
    expect((await pg.query('INSERT INTO users DEFAULT VALUES RETURNING id')).rows).toEqual([
      { id: 1 },
    ]);
  });

  it('preserves an unused PostgreSQL sequence without skipping its first value', async () => {
    const pg = state.pg!;
    const root = project(true);
    await pg.exec('CREATE TABLE users(id BIGSERIAL PRIMARY KEY);');
    await runDbCommand(root, { action: 'export', output: 'dump.sql' });
    const dump = readFileSync(join(root, 'dump.sql'), 'utf8');
    await pg.exec('DROP TABLE users');
    await pg.exec(dump);
    expect(
      (await pg.query('INSERT INTO users DEFAULT VALUES RETURNING id::text AS id')).rows,
    ).toEqual([{ id: '1' }]);
  });

  it.each([{}, { table: 'users' }, { noSchema: true }])(
    'restores SQLite autoincrement and its high-water mark (%j)',
    async (options) => {
      const root = project();
      const { databasePath } = getLocalD1Target(root);
      mkdirSync(join(databasePath, '..'), { recursive: true });
      const source = new Database(databasePath);
      const schema =
        'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);';
      source.exec(
        schema +
          "INSERT INTO users VALUES (1, 'Alice'); INSERT INTO users VALUES (100, 'deleted'); DELETE FROM users WHERE id=100;",
      );
      source.close();
      await runDbCommand(root, { action: 'export', output: 'dump.sql', ...options });
      const dump = readFileSync(join(root, 'dump.sql'), 'utf8');
      const restored = new Database(':memory:');
      try {
        if ('noSchema' in options) {
          restored.exec(schema);
        }
        restored.exec(dump);
        expect(restored.prepare('SELECT * FROM users').all()).toEqual([{ id: 1, name: 'Alice' }]);
        const result = restored.prepare('INSERT INTO users (name) VALUES (?)').run('Bob');
        expect(result.lastInsertRowid).toBe(101);
      } finally {
        restored.close();
      }
    },
  );

  it.each([{}, { table: 'users' }, { noSchema: true }])(
    'restores PostgreSQL serial sequences and their state (%j)',
    async (options) => {
      const pg = state.pg!;
      const root = project(true);
      const schema = 'CREATE TABLE users (id SERIAL PRIMARY KEY, name text NOT NULL);';
      await pg.exec(
        schema +
          "INSERT INTO users(name) VALUES ('Alice'); SELECT setval('users_id_seq', 100, true);",
      );
      await runDbCommand(root, { action: 'export', output: 'dump.sql', ...options });
      const dump = readFileSync(join(root, 'dump.sql'), 'utf8');
      await pg.exec('DROP TABLE users;');
      if ('noSchema' in options) {
        await pg.exec(schema);
      }
      await pg.exec(dump);
      expect((await pg.query('SELECT * FROM users')).rows).toEqual([{ id: 1, name: 'Alice' }]);
      expect((await pg.query("INSERT INTO users(name) VALUES ('Bob') RETURNING id")).rows).toEqual([
        { id: 101 },
      ]);
      await expect(pg.exec("INSERT INTO users(id, name) VALUES (1, 'duplicate')")).rejects.toThrow(
        'duplicate key',
      );
    },
  );
});
