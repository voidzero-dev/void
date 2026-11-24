import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { CloudEnv } from 'void/handler';
import { prepareKitchenSinkPlatformFixture } from '../../../../scripts/kitchen-sink-platform-fixture.ts';

const mocks = vi.hoisted(() => ({
  env: {} as { SECRET_KEY?: string },
  sendEmail: vi.fn(),
  getSandbox: vi.fn(),
  kvGet: vi.fn(),
  queueSend: vi.fn(),
  aiRun: vi.fn(),
  aiStream: vi.fn(),
}));
vi.mock('void', async () => import('void/handler'));
vi.mock('void/env', () => ({ env: mocks.env }));
vi.mock('void/email', () => ({ sendEmail: mocks.sendEmail }));
vi.mock('void/kv', () => ({ kv: { get: mocks.kvGet } }));
vi.mock('void/queues', () => ({ queues: { 'acceptance-queue': { send: mocks.queueSend } } }));
vi.mock('void/ai', () => ({ ai: { run: mocks.aiRun, stream: mocks.aiStream } }));
vi.mock('void/sandbox', () => ({
  getSandbox: mocks.getSandbox,
  SandboxLimitError: class extends Error {},
}));

let fixture: ReturnType<typeof prepareKitchenSinkPlatformFixture>;
let app: Hono<CloudEnv>;
beforeAll(async () => {
  fixture = prepareKitchenSinkPlatformFixture({ email: true, sandbox: true, runtime: true });
  // These handler tests use mocked bindings before `void init` has generated
  // .void/tsconfig.json. The separate fixture build test checks generated types.
  writeFileSync(join(fixture.root, 'tsconfig.json'), '{}');
  const email = await import(join(fixture.root, 'routes/api/acceptance/email.ts'));
  const sandbox = await import(join(fixture.root, 'routes/api/acceptance/sandbox.ts'));
  const queue = await import(join(fixture.root, 'routes/api/acceptance/queue.ts'));
  const runtime = await import(join(fixture.root, 'routes/api/acceptance/runtime.ts'));
  const websocket = (await import(join(fixture.root, 'routes/ws/acceptance.ws.ts'))).default;
  app = new Hono<CloudEnv>()
    .get('/email', (c) => email.GET(c) as Promise<Response>)
    .post('/email', (c) => email.POST(c) as Promise<Response>)
    .post('/sandbox', (c) => sandbox.POST(c) as Promise<Response>)
    .get('/queue', (c) => queue.GET(c) as Promise<Response>)
    .post('/queue', (c) => queue.POST(c) as Promise<Response>)
    .get('/runtime', (c) => runtime.GET(c) as Promise<Response>)
    .post('/runtime', (c) => runtime.POST(c) as Promise<Response>)
    .get('/socket-auth', async (c) => {
      const denied = await websocket.onBeforeConnect({
        env: mocks.env,
        request: c.req.raw,
      } as never);
      return denied ?? c.json({ ok: true });
    });
});
afterAll(() => fixture?.cleanup());

beforeEach(() => {
  delete mocks.env.SECRET_KEY;
  mocks.sendEmail.mockReset();
  mocks.getSandbox.mockReset();
  mocks.kvGet.mockReset();
  mocks.queueSend.mockReset();
  mocks.aiRun.mockReset();
  mocks.aiStream.mockReset();
});

describe.each([undefined, ''])('acceptance auth with secret %j', (secret) => {
  it.each([
    ['GET', '/email?subject=test'],
    ['POST', '/email'],
    ['POST', '/sandbox'],
    ['GET', '/queue?run=ab12cd34ab12cd34'],
    ['POST', '/queue'],
    ['GET', '/runtime'],
    ['POST', '/runtime'],
    ['GET', '/socket-auth'],
  ])('rejects anonymous %s %s before any provider or data access', async (method, path) => {
    mocks.env.SECRET_KEY = secret;
    const response = await app.request(path, { method });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.getSandbox).not.toHaveBeenCalled();
    expect(mocks.kvGet).not.toHaveBeenCalled();
    expect(mocks.queueSend).not.toHaveBeenCalled();
    expect(mocks.aiRun).not.toHaveBeenCalled();
    expect(mocks.aiStream).not.toHaveBeenCalled();
  });
});

describe('acceptance auth with a configured secret', () => {
  it('rejects a wrong token without sending mail', async () => {
    mocks.env.SECRET_KEY = 'configured-secret';
    const response = await app.request('/email', {
      method: 'POST',
      headers: { 'x-void-e2e-token': 'wrong-token' },
    });
    expect(response.status).toBe(401);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('allows the matching token to submit a message', async () => {
    mocks.env.SECRET_KEY = 'configured-secret';
    mocks.sendEmail.mockResolvedValue({ ok: true, ids: [] });
    const message = { to: 'test@example.com', subject: 'test', text: 'acceptance' };
    const response = await app.request('/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-void-e2e-token': 'configured-secret' },
      body: JSON.stringify(message),
    });
    expect(response.status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledWith(message);
  });

  it('rejects an invalid queue run before submitting any work', async () => {
    mocks.env.SECRET_KEY = 'configured-secret';
    const response = await app.request('/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-void-e2e-token': 'configured-secret' },
      body: JSON.stringify({ run: 'stale/arbitrary' }),
    });
    expect(response.status).toBe(400);
    expect(mocks.queueSend).not.toHaveBeenCalled();
  });

  it('uses a fixed small AI prompt rather than accepting arbitrary model inputs', async () => {
    mocks.env.SECRET_KEY = 'configured-secret';
    mocks.aiRun.mockResolvedValue({ response: 'Hello' });
    const response = await app.request('/runtime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-void-e2e-token': 'configured-secret' },
      body: JSON.stringify({ action: 'ai', model: 'arbitrary', max_tokens: 10_000 }),
    });
    expect(response.status).toBe(200);
    expect(mocks.aiRun).toHaveBeenCalledWith('@cf/meta/llama-3.2-1b-instruct', {
      messages: [{ role: 'user', content: 'Say hello in one word.' }],
      max_tokens: 8,
    });
  });
});
