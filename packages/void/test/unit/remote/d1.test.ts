import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import { createDb } from '../../../src/runtime/db.ts';
import { ProxyClient } from '../../../src/runtime/remote/client.ts';
import { ProxyD1Database } from '../../../src/runtime/remote/d1.ts';

function createClient() {
  return new ProxyClient('https://proxy.void.cloud', 'jwt-token', 'proj_1');
}

function mockFetch(response: unknown, contentType = 'application/json') {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(response), {
        headers: { 'content-type': contentType },
      }),
  );
  globalThis.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

describe('ProxyD1Database', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('prepare().all()', () => {
    it('sends correct request and returns D1Result', async () => {
      const rows = [{ id: 1, name: 'Alice' }];
      mockFetch({ results: rows, success: true, meta: { duration: 0.1 } });

      const db = new ProxyD1Database(createClient(), 'DB');
      const result = await db.prepare('SELECT * FROM users').all();

      expect(result.results).toEqual(rows);
      expect(result.success).toBe(true);

      const call = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(call[1].body));
      expect(body.sql).toBe('SELECT * FROM users');
      expect(body.method).toBe('all');
      expect(body.binding).toBe('DB');
    });
  });

  describe('prepare().bind().first()', () => {
    it('sends method=first and returns single row', async () => {
      mockFetch({ id: 1, name: 'Alice' });

      const db = new ProxyD1Database(createClient(), 'DB');
      const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(1).first();

      expect(row).toEqual({ id: 1, name: 'Alice' });

      const call = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(call[1].body));
      expect(body.method).toBe('first');
      expect(body.params).toEqual([1]);
    });

    it('returns null when no row found', async () => {
      mockFetch(null);

      const db = new ProxyD1Database(createClient(), 'DB');
      const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(999).first();

      expect(row).toBeNull();
    });

    it('returns specific column value when col is specified', async () => {
      mockFetch({ id: 1, name: 'Alice' });

      const db = new ProxyD1Database(createClient(), 'DB');
      const name = await db.prepare('SELECT * FROM users WHERE id = ?').bind(1).first('name');

      expect(name).toBe('Alice');
    });
  });

  describe('prepare().run()', () => {
    it('sends method=run and returns D1Result', async () => {
      mockFetch({ success: true, meta: { duration: 0.002, changes: 1 } });

      const db = new ProxyD1Database(createClient(), 'DB');
      const result = await db
        .prepare('UPDATE users SET name = ? WHERE id = ?')
        .bind('Bob', 1)
        .run();

      expect(result.success).toBe(true);
      const call = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(call[1].body));
      expect(body.method).toBe('run');
      expect(body.params).toEqual(['Bob', 1]);
    });
  });

  describe('prepare().raw()', () => {
    it('sends method=raw and returns array of arrays', async () => {
      mockFetch({
        columns: ['id', 'name'],
        results: [
          [1, 'Alice'],
          [2, 'Bob'],
        ],
      });

      const db = new ProxyD1Database(createClient(), 'DB');
      const rows = await db.prepare('SELECT * FROM users').raw();

      expect(rows).toEqual([
        [1, 'Alice'],
        [2, 'Bob'],
      ]);
    });

    it('includes column names when columnNames option is true', async () => {
      mockFetch({
        columns: ['id', 'name'],
        results: [[1, 'Alice']],
      });

      const db = new ProxyD1Database(createClient(), 'DB');
      const rows = await db.prepare('SELECT * FROM users').raw({ columnNames: true });

      expect(rows[0]).toEqual(['id', 'name']);
      expect(rows[1]).toEqual([1, 'Alice']);
    });
  });

  describe('batch()', () => {
    it('keeps independent bindings when reusing a prepared statement', async () => {
      mockFetch([
        { results: [], success: true, meta: {} },
        { results: [], success: true, meta: {} },
      ]);
      const db = new ProxyD1Database(createClient(), 'DB');
      const prepared = db.prepare('INSERT INTO users (name) VALUES (?)');
      const alice = prepared.bind('Alice');
      const bob = alice.bind('Bob');
      const results = await db.batch([alice, bob] as unknown as Array<D1PreparedStatement>);

      expect(results).toHaveLength(2);

      const call = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(call[1].body)).statements).toEqual([
        { sql: 'INSERT INTO users (name) VALUES (?)', params: ['Alice'] },
        { sql: 'INSERT INTO users (name) VALUES (?)', params: ['Bob'] },
      ]);
      expect(prepared._params).toEqual([]);
      expect(call[0]).toBe('https://proxy.void.cloud/d1/batch');
    });
  });

  describe('exec()', () => {
    it('sends sql with method=run and returns D1ExecResult', async () => {
      mockFetch({ success: true, meta: { changes: 3, duration: 0.005 } });

      const db = new ProxyD1Database(createClient(), 'DB');
      const result = await db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY)');

      expect(result.count).toBe(3);
      expect(result.duration).toBe(0.005);
    });
  });

  describe('createDb()', () => {
    it.each([
      { options: undefined, constraint: 'first-unconstrained' },
      { options: {}, constraint: 'first-unconstrained' },
      { options: { session: 'first-primary' as const }, constraint: 'first-primary' },
      { options: { session: 'first-unconstrained' as const }, constraint: 'first-unconstrained' },
    ])('starts the requested D1 session ($constraint)', ({ options, constraint }) => {
      const binding = new ProxyD1Database(createClient(), 'DB');
      const withSession = vi.spyOn(binding, 'withSession');

      createDb(binding as unknown as D1Database, options);

      expect(withSession).toHaveBeenCalledExactlyOnceWith(constraint);
    });

    it('runs Drizzle queries through the remote binding', async () => {
      const users = sqliteTable('users', { id: integer('id').primaryKey(), name: text('name') });
      const fetchMock = mockFetch({ columns: ['id', 'name'], results: [[1, 'Alice']] });

      const db = createDb(new ProxyD1Database(createClient(), 'DB') as unknown as D1Database);
      const rows = await db.select().from(users);

      expect(rows).toEqual([{ id: 1, name: 'Alice' }]);
      const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(String(call[1].body));
      expect(body.binding).toBe('DB');
      expect(body.method).toBe('raw');
      expect(body.sql).toMatch(/^select .* from "users"$/);
    });
  });

  describe('bind()', () => {
    it('replaces params only on the returned statement', async () => {
      const db = new ProxyD1Database(createClient(), 'DB');
      const stmt = db.prepare('SELECT * FROM users WHERE id = ?');

      const first = stmt.bind(1);
      const second = first.bind(2, 3);
      const unbound = second.bind();
      expect(stmt._params).toEqual([]);
      expect(first._params).toEqual([1]);
      expect(second._params).toEqual([2, 3]);
      expect(unbound._params).toEqual([]);
    });
  });
});
