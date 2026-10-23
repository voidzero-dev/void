import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { getMiniflareDatabasePath } from '../../src/migrations/runner.ts';
import { migrationPlugin } from '../../src/plugin-migration.ts';

const mysqlQueries = vi.hoisted((): Array<string> => []);
// Each lock, release, recorded file and Better Auth run, with the database it went to.
const mysqlSteps = vi.hoisted((): Array<string> => []);

vi.mock('mysql2/promise', () => ({
  createConnection: async (options: string | { uri: string }) => {
    const database = new URL(typeof options === 'string' ? options : options.uri).pathname.slice(1);
    return {
      async query(sql: string) {
        mysqlQueries.push(sql);
        const step = sql.startsWith('SELECT GET_LOCK')
          ? 'lock'
          : sql.startsWith('SELECT RELEASE_LOCK')
            ? 'release'
            : sql.startsWith('INSERT INTO `_void_migrations`')
              ? 'record'
              : undefined;
        if (step) {
          mysqlSteps.push(`${step} ${database}`);
        }
        if (sql === 'SELECT DATABASE() AS db') {
          return [[{ db: 'app' }], []];
        }
        if (sql.startsWith('SELECT GET_LOCK')) {
          return [[{ acquired: 1 }], []];
        }
        return [[], []];
      },
      async end() {},
    };
  },
}));

const authFailure = vi.hoisted(() => ({ error: undefined as Error | undefined }));
const authImporters = vi.hoisted((): Array<unknown> => []);

vi.mock('../../src/auth/config.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/auth/config.ts')>()),
  devAuthConfigImporter: (server: { authImporter?: unknown }) => server.authImporter,
}));

vi.mock('../../src/auth/node.ts', () => ({
  runLocalVoidAuthMigrations: async (...args: Array<unknown>) => {
    mysqlQueries.push('Better Auth migrations');
    authImporters.push(args[6]);
    const databaseUrl = args[5];
    mysqlSteps.push(
      `auth ${typeof databaseUrl === 'string' ? new URL(databaseUrl).pathname.slice(1) : '(no URL)'}`,
    );
    if (authFailure.error) {
      throw authFailure.error;
    }
  },
}));

const roots: Array<string> = [];
type HookWithHandler<T> = { handler: T };
type ConfigureServerHook =
  | ((server: unknown) => Promise<void> | void)
  | HookWithHandler<(server: unknown) => Promise<void> | void>;

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-migrations-'));
  const migrationsDir = join(root, 'db', 'migrations');
  mkdirSync(migrationsDir, { recursive: true });
  writeFileSync(
    join(migrationsDir, '001_create_users.sql'),
    'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
  );
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function runConfigureServer(
  plugin: ReturnType<typeof migrationPlugin>,
  server: Record<string, unknown> = { environments: {} },
) {
  const hook = plugin.configureServer as ConfigureServerHook | undefined;
  if (!hook) {
    return;
  }
  if (typeof hook === 'function') {
    await hook.call({}, server);
    return;
  }
  await hook.handler.call({}, server);
}

describe('migrationPlugin persistence roots', () => {
  it('uses .void by default', async () => {
    const root = createProjectRoot();
    const plugin = migrationPlugin(root, 'sqlite');

    await runConfigureServer(plugin);

    const dbPath = getMiniflareDatabasePath(join(root, '.void'), 'local');
    expect(existsSync(dbPath)).toBe(true);
  });

  it('supports custom persist root for framework mode', async () => {
    const root = createProjectRoot();
    const persistRoot = join(root, '.wrangler', 'state');
    const plugin = migrationPlugin(root, 'sqlite', 'local', persistRoot);

    await runConfigureServer(plugin);

    const dbPath = getMiniflareDatabasePath(persistRoot, 'local');
    expect(existsSync(dbPath)).toBe(true);
  });
});

describe('migrationPlugin Better Auth config', () => {
  it("loads the auth config through the dev server's runner, so a restarted server reads it again", async () => {
    const root = createProjectRoot();
    const authImporter = vi.fn();
    authImporters.length = 0;

    await runConfigureServer(
      migrationPlugin(root, 'sqlite', 'local', join(root, '.void'), {
        enabled: true,
        configPath: null,
      }),
      { environments: {}, authImporter },
    );

    expect(authImporters).toEqual([authImporter]);
  });
});

