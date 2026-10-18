import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { toSlash } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import * as output from '../../src/cli/output.ts';

const mockIntro = vi.fn();
const mockConfirm = vi.fn();
const mockOutro = vi.fn();
const mockLog = {
  error: vi.fn(),
  info: vi.fn(),
  step: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
};
const mockGetMiniflareDatabasePath = vi.fn();
const mockGetAppliedMigrations = vi.fn();
const mockRunMigrations = vi.fn();
const mockGetPgAppliedMigrations = vi.fn();
const mockRunPgMigrations = vi.fn();
const mockGetMySqlAppliedMigrations = vi.fn();
const mockRunMySqlMigrations = vi.fn();

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  intro: (...args: Array<unknown>) => mockIntro(...args),
  outro: (...args: Array<unknown>) => mockOutro(...args),
  confirm: (...args: Array<unknown>) => mockConfirm(...args),
  isCancel: (value: unknown) => typeof value === 'symbol',
  log: {
    error: (...args: Array<unknown>) => mockLog.error(...args),
    info: (...args: Array<unknown>) => mockLog.info(...args),
    step: (...args: Array<unknown>) => mockLog.step(...args),
    success: (...args: Array<unknown>) => mockLog.success(...args),
    warn: (...args: Array<unknown>) => mockLog.warn(...args),
  },
}));

vi.mock('../../src/migrations/runner', () => ({
  getMiniflareDatabasePath: (...args: Array<unknown>) => mockGetMiniflareDatabasePath(...args),
  getAppliedMigrations: (...args: Array<unknown>) => mockGetAppliedMigrations(...args),
  runMigrations: (...args: Array<unknown>) => mockRunMigrations(...args),
}));

vi.mock('../../src/migrations/runner-pg', () => ({
  getPgAppliedMigrations: (...args: Array<unknown>) => mockGetPgAppliedMigrations(...args),
  readPgAppliedMigrations: vi.fn(),
  runPgMigrations: (...args: Array<unknown>) => mockRunPgMigrations(...args),
}));

vi.mock('../../src/migrations/runner-mysql', () => ({
  getMySqlAppliedMigrations: (...args: Array<unknown>) => mockGetMySqlAppliedMigrations(...args),
  readMySqlAppliedMigrations: vi.fn(),
  toMySqlClient: vi.fn(),
  runMySqlMigrations: (...args: Array<unknown>) => mockRunMySqlMigrations(...args),
}));

const roots: Array<string> = [];

function infoMessagesWithoutColor(): Array<string> {
  return mockLog.info.mock.calls.map(([message]) => stripVTControlCharacters(String(message)));
}

function createProjectRoot(migrations: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'void-db-migrate-'));
  const migrationsDir = join(root, 'db', 'migrations');
  mkdirSync(join(migrationsDir, 'meta'), { recursive: true });

  const entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }> = [];
  let idx = 0;
  for (const [name, sql] of Object.entries(migrations)) {
    writeFileSync(join(migrationsDir, name), sql);
    entries.push({
      idx: idx++,
      version: '7',
      when: Date.now(),
      tag: name.replace(/\.sql$/, ''),
      breakpoints: true,
    });
  }
  writeFileSync(
    join(migrationsDir, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries }),
  );

  roots.push(root);
  return root;
}

function createPgProjectRoot(migrations: Record<string, string>): string {
  const root = createProjectRoot(migrations);
  writeFileSync(join(root, 'void.json'), JSON.stringify({ database: 'pg' }, null, 2) + '\n');
  writeFileSync(
    join(root, 'db', 'migrations', 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: Object.keys(migrations).map((name, idx) => ({
        idx,
        version: '7',
        when: Date.now(),
        tag: name.replace(/\.sql$/, ''),
        breakpoints: true,
      })),
    }),
  );
  return root;
}

function createMySqlProjectRoot(migrations: Record<string, string>): string {
  const root = createProjectRoot(migrations);
  writeFileSync(join(root, 'void.json'), JSON.stringify({ database: 'mysql' }, null, 2) + '\n');
  writeFileSync(
    join(root, 'db', 'migrations', 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'mysql',
      entries: Object.keys(migrations).map((name, idx) => ({
        idx,
        version: '7',
        when: Date.now(),
        tag: name.replace(/\.sql$/, ''),
        breakpoints: true,
      })),
    }),
  );
  return root;
}

