import { describe, expect, it, vi } from 'vite-plus/test';
import { createMigrationHandler } from '../../src/runtime/db/migrations/postgres-handler.ts';
import { disablePgPassFallback } from '../../src/runtime/db/pgpass.ts';

// The names in `_void_migrations`, kept in memory by the fake client below.
const pgApplied = vi.hoisted((): Array<string> => []);

vi.mock('pg', () => ({
  Client: class {
    async connect() {}
    async end() {}
    async query(sql: string, params?: Array<unknown>) {
      if (sql.startsWith('SELECT name FROM _void_migrations')) {
        return { rows: pgApplied.map((name) => ({ name })) };
      }
      if (sql.startsWith('INSERT INTO _void_migrations')) {
        pgApplied.push(String(params?.[0]));
      }
      return { rows: [] };
    }
  },
}));

describe('PostgreSQL migration handler', () => {
  it('prevents pgpass fallback when Hyperdrive connection strings have no password', () => {
    const client: {
      connectionParameters: { password: unknown };
      password: unknown;
    } = {
      connectionParameters: { password: null },
      password: null,
    };

    disablePgPassFallback(client);

    expect(typeof client.password).toBe('function');
    expect(client.connectionParameters.password).toBe(client.password);
  });

  it('keeps parsed connection string passwords intact', () => {
    const client = {
      connectionParameters: { password: 'secret' },
      password: 'secret',
    };

    disablePgPassFallback(client);

    expect(client.password).toBe('secret');
    expect(client.connectionParameters.password).toBe('secret');
  });

  it('reports the applied files when Better Auth migrations fail', async () => {
    pgApplied.length = 0;
    const handler = createMigrationHandler(
      {
        HYPERDRIVE: { connectionString: 'postgresql://localhost/app' },
        __VOID_PROXY_TOKEN: 'token',
      },
      [
        { name: '0001_init.sql', sql: 'CREATE TABLE posts (id integer);' },
        { name: '0002_more.sql', sql: 'ALTER TABLE posts ADD COLUMN title text;' },
      ],
      async () => {
        throw new Error('Better Auth migration failed');
      },
    );

    const response = await handler(
      new Request('http://localhost/__void/migrate', {
        method: 'POST',
        headers: { 'x-void-internal': 'token' },
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Better Auth migration failed',
      migrations: [
        { name: '0001_init.sql', applied: true, durationMs: expect.any(Number) },
        { name: '0002_more.sql', applied: true, durationMs: expect.any(Number) },
      ],
    });
    expect(pgApplied).toEqual(['0001_init.sql', '0002_more.sql']);
  });
});
