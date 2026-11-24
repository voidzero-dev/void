import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

const CLI_ENTRY = join(import.meta.dirname, '..', '..', 'dist', 'cli', 'cli.mjs');
let directory: string;
let server: Server;
let origin: string;
const requests: Array<{
  path: string;
  authorization?: string;
  method?: string;
  body: Record<string, unknown>;
}> = [];
let reply: (path: string, body: Record<string, unknown>) => { status?: number; body: unknown };

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'void-operator-subprocess-'));
  requests.length = 0;
  reply = (path, body) =>
    body.dryRun
      ? { body: { dryRun: true, action: 'user.delete', target: 'user-1' } }
      : path === '/operator/v1/users'
        ? { body: { users: [{ id: 'user-1' }], page: 1, limit: 25, total: 1 } }
        : { body: { ok: true } };
  server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) {
      text += String(chunk);
    }
    const body = text ? JSON.parse(text) : {};
    requests.push({
      path: request.url!,
      authorization: request.headers.authorization,
      method: request.method,
      body,
    });
    const result = reply(request.url!, body);
    response.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing server address');
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  rmSync(directory, { recursive: true, force: true });
});

function run(
  args: Array<string>,
  options: { input?: string; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, 'platform', ...args], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        USERPROFILE: directory,
        VOID_PLATFORM_REGISTRY_DIR: join(directory, 'registry'),
        VOID_API_URL: origin,
        VOID_OPERATOR_TOKEN: 'test-operator',
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += String(data);
    });
    child.stderr.on('data', (data) => {
      stderr += String(data);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.stdin.end(options.input);
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function runPty(args: Array<string>): Promise<{ output: string; code: number }> {
  return new Promise((resolve, reject) => {
    const command = [process.execPath, CLI_ENTRY, 'platform', ...args];
    const scriptArgs =
      process.platform === 'darwin'
        ? ['-q', '-e', '/dev/null', ...command]
        : ['-q', '-e', '-c', command.map(shellQuote).join(' '), '/dev/null'];
    const input = openSync('/dev/null', 'r');
    const child = spawn('/usr/bin/script', scriptArgs, {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        USERPROFILE: directory,
        VOID_PLATFORM_REGISTRY_DIR: join(directory, 'registry'),
        VOID_API_URL: origin,
        VOID_OPERATOR_TOKEN: 'test-operator',
      },
      stdio: [input, 'pipe', 'pipe'],
    });
    closeSync(input);
    let output = '';
    child.stdout!.on('data', (data) => {
      output += String(data);
    });
    child.stderr!.on('data', (data) => {
      output += String(data);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ output, code: code ?? 1 }));
  });
}

