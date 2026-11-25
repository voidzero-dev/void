import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { Buffer } from '../../src/cli/node-buffer.ts';

const mockReadDeploymentPlatform = vi.fn(() => 'void');
const mockExecuteD1 =
  vi.fn<typeof import('../../src/cli/cloudflare-operations.ts').executeCloudflareD1Sql>();
const mockImportD1 =
  vi.fn<typeof import('../../src/cli/cloudflare-operations.ts').importCloudflareD1Sql>();
const mockD1Context = { binding: 'DB' };
vi.mock('../../src/cli/cloudflare-operations.ts', () => ({
  executeCloudflareD1Sql: (...args: Parameters<typeof mockExecuteD1>) => mockExecuteD1(...args),
  importCloudflareD1Sql: (...args: Parameters<typeof mockImportD1>) => mockImportD1(...args),
  resolveCloudflareD1Context: () => mockD1Context,
}));

const mockGetToken = vi.fn<() => string | null>(() => null);
const mockReadProjectConfig = vi.fn<() => { projectId: string; slug: string } | null>(() => null);
const mockGetProxyUrl = vi.fn<() => string>(() => 'https://proxy.void.cloud');

const mockGetResources = vi.fn<() => Promise<Array<{ type: string; binding_name: string }>>>(() =>
  Promise.resolve([]),
);
const mockGetDatabaseUrl = vi.fn<() => Promise<{ url: string }>>();
const mockEnsurePlatformAccessToken =
  vi.fn<typeof import('../../src/cli/cf-access.ts').ensurePlatformAccessToken>();

vi.mock('../../src/cli/auth', () => ({
  getProxyUrl: () => mockGetProxyUrl(),
  getToken: () => mockGetToken(),
}));

vi.mock('../../src/cli/project', () => ({
  readProjectConfig: () => mockReadProjectConfig(),
  readDeploymentPlatform: () => mockReadDeploymentPlatform(),
}));

