import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, expect, onTestFinished, test, vi } from 'vite-plus/test';
import { aiLoggingKey } from '../../src/ai-logging-policy.ts';
import { getUser } from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { app } from '../../src/index.ts';
import { readPlanCatalog } from '../../src/plans.ts';
import { deriveAiUsageTag, deriveProxyToken } from '../../src/proxy-token.ts';
import {
  clearTables,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';
import { createUsageCounterFixture } from './usage-counter-fixture.ts';

const cli = fileURLToPath(
  new URL('../../../../../packages/void/dist/cli/cli.mjs', import.meta.url),
);
let env: TestEnv;
let server: Server;
let origin: string;
let operatorToken: string;
let requests: number;

beforeAll(async () => {
  env = await setupEnv();
  server = createServer(async (incoming, outgoing) => {
    requests++;
    try {
      const parts: Array<Buffer> = [];
      for await (const part of incoming) {
        parts.push(Buffer.from(part));
      }
      const body = Buffer.concat(parts);
      const response = await app.fetch(
        new Request(`${origin}${incoming.url}`, {
          method: incoming.method,
          headers: incoming.headers as Record<string, string>,
          ...(body.length ? { body } : {}),
        }),
        env,
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.writeHead(500, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ error: 'fixture_failure', message: String(error) }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('No fixture port.');
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await teardownEnv();
});

beforeEach(async () => {
  requests = 0;
  await clearTables(env.db);
  env.USAGE_COUNTER = createUsageCounterFixture(env as unknown as ApiEnv['Bindings']);
  await env.ROUTING.put('signup:enabled', 'false');
  const admin = await createTestUser(
    env.db,
    'terminal-admin',
    'github',
    undefined,
    'free',
    'admin',
  );
  const response = await app.fetch(
    new Request(`${origin}/operator/v1/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.jwt}`, 'Content-Type': 'application/json' },
      body: '{}',
    }),
    env,
  );
  const session = (await response.json()) as { token: string };
  operatorToken = session.token;
});

function run(args: Array<string>, input?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'platform', ...args], {
      env: {
        ...process.env,
        VOID_API_URL: origin,
        VOID_OPERATOR_TOKEN: operatorToken,
        // `vp run` forces color; combining it with NO_COLOR emits a Node warning
        // on stderr and corrupts the JSON error response this fixture asserts.
        FORCE_COLOR: undefined,
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Operator CLI fixture timed out.'));
    }, 15_000);
    child.stdout.on('data', (data) => {
      stdout += String(data);
    });
    child.stderr.on('data', (data) => {
      stderr += String(data);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

test('built CLI configures the logging policy enforced by the actual AI proxy', async () => {
  const proxyUrl = new URL('../../../proxy/src/index.ts', import.meta.url).href;
  const { default: proxy } = (await import(/* @vite-ignore */ proxyUrl)) as {
    default: { fetch(request: Request, env: unknown): Promise<Response> };
  };
  // Hosted Void Cloud does not set the uncached auth-database flag.
  const uncached = env.PLATFORM_AUTH_DATABASE_UNCACHED;
  delete env.PLATFORM_AUTH_DATABASE_UNCACHED;
  onTestFinished(() => {
    env.PLATFORM_AUTH_DATABASE_UNCACHED = uncached;
  });
  const owner = await createTestUser(env.db, 'ai-customer');
  const project = await createTestProject(env.db, owner.id, 'private-ai');
  const command = ['project', 'ai-logging', project.id, 'metadata'];
  const preview = await run([...command, '--plan', '--json']);
  expect(preview.code, preview.stderr).toBe(0);
  expect(JSON.parse(preview.stdout)).toMatchObject({ dryRun: true, mode: 'metadata' });
  const original = await run(['project', 'show', project.id, '--json']);
  expect(JSON.parse(original.stdout)).toMatchObject({ aiLogging: { mode: 'inherit' } });
  const saved = await run([...command, '--yes', '--json']);
  expect(saved.code, saved.stderr).toBe(0);
  expect(JSON.parse(saved.stdout)).toMatchObject({ mode: 'metadata' });
  // The proxy reads only the published ROUTING value, which the API wrote.
  expect(await env.ROUTING.get(aiLoggingKey(project.id))).toBe('metadata');

  const ai = {
    run: vi.fn(async () => ({ response: 'ok' })),
    models: vi.fn(),
    toMarkdown: vi.fn(),
    gateway: vi.fn(),
  };
  const api = {
    fetch: (input: string | Request, init?: RequestInit) =>
      app.fetch(new Request(input, init), env),
  };
  const aiToken = await deriveProxyToken(env.JWT_SECRET, project.id, 0);
  const request = () =>
    new Request('https://ai-proxy/ai/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        aiToken,
        model: 'test-model',
        inputs: { prompt: 'private' },
        options: {
          gateway: { collectLog: true },
          extraHeaders: { 'cf-aig-collect-log-payload': 'true' },
        },
      }),
    });
  const bindings = { ...env, AI: ai, API: api as Fetcher };
  expect((await proxy.fetch(request(), bindings)).status).toBe(200);
  expect(ai.run).toHaveBeenLastCalledWith(
    'test-model',
    { prompt: 'private' },
    expect.objectContaining({
      gateway: {
        id: 'void',
        collectLog: true,
        metadata: { projectId: await deriveAiUsageTag(env.JWT_SECRET, project.id) },
      },
      extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
    }),
  );
  // The proxy reads the key on every call and keeps no copy of its own, so a new
  // value applies without a deploy. This test KV ignores `cacheTtl`: in production a
  // location that already read the old value may serve it until the cache time ends,
  // which is why the command prints an expected-by time instead of "now".
  const changed = await run(['project', 'ai-logging', project.id, 'off', '--yes', '--json']);
  expect(changed.code, changed.stderr).toBe(0);
  const reads = vi.spyOn(env.ROUTING, 'get');
  expect((await proxy.fetch(request(), bindings)).status).toBe(200);
  expect(reads).toHaveBeenCalledWith(aiLoggingKey(project.id), { cacheTtl: 30 });
  expect(
    Date.parse((JSON.parse(changed.stdout) as { expectedBy: string }).expectedBy),
  ).toBeGreaterThan(Date.now() + 30_000);
  reads.mockRestore();
  expect(ai.run).toHaveBeenLastCalledWith(
    'test-model',
    { prompt: 'private' },
    expect.objectContaining({
      gateway: expect.objectContaining({ collectLog: false }),
    }),
  );
  const audit = await run(['system', 'events', '--json']);
  expect(audit.code, audit.stderr).toBe(0);
  expect(JSON.stringify(JSON.parse(audit.stdout))).toContain(`projects/${project.id}/ai-logging`);

  // Human output names where the setting comes from and when new requests follow it.
  const human = await run(['project', 'ai-logging', project.id, 'full', '--yes']);
  expect(human.code, human.stderr).toBe(0);
  expect(human.stdout).toContain(
    `AI logging for ${project.id}: full (set on project; plan "free" default: inherit)`,
  );
  expect(human.stdout).toContain('New AI requests are expected to follow it by ');
  const shown = await run(['project', 'show', project.id]);
  expect(shown.code, shown.stderr).toBe(0);
  expect(shown.stdout).toContain(
    'AI Gateway logging: full (set on project; plan "free" default: inherit) — pending (expected by ',
  );
});

test('built CLI authenticates, previews, changes access, and reads the actual database audit', async () => {
  const status = await run(['auth', 'status', '--json']);
  expect(status.code).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({ user: { login: 'terminal-admin' } });
  const list = await run(['user', 'list', '--json']);
  expect(list.code).toBe(0);
  expect(JSON.parse(list.stdout).users[0].login).toBe('terminal-admin');

  const preview = await run(['signup', 'restrict', '--plan', '--json']);
  expect(preview.code).toBe(0);
  expect(JSON.parse(preview.stdout)).toMatchObject({ dryRun: true, action: 'signup.restrict' });
  expect(await env.ROUTING.get('signup:enabled')).toBe('false');
  const restricted = await run(['signup', 'restrict', '--yes', '--json']);
  expect(restricted.code).toBe(0);
  expect(await env.ROUTING.get('signup:enabled')).toBe('true');
  const events = await run(['system', 'events', '--json']);
  expect(events.code).toBe(0);
  expect(JSON.parse(events.stdout)).toMatchObject({
    total: 1,
    events: [{ login: 'terminal-admin', status: 'success' }],
  });
});

test('built CLI requires acknowledgement, exposes API validation, and honors revoked sessions', async () => {
  const mutation = await run(['signup', 'restrict', '--json']);
  expect(mutation.code).toBe(1);
  expect(await env.ROUTING.get('signup:enabled')).not.toBe('true');
  const invalid = await run(['user', 'list', '--limit', '101', '--json']);
  expect(invalid.code).toBe(1);
  expect(invalid.stdout).toBe('');
  expect(JSON.parse(invalid.stderr)).toHaveProperty('message');
  const requestsBefore = requests;
  const status = await run(['auth', 'status', '--typo', '--json']);
  expect(status.code).toBe(1);
  expect(requests).toBe(requestsBefore);
  await app.fetch(
    new Request(`${origin}/operator/v1/session/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${operatorToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    }),
    env,
  );
  const revoked = await run(['user', 'list', '--json']);
  expect(revoked.code).toBe(1);
  expect(JSON.parse(revoked.stderr)).toMatchObject({ error: 'unauthorized', status: 401 });
});

test('built CLI manages plans and refreshes existing app limits against recorded usage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'void-plan-cli-'));
  try {
    const preview = await run([
      'config',
      'plans',
      'add',
      'team',
      '--copy',
      'pro',
      '--name',
      'Team',
      '--plan',
      '--json',
    ]);
    expect(preview.code, preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ dryRun: true, expectedRevision: 0 });
    expect((await readPlanCatalog(env.db)).revision).toBe(0);
    const add = await run([
      'config',
      'plans',
      'add',
      'team',
      '--copy',
      'pro',
      '--name',
      'Team',
      '--yes',
      '--json',
    ]);
    expect(add.code, add.stderr).toBe(0);
    const owner = await createTestUser(env.db, 'plan-cli-owner');
    const project = await createTestProject(env.db, owner.id, 'plan-cli-project');
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'existing-worker', projectId: project.id, userId: owner.id }),
    );
    const assigned = await run(['user', 'plan', owner.id, 'team', '--yes', '--json']);
    expect(assigned.code, assigned.stderr).toBe(0);
    const counter = env.USAGE_COUNTER.get(env.USAGE_COUNTER.idFromName(owner.id));
    expect(
      (
        await counter.fetch(
          new Request('https://do/record', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: owner.id,
              events: [
                {
                  projectId: project.id,
                  userId: owner.id,
                  slug: project.slug,
                  requests: 3,
                  responseBytes: 0,
                },
              ],
            }),
          }),
        )
      ).status,
    ).toBe(200);
    const file = join(directory, 'team.json');
    await writeFile(
      file,
      JSON.stringify({
        name: 'Team Plus',
        limits: {
          requestsPerMonth: 2,
          cpuMsPerRequest: 80,
        },
      }),
    );
    const updated = await run([
      'config',
      'plans',
      'set',
      'team',
      '--file',
      file,
      '--yes',
      '--json',
    ]);
    expect(updated.code, updated.stderr).toBe(0);
    expect(JSON.parse(updated.stdout)).toMatchObject({
      affectedAccounts: 1,
      reconciliation: { complete: true },
    });
    expect(JSON.parse((await env.ROUTING.get(project.slug))!)).toMatchObject({
      workerName: 'existing-worker',
      limits: { cpuMs: 80 },
      suspended: 'requests_exceeded',
    });
    const archived = await run(['config', 'plans', 'archive', 'team', '--yes', '--json']);
    expect(archived.code, archived.stderr).toBe(0);
    const blocked = await run(['user', 'plan', owner.id, 'team', '--yes', '--json']);
    expect(blocked.code).toBe(1);
    const restored = await run(['config', 'plans', 'restore', 'team', '--yes', '--json']);
    expect(restored.code, restored.stderr).toBe(0);
    const defaulted = await run(['config', 'plans', 'default', 'team', '--yes', '--json']);
    expect(defaulted.code, defaulted.stderr).toBe(0);
    const removed = await run([
      'config',
      'plans',
      'remove',
      'team',
      '--replacement',
      'pro',
      '--yes',
      '--json',
    ]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(await getUser(env.db, owner.id)).toMatchObject({ plan: 'pro', suspended_reason: null });
    expect((await readPlanCatalog(env.db)).defaultPlanId).toBe('pro');
    expect(await (await counter.fetch(new Request('https://do/state'))).json()).toMatchObject({
      plan: 'pro',
      totalRequests: 3,
    });
    expect(JSON.parse((await env.ROUTING.get(project.slug))!).suspended).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