describe('migrationPlugin with MySQL and Better Auth', () => {
  // Better Auth reads the schema, then adds what is missing, so two runs at once both add it.
  // An app without migration files reads DATABASE_URL like Better Auth: the shell before .env.
  it.each([
    { files: true, url: '.env' },
    { files: false, url: '.env' },
    { files: false, url: 'shell' },
  ])(
    'runs Better Auth migrations under the migration lock (migration files: $files, DATABASE_URL from $url)',
    async ({ files, url }) => {
      const root = createProjectRoot();
      if (!files) {
        rmSync(join(root, 'db'), { recursive: true });
      }
      if (url === 'shell') {
        vi.stubEnv('DATABASE_URL', 'mysql://root@127.0.0.1:3306/app');
      } else {
        writeFileSync(join(root, '.env'), 'DATABASE_URL=mysql://root@127.0.0.1:3306/app\n');
      }
      mysqlQueries.length = 0;

      try {
        await runConfigureServer(
          migrationPlugin(root, 'mysql', 'local', join(root, '.void'), {
            enabled: true,
            configPath: null,
          }),
        );
      } finally {
        vi.unstubAllEnvs();
      }

      const lock = mysqlQueries.findIndex((sql) => sql.startsWith('SELECT GET_LOCK'));
      const auth = mysqlQueries.indexOf('Better Auth migrations');
      const release = mysqlQueries.findIndex((sql) => sql.startsWith('SELECT RELEASE_LOCK'));
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(auth).toBeGreaterThan(lock);
      expect(release).toBeGreaterThan(auth);
      expect(mysqlQueries.filter((sql) => sql === 'Better Auth migrations')).toHaveLength(1);
    },
  );

  // Migration files apply to the database in .env, as `void db migrate` does. Better Auth's
  // migrations change the one DATABASE_URL names in the shell, else in .env.
  it.each([
    {
      name: 'the shell and .env name different databases',
      files: 'one',
      shell: 'shell',
      env: 'env',
      steps: ['lock env', 'record env', 'release env', 'lock shell', 'auth shell', 'release shell'],
    },
    {
      name: 'no migration files, the shell and .env name different databases',
      files: 'none',
      shell: 'shell',
      env: 'env',
      steps: ['lock shell', 'auth shell', 'release shell'],
    },
    {
      name: 'an empty migrations folder, DATABASE_URL only in the shell',
      files: 'empty',
      shell: 'shell',
      env: undefined,
      steps: ['lock shell', 'auth shell', 'release shell'],
    },
    {
      name: 'the shell and .env name the same database',
      files: 'one',
      shell: 'app',
      env: 'app',
      steps: ['lock app', 'record app', 'auth app', 'release app'],
    },
  ])(
    'holds the lock of the database each step changes ($name)',
    async ({ files, shell, env, steps }) => {
      const root = createProjectRoot();
      if (files === 'none') {
        rmSync(join(root, 'db'), { recursive: true });
      } else if (files === 'empty') {
        rmSync(join(root, 'db', 'migrations', '001_create_users.sql'));
      }
      if (env) {
        writeFileSync(join(root, '.env'), `DATABASE_URL=mysql://root@127.0.0.1:3306/${env}\n`);
      }
      vi.stubEnv('DATABASE_URL', `mysql://root@127.0.0.1:3306/${shell}`);
      mysqlSteps.length = 0;

      try {
        await runConfigureServer(
          migrationPlugin(root, 'mysql', 'local', join(root, '.void'), {
            enabled: true,
            configPath: null,
          }),
        );
      } finally {
        vi.unstubAllEnvs();
      }

      expect(mysqlSteps).toEqual(steps);
    },
  );

  it('reports the applied files when Better Auth migrations fail afterwards', async () => {
    const root = createProjectRoot();
    writeFileSync(join(root, '.env'), 'DATABASE_URL=mysql://root@127.0.0.1:3306/app\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    authFailure.error = new Error('Better Auth migration failed');
    let lines: Array<string>;
    try {
      await runConfigureServer(
        migrationPlugin(root, 'mysql', 'local', join(root, '.void'), {
          enabled: true,
          configPath: null,
        }),
      );
      lines = log.mock.calls.map(([line]) => String(line));
    } finally {
      authFailure.error = undefined;
      log.mockRestore();
    }

    const applied = lines.findIndex((line) =>
      line.includes('Applied 1 migration(s): 001_create_users.sql'),
    );
    const failed = lines.findIndex((line) => line.includes('Better Auth migration failed'));
    expect(applied).toBeGreaterThanOrEqual(0);
    expect(failed).toBeGreaterThan(applied);
  });
});

async function captureConsoleLog(run: () => Promise<void>): Promise<Array<string>> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await run();
    return log.mock.calls.map(([line]) => String(line));
  } finally {
    log.mockRestore();
  }
}

