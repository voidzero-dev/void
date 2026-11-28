import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mockGetToken = vi.fn<() => string | null>(() => null);
const mockReadProjectConfig = vi.fn<() => { projectId: string; slug: string } | null>(() => null);

const mockGetDatabaseUrl = vi.fn<() => Promise<{ url: string }>>();

vi.mock('../../src/cli/auth', () => ({
  getToken: () => mockGetToken(),
}));

vi.mock('../../src/cli/project', () => ({
  readProjectConfig: () => mockReadProjectConfig(),
  readDeploymentPlatform: () => 'void',
}));

vi.mock('../../src/cli/client', () => ({
  PlatformClient: class {
    getDatabaseUrl() {
      return mockGetDatabaseUrl();
    }
    getResources() {
      return Promise.resolve([]);
    }
  },
  PlatformApiError: class extends Error {
    status: number;
    body: string;
    constructor(action: string, status: number, body: string) {
      super(`${action}: ${status} ${body}`);
      this.status = status;
      this.body = body;
    }
  },
}));

const PRIVATE_CONFIG_PATH = join(tmpdir(), 'void-drizzle-test', 'drizzle.config.json');

// Mock the drizzle config writers to avoid needing a real schema on disk.
const mockWriteDrizzleConfig = vi.fn<(root: string, dbPath: string, dialect?: string) => string>(
  (root, _dbPath, _dialect) => join(root, '.void', 'drizzle.config.json'),
);
const mockWithPrivateDrizzleConfig = vi.fn(
  (_root: string, _dbUrl: string, _dialect: string, run: (configPath: string) => unknown) =>
    run(PRIVATE_CONFIG_PATH),
);

vi.mock('../../src/drizzle/config.ts', () => ({
  writeDrizzleConfig: (...args: Array<unknown>) =>
    mockWriteDrizzleConfig(...(args as Parameters<typeof mockWriteDrizzleConfig>)),
  withPrivateDrizzleConfig: (...args: Array<unknown>) =>
    mockWithPrivateDrizzleConfig(...(args as Parameters<typeof mockWithPrivateDrizzleConfig>)),
}));

const mockSpawnSync = vi.fn<(file: string, args: Array<string>) => { status: number }>(() => ({
  status: 0,
}));

vi.mock('node:child_process', () => ({
  spawnSync: (...args: Parameters<typeof mockSpawnSync>) => mockSpawnSync(...args),
}));

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn((v: unknown) => typeof v === 'symbol'),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

const roots: Array<string> = [];

function expectDrizzleKitRunWithPrivateConfig(command: 'push' | 'studio'): void {
  expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  const cliArgs = mockSpawnSync.mock.calls[0][1];
  expect(cliArgs.slice(-3)).toEqual([command, '--config', PRIVATE_CONFIG_PATH]);
}

function createProjectRoot(options: { database?: 'pg' } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'void-db-studio-remote-'));
  roots.push(root);

  const voidConfig = options.database === 'pg' ? { database: 'pg' } : {};
  writeFileSync(join(root, 'void.json'), JSON.stringify(voidConfig));

  return root;
}