function selectCloudflare(root: string): void {
  mkdirSync(join(root, '.void'), { recursive: true });
  writeFileSync(
    join(root, '.void', 'project.json'),
    JSON.stringify({ platform: 'cloudflare' }, null, 2) + '\n',
  );
}

const mockReadCloudflareD1Migrations = vi.fn();
const mockApplyCloudflareD1Migrations = vi.fn();
const mockRestoreCloudflareD1Database = vi.fn();

// The D1 context still comes from the real config reader; only the Cloudflare calls are fake.
vi.mock('../../src/cli/cloudflare-operations.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/cloudflare-operations.ts')>()),
  readCloudflareD1Migrations: (...args: Array<unknown>) => mockReadCloudflareD1Migrations(...args),
  applyCloudflareD1Migrations: (...args: Array<unknown>) =>
    mockApplyCloudflareD1Migrations(...args),
  restoreCloudflareD1Database: (...args: Array<unknown>) =>
    mockRestoreCloudflareD1Database(...args),
}));

describe('void db migrate', () => {
  let runDbCommand: typeof import('../../src/cli/db.ts').runDbCommand;

  beforeEach(async () => {
    vi.spyOn(output, 'printSuccess').mockImplementation(() => {});
    vi.clearAllMocks();
    mockGetMiniflareDatabasePath.mockReturnValue(join(tmpdir(), 'void-db-migrate.sqlite'));
    mockGetAppliedMigrations.mockResolvedValue([]);
    mockRunMigrations.mockResolvedValue([]);
    mockGetPgAppliedMigrations.mockResolvedValue([]);
    mockRunPgMigrations.mockResolvedValue([]);
    mockGetMySqlAppliedMigrations.mockResolvedValue([]);
    mockRunMySqlMigrations.mockResolvedValue([]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    runDbCommand = (await import('../../src/cli/db.ts')).runDbCommand;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
    delete process.env.DATABASE_URL;
  });

  it('fails before applying a pending destructive migration without pragma', async () => {
    const root = createProjectRoot({
      '001_drop_users.sql': 'DROP TABLE users;',
    });

    await expect(runDbCommand(root, { action: 'migrate' })).rejects.toThrow('process.exit:1');

    expect(mockLog.error).toHaveBeenCalledWith(
      expect.stringContaining('Destructive migrations detected without pragma'),
    );
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('001_drop_users.sql'));
    expect(mockRunMigrations).not.toHaveBeenCalled();
  });

  it("allows a pragma'd destructive migration to apply locally", async () => {
    const root = createProjectRoot({
      '001_drop_users.sql': '-- void:allow-destructive\nDROP TABLE users;',
    });
    mockRunMigrations.mockResolvedValue(['001_drop_users.sql']);

    await runDbCommand(root, { action: 'migrate' });

    expect(mockRunMigrations).toHaveBeenCalledWith(
      toSlash(join(root, 'db', 'migrations')),
      join(tmpdir(), 'void-db-migrate.sqlite'),
      expect.any(Function),
    );
    expect(output.printSuccess).toHaveBeenCalledWith('Applied 1 migration.');
  });

  it('does not block reruns because of already applied destructive history', async () => {
    const root = createProjectRoot({
      '001_drop_users.sql': 'DROP TABLE users;',
    });
    mockGetAppliedMigrations.mockResolvedValue([
      { name: '001_drop_users.sql', applied_at: '2026-03-10T00:00:00.000Z' },
    ]);

    await runDbCommand(root, { action: 'migrate' });

    expect(mockRunMigrations).toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith('All migrations are up to date.');
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it('rejects remote migrate for PostgreSQL before falling through to the D1 endpoint', async () => {
    const root = createPgProjectRoot({
      '001_create_users.sql': 'CREATE TABLE users (id text primary key);',
    });

    await expect(runDbCommand(root, { action: 'migrate', remote: true })).rejects.toThrow(
      'process.exit:1',
    );

    expect(mockLog.error).toHaveBeenCalledWith(
      'db: `void db migrate --remote` is only supported for D1 projects. PostgreSQL remote migrations run during `void deploy` through the project Hyperdrive binding.',
    );
    expect(mockGetAppliedMigrations).not.toHaveBeenCalled();
    expect(mockRunMigrations).not.toHaveBeenCalled();
  });

  it('refuses remote D1 migrate when the binding has no migrations_dir', async () => {
    const root = createProjectRoot({
      '001_create_users.sql': 'CREATE TABLE users (id integer primary key);',
    });
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'linked-worker',
        account_id: 'acc1',
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'app-db',
            database_id: '3f2a9c1e-0000-4000-8000-000000000000',
          },
        ],
      }),
    );
    // Cloudflare's default folder holds SQL that Void never checked.
    mkdirSync(join(root, 'migrations'));
    writeFileSync(join(root, 'migrations', '0001_legacy.sql'), 'DROP TABLE users;');
    selectCloudflare(root);
    mockReadCloudflareD1Migrations.mockResolvedValue([]);

    await expect(runDbCommand(root, { action: 'migrate', remote: true })).rejects.toThrow(
      'process.exit:1',
    );

    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('"migrations_dir"'));
    expect(mockApplyCloudflareD1Migrations).not.toHaveBeenCalled();
  });

  it('applies pending PostgreSQL migrations directly for a Cloudflare target', async () => {
    const root = createPgProjectRoot({
      '001_create_users.sql': 'CREATE TABLE users (id text primary key);',
    });
    selectCloudflare(root);
    process.env.DATABASE_URL = 'postgresql://example.test/app';
    mockRunPgMigrations.mockResolvedValue(['001_create_users.sql']);

    await runDbCommand(root, { action: 'migrate', remote: true });

    expect(mockGetPgAppliedMigrations).toHaveBeenCalledWith(process.env.DATABASE_URL);
    expect(mockRunPgMigrations).toHaveBeenCalledWith(
      toSlash(join(root, 'db', 'migrations')),
      process.env.DATABASE_URL,
    );
    expect(output.printSuccess).toHaveBeenCalledWith('Applied 1 migration to remote database.');
  });

  it('applies pending MySQL migrations directly for a Cloudflare target', async () => {
    const root = createMySqlProjectRoot({
      '001_create_users.sql': 'CREATE TABLE users (id varchar(255) primary key);',
    });
    selectCloudflare(root);
    process.env.DATABASE_URL = 'mysql://example.test/app';
    mockRunMySqlMigrations.mockResolvedValue(['001_create_users.sql']);

    await runDbCommand(root, { action: 'migrate', remote: true });

    expect(mockGetMySqlAppliedMigrations).toHaveBeenCalledWith(process.env.DATABASE_URL);
    expect(mockRunMySqlMigrations).toHaveBeenCalledWith(
      toSlash(join(root, 'db', 'migrations')),
      process.env.DATABASE_URL,
    );
    expect(output.printSuccess).toHaveBeenCalledWith('Applied 1 migration to remote database.');
  });

  it('reads direct Cloudflare PostgreSQL migration status from DATABASE_URL', async () => {
    const root = createPgProjectRoot({
      '001_create_users.sql': 'CREATE TABLE users (id text primary key);',
    });
    selectCloudflare(root);
    process.env.DATABASE_URL = 'postgresql://example.test/app';
    mockGetPgAppliedMigrations.mockResolvedValue(['001_create_users.sql']);

    await runDbCommand(root, { action: 'status' });

    expect(mockGetPgAppliedMigrations).toHaveBeenCalledWith(process.env.DATABASE_URL);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('DATABASE_URL not found in .env'),
    );
    expect(infoMessagesWithoutColor()).toContain(
      '  001_create_users.sql  local: unknown  remote: applied',
    );
  });

  it('reads direct Cloudflare MySQL migration status from DATABASE_URL', async () => {
    const root = createMySqlProjectRoot({
      '001_create_users.sql': 'CREATE TABLE users (id varchar(255) primary key);',
    });
    selectCloudflare(root);
    process.env.DATABASE_URL = 'mysql://example.test/app';
    mockGetMySqlAppliedMigrations.mockResolvedValue(['001_create_users.sql']);

    await runDbCommand(root, { action: 'status' });

    expect(mockGetMySqlAppliedMigrations).toHaveBeenCalledWith(process.env.DATABASE_URL);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('DATABASE_URL not found in .env'),
    );
    expect(infoMessagesWithoutColor()).toContain(
      '  001_create_users.sql  local: unknown  remote: applied',
    );
  });

  it('counts pending files, not tracked names, in the status summary', async () => {
    // Another branch applied 002 and 003, which are not on disk here.
    const root = createProjectRoot({
      '001_a.sql': 'CREATE TABLE a (id integer);',
      '004_d.sql': 'CREATE TABLE d (id integer);',
    });
    mockGetAppliedMigrations.mockResolvedValue(
      ['001_a.sql', '002_b.sql', '003_c.sql'].map((name) => ({ name, applied_at: '' })),
    );

    await runDbCommand(root, { action: 'status' });

    expect(mockOutro).toHaveBeenCalledWith('2 migrations, 1 pending locally');
  });

  it('names journal drift under sourceDir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-db-migrate-'));
    roots.push(root);
    writeFileSync(join(root, 'void.json'), JSON.stringify({ sourceDir: 'src' }, null, 2) + '\n');
    const migrationsDir = join(root, 'src', 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    writeFileSync(join(migrationsDir, '0000_init.sql'), 'CREATE TABLE a (id integer);');
    writeFileSync(join(migrationsDir, '0001_orphan.sql'), 'CREATE TABLE b (id integer);');
    writeFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [{ idx: 0, version: '7', when: 0, tag: '0000_init', breakpoints: true }],
      }),
    );

    await expect(runDbCommand(root, { action: 'migrate' })).rejects.toThrow('process.exit:1');

    expect(mockLog.error).toHaveBeenCalledWith(
      expect.stringContaining('  - src/db/migrations/0001_orphan.sql'),
    );
    expect(mockRunMigrations).not.toHaveBeenCalled();
  });
});

