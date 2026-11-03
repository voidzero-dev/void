import { existsSync } from 'node:fs';
import { join } from 'pathslash';
import type { Plugin } from 'vite';
import { devAuthConfigImporter } from './auth/config.ts';
import type { DatabaseDialect } from './config.ts';
import { voidLog, voidError } from './log.ts';
import { afterServerReady } from './plugin-dev-config.ts';
import { readProjectPaths } from './project-paths.ts';
import { loadLocalEnv } from './shared/env.ts';

function readDatabaseUrl(root: string): string | undefined {
  return loadLocalEnv(root).DATABASE_URL;
}

/**
 * DATABASE_URL as Better Auth's local migrations read it: the shell before `.env`. An empty
 * shell value counts as unset.
 */
function readAuthDatabaseUrl(root: string): string | undefined {
  return process.env.DATABASE_URL || readDatabaseUrl(root) || undefined;
}

/**
 * Vite plugin that runs local migrations on dev server startup.
 * For SQLite/D1: applies migrations to the local miniflare database.
 * For PostgreSQL/MySQL: connects via DATABASE_URL from .env.
 */
export function migrationPlugin(
  root: string,
  dialect: DatabaseDialect,
  databaseId: string = 'local',
  persistRoot: string = join(root, '.void'),
  auth?: { enabled: boolean; configPath?: string | null },
): Plugin {
  return {
    name: 'void:migrations',
    apply: 'serve',

    async configureServer(server) {
      const paths = readProjectPaths(root);
      const migrationsDir = paths.migrationsDir;
      const hasSqlMigrations = existsSync(migrationsDir);
      if (!hasSqlMigrations && !auth?.enabled) {
        return;
      }

      const migrateAuth = async (databaseUrl?: string) => {
        const { runLocalVoidAuthMigrations } = await import('./auth/node.ts');
        await runLocalVoidAuthMigrations(
          root,
          dialect,
          persistRoot,
          databaseId,
          auth?.configPath,
          databaseUrl,
          devAuthConfigImporter(server),
        );
      };
      // MySQL runs Better Auth's migrations under the migration lock of the database they change.
      const mysqlAuth = dialect === 'mysql' && auth?.enabled === true;
      const logApplied = (applied: Array<string>) => {
        if (applied.length > 0) {
          voidLog(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
        }
      };
      // A pending migration that fails validation stops every migration for this start, as
      // `void db migrate` does, so files never apply out of order. The dev server still starts.
      const refuse = (err: unknown) => {
        afterServerReady(server, () => {
          console.log();
          voidError(
            `${err instanceof Error ? err.message : String(err)}\nNo migrations were applied. Fix the files, then restart the dev server.`,
          );
        });
      };

      try {
        if (dialect !== 'sqlite') {
          const { collectMigrations } = await import('./migrations/collect.ts');
          const allMigrations = collectMigrations(migrationsDir);
          // For MySQL an empty migrations folder has nothing to apply.
          const runFiles = dialect === 'mysql' ? allMigrations.length > 0 : hasSqlMigrations;
          // Migration files apply to the database in .env, as `void db migrate` does. Better
          // Auth's migrations read DATABASE_URL from the shell before .env, and each step holds
          // the lock of the database it changes.
          const url = runFiles ? readDatabaseUrl(root) : undefined;
          const authUrl = mysqlAuth ? readAuthDatabaseUrl(root) : undefined;
          if ((runFiles && !url) || (auth?.enabled && !readAuthDatabaseUrl(root))) {
            afterServerReady(server, () => {
              console.log();
              voidError(
                `DATABASE_URL not found in .env — skipping ${dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'} migrations.`,
              );
            });
            return;
          }
          // One lock covers both steps when they change the same database.
          const authWithFiles = authUrl !== undefined && authUrl === url;

          if (url) {
            const { validateMigrations } = await import('./migrations/validate.ts');
            const appliedNames =
              dialect === 'mysql'
                ? await import('./migrations/runner-mysql.ts').then((runner) =>
                    runner.getMySqlAppliedMigrations(url),
                  )
                : await import('./migrations/runner-pg.ts').then((runner) =>
                    runner.getPgAppliedMigrations(url),
                  );
            const appliedSet = new Set(appliedNames);
            const pending = allMigrations.filter((migration) => !appliedSet.has(migration.name));
            if (pending.length > 0) {
              try {
                validateMigrations(pending);
              } catch (err) {
                refuse(err);
                return;
              }
            }

            const applied =
              dialect === 'mysql'
                ? await import('./migrations/runner-mysql.ts').then((runner) =>
                    runner.runMySqlMigrations(
                      migrationsDir,
                      url,
                      // Report the applied files before Better Auth's step, which can still fail.
                      authWithFiles
                        ? async (names) => {
                            logApplied(names);
                            await migrateAuth(url);
                          }
                        : undefined,
                    ),
                  )
                : await import('./migrations/runner-pg.ts').then((runner) =>
                    runner.runPgMigrations(migrationsDir, url),
                  );
            if (!authWithFiles) {
              logApplied(applied);
            }
          }

          if (authUrl && !authWithFiles) {
            const { withMySqlMigrationLockAt } = await import('./migrations/runner-mysql.ts');
            await withMySqlMigrationLockAt(authUrl, () => migrateAuth(authUrl));
          }
        } else if (hasSqlMigrations) {
          const { runMigrations, getMiniflareDatabasePath, getAppliedMigrations } =
            await import('./migrations/runner.ts');
          const { collectMigrations } = await import('./migrations/collect.ts');
          const { validateMigrations } = await import('./migrations/validate.ts');
          const dbPath = getMiniflareDatabasePath(persistRoot, databaseId);

          const allMigrations = collectMigrations(migrationsDir);
          const appliedRows = await getAppliedMigrations(dbPath);
          const appliedSet = new Set(appliedRows.map((r) => r.name));
          const pending = allMigrations.filter((m) => !appliedSet.has(m.name));
          if (pending.length > 0) {
            try {
              validateMigrations(pending);
            } catch (err) {
              refuse(err);
              return;
            }
          }

          const applied = await runMigrations(migrationsDir, dbPath, paths.sourceRelative);
          if (applied.length > 0) {
            voidLog(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
          }
        }

        if (auth?.enabled) {
          if (!mysqlAuth) {
            await migrateAuth();
          }
          voidLog('Applied Better Auth migrations');
        }
      } catch (err) {
        voidError(`Migration error: ${err}`);
      }
    },
  };
}