describe('void db studio --remote (PostgreSQL)', () => {
  let runDbCommand: typeof import('../../src/cli/db.ts').runDbCommand;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockGetToken.mockReturnValue('test-token');
    mockReadProjectConfig.mockReturnValue({ projectId: 'proj-abc', slug: 'test-proj' });

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

  it('runs drizzle-kit studio with a private config holding the fetched database URL', async () => {
    const root = createProjectRoot({ database: 'pg' });
    const dbUrl = 'postgres://user:pass@host:5432/mydb';
    mockGetDatabaseUrl.mockResolvedValue({ url: dbUrl });

    await runDbCommand(root, { action: 'studio', remote: true });

    expect(mockGetDatabaseUrl).toHaveBeenCalledTimes(1);
    expect(mockWithPrivateDrizzleConfig).toHaveBeenCalledWith(
      root,
      dbUrl,
      'postgresql',
      expect.any(Function),
    );
    expect(mockWriteDrizzleConfig).not.toHaveBeenCalled();
    expectDrizzleKitRunWithPrivateConfig('studio');
  });

  it('exits with code 1 when drizzle-kit studio fails', async () => {
    const root = createProjectRoot({ database: 'pg' });
    mockGetDatabaseUrl.mockResolvedValue({ url: 'postgres://user:pass@host:5432/mydb' });
    mockSpawnSync.mockReturnValueOnce({ status: 2 });

    await expect(runDbCommand(root, { action: 'studio', remote: true })).rejects.toThrow(
      'process.exit:1',
    );
    expect(mockWithPrivateDrizzleConfig).toHaveBeenCalledTimes(1);
  });

  it('errors when not logged in', async () => {
    const root = createProjectRoot({ database: 'pg' });
    mockGetToken.mockReturnValue(null);

    await expect(runDbCommand(root, { action: 'studio', remote: true })).rejects.toThrow(
      'process.exit:1',
    );
    expect(mockGetDatabaseUrl).not.toHaveBeenCalled();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('errors when no project is linked', async () => {
    const root = createProjectRoot({ database: 'pg' });
    mockReadProjectConfig.mockReturnValue(null);

    await expect(runDbCommand(root, { action: 'studio', remote: true })).rejects.toThrow(
      'process.exit:1',
    );
    expect(mockGetDatabaseUrl).not.toHaveBeenCalled();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });
});

describe('void db studio --remote (D1)', () => {
  let runDbCommand: typeof import('../../src/cli/db.ts').runDbCommand;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockGetToken.mockReturnValue('test-token');
    mockReadProjectConfig.mockReturnValue({ projectId: 'proj-abc', slug: 'test-proj' });

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

  it('rejects remote D1 Studio before writing a config or running Drizzle Kit', async () => {
    const root = createProjectRoot();

    const { log: clackLog } = await import('@voidzero-dev/vite-plus-prompts');

    await expect(runDbCommand(root, { action: 'studio', remote: true })).rejects.toThrow(
      'process.exit:1',
    );

    const errorCalls = (clackLog.error as ReturnType<typeof vi.fn>).mock.calls
      .map((c: Array<unknown>) => String(c[0]))
      .join('\n');
    expect(errorCalls).toContain('PostgreSQL and MySQL');
    expect(errorCalls).toContain('void db execute --remote');

    expect(mockWriteDrizzleConfig).not.toHaveBeenCalled();
    expect(mockWithPrivateDrizzleConfig).not.toHaveBeenCalled();
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(mockGetDatabaseUrl).not.toHaveBeenCalled();
  });
});

describe('void db studio and push (local)', () => {
  let runDbCommand: typeof import('../../src/cli/db.ts').runDbCommand;

  beforeEach(async () => {
    vi.clearAllMocks();

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

  it('local D1 studio exits when no local database exists', async () => {
    const root = createProjectRoot();

    const { log: clackLog } = await import('@voidzero-dev/vite-plus-prompts');

    await expect(runDbCommand(root, { action: 'studio' })).rejects.toThrow('process.exit:1');

    expect(clackLog.error).toHaveBeenCalledWith(
      'No local database found. Start the dev server first.',
    );
    expect(mockGetDatabaseUrl).not.toHaveBeenCalled();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('local PG studio errors when .env has no DATABASE_URL', async () => {
    const root = createProjectRoot({ database: 'pg' });

    await expect(runDbCommand(root, { action: 'studio' })).rejects.toThrow(
      'DATABASE_URL not found in .env',
    );

    expect(mockGetDatabaseUrl).not.toHaveBeenCalled();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('local PG studio passes the .env database URL through a private config', async () => {
    const root = createProjectRoot({ database: 'pg' });
    const dbUrl = 'postgres://local:pass@localhost:5432/dev';
    writeFileSync(join(root, '.env'), `DATABASE_URL=${dbUrl}\n`);

    await runDbCommand(root, { action: 'studio' });

    expect(mockGetDatabaseUrl).not.toHaveBeenCalled();
    expect(mockWithPrivateDrizzleConfig).toHaveBeenCalledWith(
      root,
      dbUrl,
      'postgresql',
      expect.any(Function),
    );
    expect(mockWriteDrizzleConfig).not.toHaveBeenCalled();
    expectDrizzleKitRunWithPrivateConfig('studio');
  });

  it('PG push passes the .env database URL through a private config', async () => {
    const root = createProjectRoot({ database: 'pg' });
    const dbUrl = 'postgres://local:pass@localhost:5432/dev';
    writeFileSync(join(root, '.env'), `DATABASE_URL=${dbUrl}\n`);

    await runDbCommand(root, { action: 'push' });

    expect(mockWithPrivateDrizzleConfig).toHaveBeenCalledWith(
      root,
      dbUrl,
      'postgresql',
      expect.any(Function),
    );
    expect(mockWriteDrizzleConfig).not.toHaveBeenCalled();
    expectDrizzleKitRunWithPrivateConfig('push');
  });
});