describe('void db restore', () => {
  let runDbCommand: typeof import('../../src/cli/db.ts').runDbCommand;
  const bookmark = '00000085-0000024c-00004ef2-0a83ea2fceebc654de0640c422be4653';
  const previous = '00000085-0000024c-00004ef1-1b94fb3fdffcd765ef1751d533cf5764';

  function d1Project(select = true): string {
    const root = createProjectRoot({
      '001_create_users.sql': 'CREATE TABLE users (id integer primary key);',
      '002_add_email.sql': 'ALTER TABLE users ADD email text;',
    });
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'linked-worker',
        account_id: 'acc1',
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'app-db',
            database_id: '3f2a9c1e-0000-4000-8000-000000000000',
            migrations_dir: './db/migrations',
          },
        ],
      }),
    );
    if (select) {
      selectCloudflare(root);
    }
    return root;
  }

  beforeEach(async () => {
    vi.spyOn(output, 'printSuccess').mockImplementation(() => {});
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    runDbCommand = (await import('../../src/cli/db.ts')).runDbCommand;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores the configured D1 database and names the migrations the next deploy reapplies', async () => {
    const root = d1Project();
    mockRestoreCloudflareD1Database.mockResolvedValue(previous);
    mockReadCloudflareD1Migrations.mockResolvedValue(['001_create_users.sql']);

    await runDbCommand(root, { action: 'restore', target: { bookmark }, yes: true });

    expect(mockRestoreCloudflareD1Database).toHaveBeenCalledWith(
      expect.objectContaining({ binding: 'DB', migrateToken: 'app-db' }),
      { bookmark },
    );
    expect(mockLog.info).toHaveBeenCalledWith(
      `To undo this restore, run \`void db restore --bookmark=${previous}\`.`,
    );
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'The remote database does not have these migrations applied: 002_add_email.sql. ' +
          'The next `void deploy` applies them.',
      ),
    );
    expect(output.printSuccess).toHaveBeenCalledWith(
      `Restored D1 database app-db (DB) to bookmark ${bookmark}.`,
    );
  });

  it('still reports the restore when the applied migrations cannot be read afterwards', async () => {
    const root = d1Project();
    mockRestoreCloudflareD1Database.mockResolvedValue(undefined);
    mockReadCloudflareD1Migrations.mockRejectedValue(new Error('network down'));

    await runDbCommand(root, {
      action: 'restore',
      target: { timestamp: '2026-10-16T09:30:00Z' },
      yes: true,
    });

    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('network down'));
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Run `void db status`'));
    expect(mockLog.info).not.toHaveBeenCalledWith(expect.stringContaining('To undo'));
    expect(output.printSuccess).toHaveBeenCalledWith(
      'Restored D1 database app-db (DB) to 2026-10-16T09:30:00Z.',
    );
  });

  it('refuses to restore without --yes when there is no terminal', async () => {
    const root = d1Project();
    const stdinTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    try {
      await expect(runDbCommand(root, { action: 'restore', target: { bookmark } })).rejects.toThrow(
        'process.exit:1',
      );
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinTty });
    }

    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('Re-run with --yes'));
    expect(mockRestoreCloudflareD1Database).not.toHaveBeenCalled();
  });

  it('explains that restore points expire when Cloudflare rejects the restore', async () => {
    const root = d1Project();
    mockRestoreCloudflareD1Database.mockRejectedValue(
      new Error('Cloudflare command failed (d1.time-travel.restore, exit 1): bookmark expired'),
    );

    await expect(
      runDbCommand(root, { action: 'restore', target: { bookmark }, yes: true }),
    ).rejects.toThrow('process.exit:1');

    const message = String(mockLog.error.mock.calls[0]?.[0]);
    expect(message).toContain('bookmark expired');
    expect(message).toContain('Restore points expire after 7 days on Workers Free');
    expect(mockReadCloudflareD1Migrations).not.toHaveBeenCalled();
    expect(output.printSuccess).not.toHaveBeenCalled();
  });

  it('asks before restoring in a terminal, and changes nothing when declined', async () => {
    const root = d1Project();
    mockConfirm.mockResolvedValue(false);
    const stdinTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    try {
      await expect(runDbCommand(root, { action: 'restore', target: { bookmark } })).rejects.toThrow(
        'process.exit:0',
      );
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinTty });
    }

    expect(mockConfirm).toHaveBeenCalledWith({
      message: `This restores D1 database app-db (DB) to bookmark ${bookmark} and discards every write made after it. Continue?`,
      initialValue: false,
    });
    expect(mockLog.info).toHaveBeenCalledWith('Cancelled.');
    expect(mockRestoreCloudflareD1Database).not.toHaveBeenCalled();
  });

  it('restores from a fresh checkout whose Cloudflare config names the D1 database', async () => {
    const root = d1Project(false);
    mockRestoreCloudflareD1Database.mockResolvedValue(undefined);
    mockReadCloudflareD1Migrations.mockResolvedValue(['001_create_users.sql', '002_add_email.sql']);

    await runDbCommand(root, { action: 'restore', target: { bookmark }, yes: true });

    expect(mockRestoreCloudflareD1Database).toHaveBeenCalled();
    expect(mockLog.warn).not.toHaveBeenCalled();
    expect(output.printSuccess).toHaveBeenCalled();
  });

  function savedOnVoid(): string {
    const root = d1Project(false);
    mkdirSync(join(root, '.void'), { recursive: true });
    writeFileSync(join(root, '.void', 'project.json'), JSON.stringify({ platform: 'void' }));
    return root;
  }

  it('restores after a one-off Cloudflare deploy when --platform cloudflare is passed', async () => {
    const root = savedOnVoid();
    mockRestoreCloudflareD1Database.mockResolvedValue(previous);
    mockReadCloudflareD1Migrations.mockResolvedValue(['001_create_users.sql']);

    await runDbCommand(root, {
      action: 'restore',
      target: { bookmark },
      platform: 'cloudflare',
      yes: true,
    });

    expect(mockRestoreCloudflareD1Database).toHaveBeenCalledWith(
      expect.objectContaining({ migrateToken: 'app-db' }),
      { bookmark },
    );
    // The saved platform is Void, so the bare follow-up commands would not reach Cloudflare.
    expect(mockLog.info).toHaveBeenCalledWith(
      `To undo this restore, run \`void db restore --platform cloudflare --bookmark=${previous}\`.`,
    );
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('The next `void deploy --platform cloudflare` applies them.'),
    );
  });

  it('names the platform when the migrations cannot be read after a one-off restore', async () => {
    const root = savedOnVoid();
    mockRestoreCloudflareD1Database.mockResolvedValue(undefined);
    mockReadCloudflareD1Migrations.mockRejectedValue(new Error('network down'));

    await runDbCommand(root, {
      action: 'restore',
      target: { bookmark },
      platform: 'cloudflare',
      yes: true,
    });

    const warning = String(mockLog.warn.mock.calls[0]?.[0]);
    expect(warning).toContain('network down');
    expect(warning).toContain('`void deploy --platform cloudflare`');
    expect(warning).not.toContain('void db status');
  });

  it.each([
    [
      'has no Cloudflare deploy',
      () => createProjectRoot({}),
      'run it with `--platform cloudflare`',
    ],
    ['is saved on a Void platform', savedOnVoid, 'run it with `--platform cloudflare`'],
    [
      'uses PostgreSQL',
      () => {
        const root = createPgProjectRoot({});
        selectCloudflare(root);
        return root;
      },
      'restores D1 databases only',
    ],
  ])('refuses a project that %s', async (_name, makeRoot, message) => {
    const root = makeRoot();

    await expect(
      runDbCommand(root, { action: 'restore', target: { bookmark }, yes: true }),
    ).rejects.toThrow('process.exit:1');

    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(mockRestoreCloudflareD1Database).not.toHaveBeenCalled();
  });
});
