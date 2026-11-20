import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { cleanups, temporaryDirectory } from '../helpers/cloudflare-operation-process.ts';

// Record what the CLI hands to each child process, without changing what runs.
const spawned: Array<{ argvBytes: number; largestEnvValueBytes: number }> = [];
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: ((command: string, args: Array<string>, options: { env?: NodeJS.ProcessEnv }) => {
      spawned.push({
        argvBytes: [command, ...args].reduce((total, arg) => total + Buffer.byteLength(arg), 0),
        largestEnvValueBytes: Math.max(
          0,
          ...Object.values(options.env ?? {}).map((value) => Buffer.byteLength(value ?? '')),
        ),
      });
      return actual.spawnSync(command, args, options as never);
    }) as typeof actual.spawnSync,
  };
});

const mockConfirm = vi.fn();
const mockWarn = vi.fn();
vi.mock('@voidzero-dev/vite-plus-prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voidzero-dev/vite-plus-prompts')>()),
  confirm: (...args: Array<unknown>) => mockConfirm(...args),
  log: { error: vi.fn(), info: vi.fn(), step: vi.fn(), success: vi.fn(), warn: mockWarn },
}));

// The CLI waits on spawnSync, which blocks this process, so the fake D1 API runs in its own.
const fakeD1Api = `
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
const report = (entry) => process.stdout.write(JSON.stringify(entry) + '\\n');
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const origin = 'http://127.0.0.1:' + server.address().port;
  if (request.method === 'PUT') {
    const etag = createHash('md5').update(body).digest('hex');
    report({ upload: body.length, etag, authorization: request.headers.authorization ?? null });
    response.setHeader('etag', '"' + etag + '"');
    response.end();
    return;
  }
  const input = JSON.parse(body.toString('utf8'));
  report({ url: request.url, input, authorization: request.headers.authorization });
  const result =
    input.action === 'init'
      ? { filename: 'catalog.sql', upload_url: origin + '/upload' }
      : input.action === 'ingest'
        ? { success: true, status: 'active', at_bookmark: 'bookmark-1' }
        : { success: true, status: 'complete', result: { num_queries: 1 } };
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ success: true, result }));
});
server.listen(0, '127.0.0.1', () => report({ port: server.address().port }));
`;

async function startFakeD1Api(directory: string) {
  const script = join(directory, 'fake-d1-api.mjs');
  writeFileSync(script, fakeD1Api);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  cleanups.push(() => child.kill());
  const entries: Array<Record<string, unknown>> = [];
  const port = await new Promise<number>((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`fake D1 API exited with ${code}`)));
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (typeof entry.port === 'number') {
        resolve(entry.port);
      } else {
        entries.push(entry);
      }
    });
  });
  // The last report can still be in the pipe when the CLI returns.
  const settled = async (count: number) => {
    for (let attempt = 0; entries.length < count && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return entries;
  };
  return { origin: `http://127.0.0.1:${port}`, settled };
}

let stdinIsTTY: PropertyDescriptor | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (stdinIsTTY) {
    Object.defineProperty(process.stdin, 'isTTY', stdinIsTTY);
  } else {
    delete (process.stdin as { isTTY?: boolean }).isTTY;
  }
});

it('imports a 25 MB SQL file into direct Cloudflare D1 in CI without a prompt or a large argv', async () => {
  const root = temporaryDirectory('void-d1-large-file-');
  writeFileSync(join(root, 'void.json'), '{}');
  mkdirSync(join(root, '.void'));
  writeFileSync(join(root, '.void', 'project.json'), JSON.stringify({ platform: 'cloudflare' }));
  writeFileSync(
    join(root, 'wrangler.json'),
    JSON.stringify({
      name: 'catalog-worker',
      account_id: 'test-account',
      d1_databases: [{ binding: 'DB', database_name: 'catalog', database_id: 'test-database' }],
    }),
  );
  const row = "INSERT INTO cards (id, name) VALUES (1, 'synthetic card name');\n";
  const sql = row.repeat(Math.ceil((25 * 1024 * 1024) / row.length));
  writeFileSync(join(root, 'catalog.sql'), sql);
  const etag = createHash('md5').update(sql).digest('hex');

  const api = await startFakeD1Api(root);
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'synthetic-token');
  vi.stubEnv('CLOUDFLARE_API_BASE_URL', `${api.origin}/client/v4`);
  vi.stubEnv('CI', 'true');
  stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});

  const { runDbCommand } = await import('../../src/cli/db.ts');
  await runDbCommand(root, { action: 'execute', file: 'catalog.sql', remote: true });

  expect(mockConfirm).not.toHaveBeenCalled();
  expect(mockWarn.mock.calls.flat().join(' ')).toContain('runs it as a D1 import');
  const importUrl = '/client/v4/accounts/test-account/d1/database/test-database/import';
  expect(await api.settled(4)).toEqual([
    { url: importUrl, input: { action: 'init', etag }, authorization: 'Bearer synthetic-token' },
    { upload: Buffer.byteLength(sql), etag, authorization: null },
    {
      url: importUrl,
      input: { action: 'ingest', etag, filename: 'catalog.sql' },
      authorization: 'Bearer synthetic-token',
    },
    {
      url: importUrl,
      input: { action: 'poll', current_bookmark: 'bookmark-1' },
      authorization: 'Bearer synthetic-token',
    },
  ]);
  // Nothing proportional to the file reaches a child's argv or environment.
  expect(spawned.length).toBeGreaterThan(0);
  for (const child of spawned) {
    expect(child.argvBytes).toBeLessThan(16 * 1024);
    expect(child.largestEnvValueBytes).toBeLessThan(16 * 1024);
  }
}, 60_000);