describe('operator CLI (real subprocess and HTTP)', () => {
  it('ignores repository platform metadata and emits clean paginated JSON', async () => {
    mkdirSync(join(directory, '.void'));
    writeFileSync(
      join(directory, '.void', 'project.json'),
      JSON.stringify({
        apiUrl: 'https://untrusted.example',
        projectId: 'project-1',
        slug: 'untrusted',
      }),
    );
    const result = await run(['user', 'list', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ users: [{ id: 'user-1' }], page: 1 });
    expect(result.stderr).toBe('');
    expect(requests[0]).toMatchObject({
      path: '/operator/v1/users',
      authorization: 'Bearer test-operator',
    });
  });
  it.runIf(process.platform !== 'win32' && existsSync('/usr/bin/script'))(
    'honors leading operator flags in a real pseudo-terminal',
    async () => {
      const result = await runPty(['--json', 'user', 'list']);
      expect(result.code, result.output).toBe(0);
      const jsonStart = result.output.indexOf('{');
      expect(jsonStart, result.output).toBeGreaterThanOrEqual(0);
      expect(JSON.parse(result.output.slice(jsonStart).trim())).toMatchObject({
        users: [{ id: 'user-1' }],
        page: 1,
      });
      expect(requests).toHaveLength(1);
    },
  );
  it('validates and previews without mutation, then applies exactly once with explicit yes', async () => {
    const blocked = await run(['user', 'delete', 'user-1', '--json']);
    expect(blocked.code).toBe(1);
    expect(blocked.stdout).toBe('');
    expect(JSON.parse(blocked.stderr)).toMatchObject({ error: 'confirmation_required' });
    expect(requests).toHaveLength(0);
    const plan = await run(['user', 'delete', 'user-1', '--plan', '--json']);
    expect(plan.code).toBe(0);
    expect(JSON.parse(plan.stdout)).toMatchObject({ origin, dryRun: true, target: 'user-1' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toEqual({ dryRun: true });
    requests.length = 0;
    const applied = await run(['user', 'delete', 'user-1', '--yes', '--json']);
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.stdout)).toEqual({ ok: true });
    expect(applied.stderr).toBe('');
    expect(requests.map(({ body }) => body)).toEqual([{ dryRun: true }, {}]);
  });
  it('previews and applies project ownership transfer with the target user ID', async () => {
    reply = (_path, body) =>
      body.dryRun
        ? { body: { dryRun: true, action: 'project.owner', target: 'project-1' } }
        : { body: { ok: true, owner: { id: 'user-2' } } };
    const result = await run(['project', 'owner', 'project-1', 'user-2', '--yes', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ owner: { id: 'user-2' } });
    expect(requests).toEqual([
      expect.objectContaining({
        path: '/operator/v1/projects/project-1/owner',
        body: { userId: 'user-2', dryRun: true },
      }),
      expect.objectContaining({
        path: '/operator/v1/projects/project-1/owner',
        body: { userId: 'user-2' },
      }),
    ]);
  });
  it('prints structured argument failures without network calls', async () => {
    const result = await run(['user', 'list', '--limit', '10000', '--json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ error: 'invalid_command' });
    expect(requests).toHaveLength(0);
  });
  it('fails partial mutations with details and does not retry', async () => {
    reply = (_path, body) =>
      body.dryRun
        ? { body: { dryRun: true, action: 'project.delete', target: 'project-1' } }
        : { status: 207, body: { ok: false, partial: true, failed: ['resource-1'] } };
    const result = await run(['project', 'delete', 'project-1', '--yes', '--json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      error: 'partial_failure',
      message: 'The operation did not fully complete. Inspect the partial result before retrying.',
      status: 207,
      details: { ok: false, partial: true, failed: ['resource-1'] },
    });
    expect(requests).toHaveLength(2);
  });
  it('fails degraded worker reads with readable human and JSON details', async () => {
    reply = (path) =>
      path === '/operator/v1/workers/api'
        ? {
            body: {
              ok: false,
              partial: true,
              worker: { name: 'api' },
              versions: [{ id: 'version-1' }],
              error: 'Cloudflare versions unavailable.',
            },
          }
        : {
            body: {
              ok: false,
              partial: true,
              workers: [
                { worker: { name: 'api' }, error: 'Cloudflare deployments unavailable.' },
                { worker: { name: 'dashboard' }, deployment: { id: 'deployment-1' } },
              ],
            },
          };

    const human = await run(['worker', 'show', 'api']);
    expect(human.code).toBe(1);
    expect(human.stdout).toBe('');
    expect(human.stderr).toContain('The operation did not fully complete.');
    expect(human.stderr).toContain('"id": "version-1"');
    expect(human.stderr).toContain('Cloudflare versions unavailable.');

    const json = await run(['worker', 'list', '--json']);
    expect(json.code).toBe(1);
    expect(json.stdout).toBe('');
    expect(JSON.parse(json.stderr)).toMatchObject({
      error: 'partial_failure',
      details: {
        ok: false,
        partial: true,
        workers: expect.arrayContaining([
          expect.objectContaining({ error: 'Cloudflare deployments unavailable.' }),
          expect.objectContaining({ deployment: { id: 'deployment-1' } }),
        ]),
      },
    });
    expect(requests).toHaveLength(2);
  });
  it('prints every rollback outcome when a human mutation partially fails', async () => {
    reply = (_path, body) =>
      body.dryRun
        ? {
            body: {
              dryRun: true,
              action: 'worker.rollback-all',
              target: 'production',
              versions: { api: 'version-api', dispatch: 'version-dispatch' },
            },
          }
        : {
            status: 207,
            body: {
              ok: false,
              partial: true,
              batchId: 'batch-1',
              environment: 'production',
              events: [
                {
                  worker_name: 'api',
                  version_id: 'version-api',
                  status: 'success',
                  error_message: null,
                },
                {
                  worker_name: 'dispatch',
                  version_id: 'version-dispatch',
                  status: 'failed',
                  error_message: 'Version no longer exists.',
                },
                {
                  worker_name: 'proxy',
                  version_id: 'version-proxy',
                  status: 'skipped',
                  error_message: null,
                },
              ],
            },
          };

    const result = await run(['worker', 'rollback-all', '--yes']);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Partial result:');
    expect(result.stderr).toContain('"batchId": "batch-1"');
    expect(result.stderr).toContain('"version_id": "version-api"');
    expect(result.stderr).toContain('"status": "success"');
    expect(result.stderr).toContain('"version_id": "version-dispatch"');
    expect(result.stderr).toContain('"status": "failed"');
    expect(result.stderr).toContain('"error_message": "Version no longer exists."');
    expect(result.stderr).toContain('"version_id": "version-proxy"');
    expect(result.stderr).toContain('"status": "skipped"');
    expect(requests).toHaveLength(2);
  });
  it('prints data keys such as worker names as they are', async () => {
    reply = () => ({
      body: {
        dryRun: true,
        action: 'worker.rollback-all',
        target: 'production',
        versions: { 'email-gateway': 'version-gateway', 'void-api-staging': 'version-api' },
        createdAt: '2026-01-01T00:00:00Z',
      },
    });

    const result = await run(['worker', 'rollback-all', '--plan']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('email-gateway: version-gateway');
    expect(result.stdout).toContain('void-api-staging: version-api');
    expect(result.stdout).not.toContain('Email gateway');
    expect(result.stdout).toContain('Created at: 2026-01-01T00:00:00Z');
  });
  it('labels refusal details as details, not as a partial result', async () => {
    reply = () => ({
      status: 501,
      body: {
        error: 'capability_unavailable',
        message: 'Manage this self-hosted Void platform with `void platform upgrade`.',
        details: { capability: 'hosted-platform-operations' },
      },
    });

    const result = await run(['worker', 'list']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Manage this self-hosted Void platform');
    expect(result.stderr).toContain('Details:');
    expect(result.stderr).toContain('"capability": "hosted-platform-operations"');
    expect(result.stderr).not.toContain('Partial result');
  });
  it('exchanges piped API sessions only on explicit auth token invocation', async () => {
    reply = () => ({
      body: {
        token: 'new-operator-token',
        expiresAt: '2030-01-01T00:00:00Z',
        user: { id: 'admin' },
        apiVersion: 1,
      },
    });
    const result = await run(['auth', 'token', '--token-stdin', '--json'], {
      input: 'full-api-session\n',
      env: { VOID_OPERATOR_TOKEN: '' },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ token: 'new-operator-token', origin });
    expect(requests).toEqual([
      {
        path: '/operator/v1/session',
        method: 'POST',
        authorization: 'Bearer full-api-session',
        body: {},
      },
    ]);
  });
  it('follows build logs to a terminal state with JSON Lines output', async () => {
    reply = () => ({
      body: {
        lines: [{ seq: 1, line: 'Build complete', stream: 'stdout', ts: 1 }],
        lastSeq: 1,
        terminal: true,
        logsComplete: true,
        status: 'completed',
      },
    });
    const result = await run(['build', 'logs', 'build-1', '--follow', '--since', '0', '--json']);
    expect(result.code).toBe(0);
    expect(
      result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([expect.objectContaining({ lastSeq: 1, terminal: true, logsComplete: true })]);
    expect(requests).toEqual([
      expect.objectContaining({ path: '/operator/v1/builds/build-1/logs?since=0' }),
    ]);
  });
  it('renders human tables and fails unhealthy monitoring checks without losing details', async () => {
    const users = await run(['user', 'list']);
    expect(users.code).toBe(0);
    expect(users.stdout).toContain('ID');
    expect(users.stdout).toContain('user-1');
    expect(users.stdout).not.toContain('"users"');
    reply = () => ({ body: { checks: [{ name: 'database', ok: false }], allOk: false } });
    const health = await run(['system', 'health', '--json']);
    expect(health.code).toBe(1);
    expect(JSON.parse(health.stdout)).toMatchObject({
      allOk: false,
      checks: [{ name: 'database', ok: false }],
    });
  });

  it('prints deep help without authenticating or making requests', async () => {
    const result = await run(['worker', 'rollback-all', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--plan');
    expect(result.stdout).toContain('--connection');
    expect(requests).toHaveLength(0);
  });
});
