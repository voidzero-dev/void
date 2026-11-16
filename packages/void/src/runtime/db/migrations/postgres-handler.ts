import type { MigrationEntry, MigrationResponse, MigrationResult } from './migration-handler.ts';
import { disablePgPassFallback } from './pg.ts';

export function createMigrationHandler(
  env: Record<string, unknown>,
  migrations: Array<MigrationEntry>,
  runAuthMigrations?: () => Promise<void>,
) {
  return async (request: Request): Promise<Response> => {
    const token = request.headers.get('x-void-internal');
    if (!token || token !== (env as Record<string, string>).__VOID_PROXY_TOKEN) {
      return Response.json(
        { ok: false, error: 'unauthorized', migrations: [] } satisfies MigrationResponse,
        {
          status: 401,
        },
      );
    }

    try {
      const result = await runPgMigrations(env, migrations);
      if (result.ok && runAuthMigrations) {
        // The files are already committed, so a Better Auth failure still reports them.
        try {
          await runAuthMigrations();
        } catch (err) {
          return Response.json(
            {
              ...result,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            } satisfies MigrationResponse,
            { status: 500 },
          );
        }
      }
      return Response.json(result);
    } catch (err) {
      return Response.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          migrations: [],
        } satisfies MigrationResponse,
        { status: 500 },
      );
    }
  };
}

async function runPgMigrations(
  env: Record<string, unknown>,
  migrations: Array<MigrationEntry>,
): Promise<MigrationResponse> {
  const hyperdrive = env.HYPERDRIVE as { connectionString?: string } | undefined;
  if (!hyperdrive?.connectionString) {
    return { ok: false, error: 'no HYPERDRIVE binding found', migrations: [] };
  }

  const { Client } = await import('pg');
  const client = new Client({ connectionString: hyperdrive.connectionString });
  disablePgPassFallback(client);
  await client.connect();

  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS _void_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`,
    );

    const { rows } = await client.query<{ name: string }>('SELECT name FROM _void_migrations');
    const applied = new Set(rows.map((r) => r.name));

    const migrationResults: Array<MigrationResult> = [];

    for (const m of migrations) {
      if (applied.has(m.name)) {
        migrationResults.push({ name: m.name, applied: false, durationMs: 0 });
        continue;
      }

      const start = Date.now();
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO _void_migrations (name, applied_at) VALUES ($1, $2)', [
          m.name,
          new Date().toISOString(),
        ]);
        await client.query('COMMIT');
        migrationResults.push({ name: m.name, applied: true, durationMs: Date.now() - start });
      } catch (err) {
        await client.query('ROLLBACK');
        migrationResults.push({
          name: m.name,
          applied: false,
          durationMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        });
        return { ok: false, migrations: migrationResults, error: `migration ${m.name} failed` };
      }
    }

    return { ok: true, migrations: migrationResults };
  } finally {
    await client.end();
  }
}
