import type { Connection } from 'mysql2/promise';
import type { MigrationEntry, MigrationResponse, MigrationResult } from './migration-handler.ts';
import {
  acquireMySqlMigrationLease,
  holdMySqlMigrationLease,
  type MySqlMigrationLease,
} from './migration-lock-mysql.ts';
import { splitMySqlMigrationStatements } from './mysql-migration-sql.ts';

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
        { status: 401 },
      );
    }

    // A later failure, such as Better Auth's step, still reports the files that committed.
    const results: Array<MigrationResult> = [];
    try {
      return Response.json(await runMySqlMigrations(env, migrations, results, runAuthMigrations));
    } catch (error) {
      return Response.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          migrations: results,
        } satisfies MigrationResponse,
        { status: 500 },
      );
    }
  };
}

async function runMySqlMigrations(
  env: Record<string, unknown>,
  migrations: Array<MigrationEntry>,
  results: Array<MigrationResult>,
  runAuthMigrations?: () => Promise<void>,
): Promise<MigrationResponse> {
  const hyperdrive = env.HYPERDRIVE as { connectionString?: string } | undefined;
  if (!hyperdrive?.connectionString) {
    return { ok: false, error: 'no HYPERDRIVE binding found', migrations: [] };
  }

  const { createConnection } = await import('mysql2/promise');
  // Hyperdrive runs one statement per query, so a file is sent statement by statement.
  const connection = await createConnection({
    uri: hyperdrive.connectionString,
    disableEval: true,
  });
  let leaseConnection: Connection | undefined;
  let lease: MySqlMigrationLease | undefined;
  try {
    // Lease statements must stay out of the migration transactions, so they get their own connection.
    const leaseClient = await createConnection({
      uri: hyperdrive.connectionString,
      disableEval: true,
    });
    leaseConnection = leaseClient;
    lease = await acquireMySqlMigrationLease(
      async (sql, params) => (await leaseClient.query(sql, params))[0],
    );
    await connection.query(
      'CREATE TABLE IF NOT EXISTS `_void_migrations` (`name` VARCHAR(255) PRIMARY KEY, `applied_at` VARCHAR(64) NOT NULL)',
    );
    const [rows] = await connection.query('SELECT `name` FROM `_void_migrations`');
    const applied = new Set((rows as Array<{ name: string }>).map((row) => String(row.name)));

    for (const migration of migrations) {
      if (applied.has(migration.name)) {
        results.push({ name: migration.name, applied: false, durationMs: 0 });
        continue;
      }
      const start = Date.now();
      try {
        // Data changes commit with the tracking row. MySQL commits DDL, and anything before it,
        // on its own. Hyperdrive keeps one connection for the open transaction.
        await connection.query('BEGIN');
        for (const statement of splitMySqlMigrationStatements(migration.sql)) {
          await lease.renew();
          await connection.query(statement.sql).catch((error: unknown) => {
            throw statement.program ? withBreakpointNote(error, migration.name) : error;
          });
        }
        await lease.renew();
        await connection.query(
          'INSERT INTO `_void_migrations` (`name`, `applied_at`) VALUES (?, ?)',
          [migration.name, new Date().toISOString()],
        );
        await connection.query('COMMIT');
        results.push({ name: migration.name, applied: true, durationMs: Date.now() - start });
      } catch (error) {
        await connection.query('ROLLBACK').catch(() => {});
        results.push({
          name: migration.name,
          applied: false,
          durationMs: Date.now() - start,
          error: error instanceof Error ? error.message : String(error),
        });
        return { ok: false, migrations: results, error: `migration ${migration.name} failed` };
      }
    }

    // Better Auth's migrations change the schema too, so they run before the lease is released.
    if (runAuthMigrations) {
      await holdMySqlMigrationLease(lease, runAuthMigrations);
    }
    return { ok: true, migrations: results };
  } finally {
    await lease?.release().catch(() => {});
    await Promise.all([connection.end(), leaseConnection?.end()]);
  }
}

/**
 * The splitter keeps the SQL after a trigger, routine or event with it. The CLI runs that with
 * `multipleStatements`; here one query takes one statement, so the server rejects it as a syntax
 * error before running any of it. MySQL reports 1064; Vitess (PlanetScale) reports "syntax error
 * at position", or 1149 for several statements it can parse. A syntax error inside the body looks
 * the same, so the note says "if".
 */
function withBreakpointNote(error: unknown, name: string): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const errno = (error as { errno?: unknown }).errno;
  if (errno !== 1064 && errno !== 1149 && !/syntax error at position/.test(error.message)) {
    return error;
  }
  return new Error(
    `${error.message}\nThis deploy runs one statement per query. If ${name} has more SQL after a trigger, procedure, function or event, add a \`--> statement-breakpoint\` line after it.`,
    { cause: error },
  );
}