vi.mock('../../src/cli/client', () => ({
  PlatformClient: class {
    apiUrl = 'https://api.void.cloud';
    getResources() {
      return mockGetResources();
    }
    getDatabaseUrl() {
      return mockGetDatabaseUrl();
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

vi.mock('../../src/cli/cf-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/cf-access.ts')>()),
  ensurePlatformProxyAccess: vi.fn(),
  ensurePlatformAccessToken: (...args: Parameters<typeof mockEnsurePlatformAccessToken>) =>
    mockEnsurePlatformAccessToken(...args),
}));

const mockPgConnect = vi.fn<() => Promise<void>>(() => Promise.resolve());
const mockPgEnd = vi.fn<() => Promise<void>>(() => Promise.resolve());
const mockPgQuery = vi.fn<() => Promise<{ rows: Array<Record<string, unknown>> }>>(() =>
  Promise.resolve({ rows: [] }),
);

vi.mock('pg', () => ({
  Client: class {
    connect = mockPgConnect;
    end = mockPgEnd;
    query = mockPgQuery;
  },
}));

const fetchMock = vi.fn<typeof fetch>();
let originalFetch: typeof globalThis.fetch | undefined;

const mockConfirm = vi.fn<(opts: { message: string }) => Promise<boolean | symbol>>();
const mockIsCancel = vi.fn<(value: unknown) => boolean>((v) => typeof v === 'symbol');

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  confirm: (opts: { message: string }) => mockConfirm(opts),
  isCancel: (v: unknown) => mockIsCancel(v),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

const roots: Array<string> = [];

function createProjectRoot(options: { database?: 'pg'; d1Binding?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'void-db-execute-remote-'));
  roots.push(root);

  const voidConfig: Record<string, unknown> = options.database === 'pg' ? { database: 'pg' } : {};
  if (options.d1Binding) {
    voidConfig.inference = { bindings: { db: options.d1Binding } };
  }
  writeFileSync(join(root, 'void.json'), JSON.stringify(voidConfig));

  return root;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('void db execute --remote (D1)', () => {
  let runDbCommand: typeof import('../../src/cli/db.ts').runDbCommand;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockReadDeploymentPlatform.mockReturnValue('void');
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    mockGetToken.mockReturnValue('test-token');
    mockReadProjectConfig.mockReturnValue({ projectId: 'proj-abc', slug: 'test-proj' });
    mockGetProxyUrl.mockReturnValue('https://proxy.void.cloud');
    mockGetResources.mockResolvedValue([]);
    mockEnsurePlatformAccessToken.mockReset();
    mockConfirm.mockResolvedValue(true);
    mockIsCancel.mockImplementation((v) => typeof v === 'symbol');

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    runDbCommand = (await import('../../src/cli/db.ts')).runDbCommand;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    'returns direct D1 query rows regardless of SQL size (large: %s)',
    async (large) => {
      mockReadDeploymentPlatform.mockReturnValue('cloudflare');
      mockExecuteD1.mockResolvedValue([{ answer: 42 }]);
      const sql = (large ? '/*' + 'comment '.repeat(4096) + '*/ ' : '') + 'SELECT 42 AS answer';
      await runDbCommand(createProjectRoot(), { action: 'execute', command: sql, remote: true });
      expect(mockExecuteD1).toHaveBeenCalledWith(mockD1Context, sql);
      expect(mockImportD1).not.toHaveBeenCalled();
      expect(vi.mocked(console.log).mock.calls.flat().join(' ')).toContain('42');
    },
  );

  // D1's maximum SQL statement length decides between the query API and a D1 import.
  const D1_STATEMENT_LIMIT = 100_000;
  function directD1File(sql: string, tty: boolean): string {
    mockReadDeploymentPlatform.mockReturnValue('cloudflare');
    mockImportD1.mockResolvedValue(undefined);
    mockExecuteD1.mockResolvedValue([{ answer: 42 }]);
    Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
    const root = createProjectRoot();
    writeFileSync(join(root, 'input.sql'), sql);
    return root;
  }
  // A read-only SELECT padded with a leading comment to exactly `bytes` UTF-8 bytes.
  function selectOfSize(bytes: number): string {
    const fixed = '-- \nSELECT 42 AS answer'.length;
    const padding = 'é'.repeat(Math.floor((bytes - fixed) / 2)) + 'x'.repeat((bytes - fixed) % 2);
    return `-- ${padding}\nSELECT 42 AS answer`;
  }
  const printed = () => vi.mocked(console.log).mock.calls.flat().join(' ');

  it.each([31, D1_STATEMENT_LIMIT])(
    'runs a direct D1 --file of %i bytes as a query and prints rows',
    async (bytes) => {
      const sql = selectOfSize(bytes);
      expect(Buffer.byteLength(sql)).toBe(bytes);
      const root = directD1File(sql, true);
      await runDbCommand(root, { action: 'execute', file: 'input.sql', remote: true });
      expect(mockExecuteD1).toHaveBeenCalledWith(mockD1Context, sql);
      expect(mockImportD1).not.toHaveBeenCalled();
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(printed()).toContain('42');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('imports a direct D1 --file over the statement limit after a warning and a TTY prompt', async () => {
    const { log } = await import('@voidzero-dev/vite-plus-prompts');
    const sql = selectOfSize(D1_STATEMENT_LIMIT + 1);
    const root = directD1File(sql, true);
    await runDbCommand(root, { action: 'execute', file: 'input.sql', remote: true });
    expect(vi.mocked(log.warn).mock.calls.flat().join(' ')).toContain('cannot serve queries');
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockImportD1).toHaveBeenCalledWith(mockD1Context, sql);
    expect(mockExecuteD1).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels a large direct D1 --file import when the prompt is declined', async () => {
    const root = directD1File(selectOfSize(D1_STATEMENT_LIMIT + 1), true);
    mockConfirm.mockResolvedValue(false);
    await expect(
      runDbCommand(root, { action: 'execute', file: 'input.sql', remote: true }),
    ).rejects.toThrow('process.exit:0');
    expect(mockImportD1).not.toHaveBeenCalled();
    expect(mockExecuteD1).not.toHaveBeenCalled();
  });

  it('warns and imports a large direct D1 --file without a prompt outside a TTY', async () => {
    const { log } = await import('@voidzero-dev/vite-plus-prompts');
    const sql = 'INSERT INTO samples VALUES (1);\n'.repeat(4000);
    const root = directD1File(sql, false);
    await runDbCommand(root, { action: 'execute', file: 'input.sql', remote: true });
    expect(vi.mocked(log.warn).mock.calls.flat().join(' ')).toContain('cannot serve queries');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockImportD1).toHaveBeenCalledWith(mockD1Context, sql);
  });

  it('POSTs to /d1/query with correct URL, body, and auth headers', async () => {
    const root = createProjectRoot();
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    await runDbCommand(root, { action: 'execute', command: 'SELECT 1', remote: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://proxy.void.cloud/d1/query');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-token');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      projectId: 'proj-abc',
      binding: 'DB',
      sql: 'SELECT 1',
      params: [],
      method: 'all',
    });
  });

  it('sends custom platform credentials only to its pinned proxy', async () => {
    const root = createProjectRoot();
    const proxyOrigin = 'https://void-company-proxy.example.workers.dev';
    mockGetProxyUrl.mockReturnValue(proxyOrigin);
    vi.stubEnv(
      'VOID_ACCESS_CREDENTIALS',
      JSON.stringify({
        'https://api.void.cloud': {
          CF_ACCESS_CLIENT_ID: 'api-id',
          CF_ACCESS_CLIENT_SECRET: 'api-secret',
        },
        [proxyOrigin]: {
          CF_ACCESS_CLIENT_ID: 'proxy-id',
          CF_ACCESS_CLIENT_SECRET: 'proxy-secret',
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    await runDbCommand(root, { action: 'execute', command: 'SELECT 1', remote: true });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://void-company-proxy.example.workers.dev/d1/query',
    );
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['CF-Access-Client-Id']).toBe('proxy-id');
    expect(headers['CF-Access-Client-Secret']).toBe('proxy-secret');
    expect(headers['CF-Access-Client-Id']).not.toBe('api-id');
  });

  it('renews a verified Access challenge and retries D1 once at the original proxy', async () => {
    const root = createProjectRoot();
    const proxyOrigin = 'https://proxy.example.com';
    mockGetProxyUrl.mockReturnValue(proxyOrigin);
    vi.stubEnv(
      'VOID_ACCESS_CREDENTIALS',
      JSON.stringify({ [proxyOrigin]: { CF_ACCESS_TOKEN: 'stale-user-token' } }),
    );
    mockEnsurePlatformAccessToken.mockImplementation(() => {
      vi.stubEnv(
        'VOID_ACCESS_CREDENTIALS',
        JSON.stringify({ [proxyOrigin]: { CF_ACCESS_TOKEN: 'fresh-user-token' } }),
      );
    });
    const challengeLocation =
      'https://team.cloudflareaccess.com/cdn-cgi/access/login/proxy.example.com';
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: challengeLocation } }),
      )
      .mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    await runDbCommand(root, { action: 'execute', command: 'SELECT 1', remote: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${proxyOrigin}/d1/query`,
      `${proxyOrigin}/d1/query`,
    ]);
    expect(fetchMock.mock.calls.some(([url]) => url === challengeLocation)).toBe(false);
    expect(mockEnsurePlatformAccessToken).toHaveBeenCalledWith(
      proxyOrigin,
      true,
      false,
      'stale-user-token',
    );
    const firstHeaders = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    const secondHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(firstHeaders['cf-access-token']).toBe('stale-user-token');
    expect(secondHeaders['cf-access-token']).toBe('fresh-user-token');
    expect(fetchMock.mock.calls.map(([, init]) => (init as RequestInit).redirect)).toEqual([
      'manual',
      'manual',
    ]);
  });

  it('does not retry a proxy Access challenge for scoped CI service credentials', async () => {
    const root = createProjectRoot();
    const proxyOrigin = 'https://proxy.example.com';
    mockGetProxyUrl.mockReturnValue(proxyOrigin);
    vi.stubEnv(
      'VOID_ACCESS_CREDENTIALS',
      JSON.stringify({
        [proxyOrigin]: {
          CF_ACCESS_CLIENT_ID: 'ci-id',
          CF_ACCESS_CLIENT_SECRET: 'ci-secret',
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          Location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/proxy.example.com',
        },
      }),
    );

    await expect(
      runDbCommand(root, { action: 'execute', command: 'SELECT 1', remote: true }),
    ).rejects.toThrow('process.exit:1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockEnsurePlatformAccessToken).not.toHaveBeenCalled();
  });

  it('uses the D1 binding name from getResources when available', async () => {
    const root = createProjectRoot();
    mockGetResources.mockResolvedValue([{ type: 'd1', binding_name: 'MY_DB' }]);
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    await runDbCommand(root, { action: 'execute', command: 'SELECT 1', remote: true });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.binding).toBe('MY_DB');
  });

  it('prefers the configured D1 binding over other D1 resources', async () => {
    const root = createProjectRoot({ d1Binding: 'MAIN_DB' });
    mockGetResources.mockResolvedValue([
      { type: 'd1', binding_name: 'DB' },
      { type: 'd1', binding_name: 'MAIN_DB' },
    ]);
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    await runDbCommand(root, { action: 'execute', command: 'SELECT 1', remote: true });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.binding).toBe('MAIN_DB');
  });

  it('keeps the configured binding when several D1 resources do not match it', async () => {
    const root = createProjectRoot();
    mockGetResources.mockResolvedValue([
      { type: 'd1', binding_name: 'OLD_A' },
      { type: 'd1', binding_name: 'OLD_B' },
    ]);
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    await runDbCommand(root, { action: 'execute', command: 'SELECT 1', remote: true });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.binding).toBe('DB');
  });

  it('falls back to binding DB when getResources has no d1 resource', async () => {
    const root = createProjectRoot();
    mockGetResources.mockResolvedValue([{ type: 'kv', binding_name: 'KV_STORE' }]);
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    await runDbCommand(root, { action: 'execute', command: 'SELECT 1', remote: true });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.binding).toBe('DB');
  });

  it('uses the configured d1 binding from void.json as fallback when getResources throws', async () => {
    const root = createProjectRoot({ d1Binding: 'MY_CUSTOM_DB' });
    mockGetResources.mockRejectedValue(new Error('network error'));
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    await runDbCommand(root, { action: 'execute', command: 'SELECT 1', remote: true });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.binding).toBe('MY_CUSTOM_DB');
  });

  it('renders a table when results are returned', async () => {
    const root = createProjectRoot();
    const rows = [{ id: 1, name: 'Alice' }];
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: rows, success: true }));

    const consoleSpy = vi.spyOn(console, 'log');
    await runDbCommand(root, { action: 'execute', command: 'SELECT * FROM users', remote: true });

    const output = consoleSpy.mock.calls.map(([line]) => String(line ?? '')).join('\n');
    expect(output).toContain('id');
    expect(output).toContain('name');
    expect(output).toContain('Alice');
  });

  it('errors when not logged in', async () => {
    const root = createProjectRoot();
    mockGetToken.mockReturnValue(null);

    await expect(
      runDbCommand(root, { action: 'execute', command: 'SELECT 1', remote: true }),
    ).rejects.toThrow('process.exit:1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('errors when no project is linked', async () => {
    const root = createProjectRoot();
    mockReadProjectConfig.mockReturnValue(null);

    await expect(
      runDbCommand(root, { action: 'execute', command: 'SELECT 1', remote: true }),
    ).rejects.toThrow('process.exit:1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends --file SQL to the D1 proxy like inline SQL', async () => {
    const root = createProjectRoot();
    const fileSql = 'INSERT INTO t VALUES (1);\nINSERT INTO t VALUES (2);\n';
    writeFileSync(join(root, 'seed.sql'), fileSql);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    await runDbCommand(root, { action: 'execute', file: 'seed.sql', remote: true });

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.sql).toBe(fileSql);
  });

  it('errors on proxy non-OK response', async () => {
    const root = createProjectRoot();
    fetchMock.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

    await expect(
      runDbCommand(root, { action: 'execute', command: 'SELECT 1', remote: true }),
    ).rejects.toThrow('process.exit:1');
  });

  it('prompts for confirmation on destructive statement in TTY', async () => {
    const root = createProjectRoot();
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockConfirm.mockResolvedValue(true);
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    await runDbCommand(root, { action: 'execute', command: 'DELETE FROM users', remote: true });

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const confirmCall = mockConfirm.mock.calls[0][0];
    expect(confirmCall.message).toContain('deployed database');
  });

  it('aborts when user declines destructive confirmation', async () => {
    const root = createProjectRoot();
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockConfirm.mockResolvedValue(false);

    await expect(
      runDbCommand(root, { action: 'execute', command: 'DROP TABLE users', remote: true }),
    ).rejects.toThrow('process.exit:0');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Comments are stripped before the check. EXPLAIN ANALYZE in any form and WITH
  // (a CTE can write) always prompt.
  it.each<[string, boolean]>([
    ['SELECT * FROM users', false],
    ['EXPLAIN SELECT * FROM users', false],
    ['EXPLAIN (VERBOSE) SELECT 1', false],
    ['-- header\nSELECT 1', false],
    ['SELECT 1;', false],
    ["SELECT '--'", false],
    ["SELECT '--' ; DROP TABLE users", true],
    ["SELECT '/*' ; DROP TABLE users", true],
    ['-- a; comment\nSELECT 1', true],
    ['EXPLAIN ANALYZE DELETE FROM users', true],
    ['EXPLAIN (ANALYZE) DELETE FROM users', true],
    ['EXPLAIN (ANALYZE TRUE) UPDATE users SET name = $1', true],
    ['EXPLAIN (ANALYZE FALSE) SELECT 1', true],
    ['EXPLAIN /*x*/ ANALYZE DELETE FROM users', true],
    ['EXPLAIN -- comment\n ANALYZE DELETE FROM users', true],
    ['EXPLAIN /*opts*/ (ANALYZE) DELETE FROM users', true],
    ['/* leading */ EXPLAIN ANALYZE DELETE FROM users', true],
    ['WITH cte AS (SELECT 1) SELECT * FROM cte', true],
  ])('confirmation prompt for %j in TTY: %s', async (command, prompts) => {
    const root = createProjectRoot();
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    await runDbCommand(root, { action: 'execute', command, remote: true });

    expect(mockConfirm).toHaveBeenCalledTimes(prompts ? 1 : 0);
  });

  it('skips confirmation for UPDATE when not in TTY (non-interactive)', async () => {
    const root = createProjectRoot();
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    await runDbCommand(root, { action: 'execute', command: 'DELETE FROM users', remote: true });

    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('skips the destructive prompt in a TTY with --yes', async () => {
    const root = createProjectRoot();
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], success: true }));

    await runDbCommand(root, {
      action: 'execute',
      command: 'DELETE FROM users',
      remote: true,
      yes: true,
    });

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('imports a large direct D1 --file in a TTY without a prompt with --yes', async () => {
    const sql = selectOfSize(D1_STATEMENT_LIMIT + 1);
    const root = directD1File(sql, true);
    await runDbCommand(root, { action: 'execute', file: 'input.sql', remote: true, yes: true });
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockImportD1).toHaveBeenCalledWith(mockD1Context, sql);
  });

  it('runs execute without --remote against the local database, not the proxy', async () => {
    const root = createProjectRoot();
    // No local database exists, so the local path exits.
    await expect(runDbCommand(root, { action: 'execute', command: 'SELECT 1' })).rejects.toThrow(
      'process.exit:1',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('void db execute --remote (PostgreSQL)', () => {
  let runDbCommand: typeof import('../../src/cli/db.ts').runDbCommand;

  beforeEach(async () => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    mockGetToken.mockReturnValue('test-token');
    mockReadProjectConfig.mockReturnValue({ projectId: 'proj-abc', slug: 'test-proj' });
    mockPgConnect.mockResolvedValue(undefined);
    mockPgEnd.mockResolvedValue(undefined);
    mockPgQuery.mockResolvedValue({ rows: [] });
    mockConfirm.mockResolvedValue(true);
    mockIsCancel.mockImplementation((v) => typeof v === 'symbol');

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    runDbCommand = (await import('../../src/cli/db.ts')).runDbCommand;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fetches the database URL via getDatabaseUrl and connects with it', async () => {
    const root = createProjectRoot({ database: 'pg' });
    const dbUrl = 'postgres://user:pass@host:5432/mydb';
    mockGetDatabaseUrl.mockResolvedValue({ url: dbUrl });
    mockPgQuery.mockResolvedValue({ rows: [] });

    await runDbCommand(root, {
      action: 'execute',
      command: 'SELECT 1',
      remote: true,
    });

    expect(mockGetDatabaseUrl).toHaveBeenCalledTimes(1);
    expect(mockPgConnect).toHaveBeenCalledTimes(1);
    expect(mockPgQuery).toHaveBeenCalledWith('SELECT 1');
    expect(mockPgEnd).toHaveBeenCalledTimes(1);
  });

  it('renders a table when rows are returned', async () => {
    const root = createProjectRoot({ database: 'pg' });
    mockGetDatabaseUrl.mockResolvedValue({ url: 'postgres://host/db' });
    mockPgQuery.mockResolvedValue({ rows: [{ id: 1, name: 'Bob' }] });

    const consoleSpy = vi.spyOn(console, 'log');
    await runDbCommand(root, {
      action: 'execute',
      command: 'SELECT * FROM users',
      remote: true,
    });

    const output = consoleSpy.mock.calls.map(([line]) => String(line ?? '')).join('\n');
    expect(output).toContain('id');
    expect(output).toContain('name');
    expect(output).toContain('Bob');
  });

  it('surfaces a friendly error on 404 (database URL not stored)', async () => {
    const root = createProjectRoot({ database: 'pg' });

    // Simulate the PlatformApiError that getDatabaseUrl throws on 404
    const { PlatformApiError } = await import('../../src/cli/client.ts');
    mockGetDatabaseUrl.mockRejectedValue(new PlatformApiError('test', 404, '{}'));

    const { log: clackLog } = await import('@voidzero-dev/vite-plus-prompts');

    await expect(
      runDbCommand(root, {
        action: 'execute',
        command: 'SELECT 1',
        remote: true,
      }),
    ).rejects.toThrow('process.exit:1');

    const errorCalls = (clackLog.error as ReturnType<typeof vi.fn>).mock.calls
      .map((c: Array<unknown>) => String(c[0]))
      .join('\n');
    expect(errorCalls).toContain('void db set-url');
  });

  it('re-throws non-404 errors from getDatabaseUrl', async () => {
    const root = createProjectRoot({ database: 'pg' });

    const { PlatformApiError } = await import('../../src/cli/client.ts');
    mockGetDatabaseUrl.mockRejectedValue(new PlatformApiError('test', 403, '{}'));

    await expect(
      runDbCommand(root, {
        action: 'execute',
        command: 'SELECT 1',
        remote: true,
      }),
    ).rejects.toThrow(PlatformApiError);
  });
});
