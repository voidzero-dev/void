import { memoryAdapter } from 'better-auth/adapters/memory';
import { Hono } from 'hono';
import { describe, expect, it } from 'vite-plus/test';
import { createVoidAuthRuntime } from '../../src/runtime/auth/better-auth-shared.ts';

const env = { BETTER_AUTH_SECRET: 'local-test-secret-with-at-least-32-characters' };
const options = { dialect: 'sqlite' as const, providers: null };

function fixture() {
  const database = memoryAdapter({ user: [], session: [], account: [], verification: [] });
  const runtime = createVoidAuthRuntime('sqlite', async () => {});
  const app = new Hono();
  app.use(async (c, next) => runtime.runVoidAuthMiddleware(c, next, options, database));
  app.on(['GET', 'POST'], '/api/auth/*', (c) =>
    runtime.handleVoidAuthRequest(c, options, database),
  );
  return app;
}

function signIn(clientIp: string): Request {
  const request = new Request('https://app.test/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': clientIp },
    body: JSON.stringify({ email: 'nobody@example.test', password: 'wrong-password' }),
  });
  Object.defineProperty(request, 'cf', { value: { colo: 'SJC' } });
  return request;
}

async function statuses(app: Hono, requests: () => Request, count: number) {
  const result: Array<number> = [];
  for (let attempt = 0; attempt < count; attempt += 1) {
    const response = await app.fetch(requests(), env);
    result.push(response.status);
  }
  return result;
}

describe('auth rate limits on deployed Cloudflare requests', () => {
  it('limits repeated sign-in attempts from one client IP', async () => {
    const app = fixture();
    const results = await statuses(app, () => signIn('203.0.113.10'), 4);
    expect(results.slice(0, 3)).not.toContain(429);
    expect(results[3]).toBe(429);

    const other = await app.fetch(signIn('203.0.113.11'), env);
    expect(other.status).not.toBe(429);
  });
});