describe('migrationPlugin with destructive migrations', () => {
  // Like `void db migrate`, dev applies none of the pending files when one of them is
  // destructive without the pragma, and the dev server still starts.
  it('applies no SQLite migrations when a pending file is destructive without the pragma', async () => {
    const root = createProjectRoot();
    await runConfigureServer(migrationPlugin(root, 'sqlite'));
    const dbPath = getMiniflareDatabasePath(join(root, '.void'), 'local');
    const seed = new DatabaseSync(dbPath);
    seed.exec("INSERT INTO users (name) VALUES ('a'), ('b'), ('c');");
    seed.close();
    const migrationsDir = join(root, 'db', 'migrations');
    writeFileSync(join(migrationsDir, '002_create_posts.sql'), 'CREATE TABLE posts (id INTEGER);');
    writeFileSync(join(migrationsDir, '003_wipe_users.sql'), 'DELETE FROM users;');

    const lines = await captureConsoleLog(() =>
      runConfigureServer(migrationPlugin(root, 'sqlite')),
    );

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 3 });
      expect(
        db
          .prepare('SELECT name FROM _void_migrations ORDER BY name')
          .all()
          .map((row) => row.name),
      ).toEqual(['001_create_users.sql']);
    } finally {
      db.close();
    }
    expect(
      lines.some(
        (line) =>
          line.includes('Destructive migrations detected without pragma') &&
          line.includes('No migrations were applied'),
      ),
    ).toBe(true);
  });

  it('runs no MySQL migration or Better Auth step when a pending file is destructive without the pragma', async () => {
    const root = createProjectRoot();
    writeFileSync(join(root, 'db', 'migrations', '001_create_users.sql'), 'DELETE FROM users;');
    writeFileSync(join(root, '.env'), 'DATABASE_URL=mysql://root@127.0.0.1:3306/app\n');
    mysqlQueries.length = 0;

    const lines = await captureConsoleLog(() =>
      runConfigureServer(
        migrationPlugin(root, 'mysql', 'local', join(root, '.void'), {
          enabled: true,
          configPath: null,
        }),
      ),
    );

    expect(mysqlQueries).not.toContain('DELETE FROM users;');
    expect(mysqlQueries.some((sql) => sql.startsWith('INSERT INTO `_void_migrations`'))).toBe(
      false,
    );
    expect(mysqlQueries).not.toContain('Better Auth migrations');
    expect(
      lines.some((line) => line.includes('Destructive migrations detected without pragma')),
    ).toBe(true);
  });
});

describe('migrationPlugin with PostgreSQL and Better Auth', () => {
  it('reports a missing DATABASE_URL instead of logging success', async () => {
    const root = createProjectRoot();
    rmSync(join(root, 'db'), { recursive: true });
    vi.stubEnv('DATABASE_URL', undefined);
    mysqlSteps.length = 0;

    let lines: Array<string>;
    try {
      lines = await captureConsoleLog(() =>
        runConfigureServer(
          migrationPlugin(root, 'postgresql', 'local', join(root, '.void'), {
            enabled: true,
            configPath: null,
          }),
        ),
      );
    } finally {
      vi.unstubAllEnvs();
    }

    expect(lines.some((line) => line.includes('DATABASE_URL not found'))).toBe(true);
    expect(lines.some((line) => line.includes('Applied Better Auth migrations'))).toBe(false);
    expect(mysqlSteps).toEqual([]);
  });

  // An empty DATABASE_URL in the shell counts as unset, so the one in .env is used.
  it('uses DATABASE_URL from .env when the shell value is empty', async () => {
    const root = createProjectRoot();
    rmSync(join(root, 'db'), { recursive: true });
    writeFileSync(join(root, '.env'), 'DATABASE_URL=postgres://localhost/app\n');
    vi.stubEnv('DATABASE_URL', '');
    mysqlSteps.length = 0;

    let lines: Array<string>;
    try {
      lines = await captureConsoleLog(() =>
        runConfigureServer(
          migrationPlugin(root, 'postgresql', 'local', join(root, '.void'), {
            enabled: true,
            configPath: null,
          }),
        ),
      );
    } finally {
      vi.unstubAllEnvs();
    }

    expect(lines.some((line) => line.includes('DATABASE_URL not found'))).toBe(false);
    expect(lines.some((line) => line.includes('Applied Better Auth migrations'))).toBe(true);
    expect(mysqlSteps).toEqual(['auth (no URL)']);
  });
});
