import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { CloudEnv } from 'void/handler';
import { kitchenSinkSourceFixture } from './kitchen-sink-source-fixture.ts';

const mocks = vi.hoisted(() => ({ revalidate: vi.fn(), put: vi.fn() }));
vi.mock('void', async () => import('void/handler'));
vi.mock('void/isr', () => ({ revalidate: mocks.revalidate }));
vi.mock('void/kv', () => ({ kv: { put: mocks.put, get: vi.fn() } }));

let fixture: ReturnType<typeof kitchenSinkSourceFixture>;
let app: Hono<CloudEnv>;
beforeAll(async () => {
  fixture = kitchenSinkSourceFixture(['pages/revalidate.server.ts']);
  const { action } = (await import(join(fixture.root, 'pages/revalidate.server.ts'))) as {
    action(context: Context<CloudEnv>): Promise<Response | void>;
  };
  app = new Hono<CloudEnv>()
    .post('/', async (c) => {
      const response = await action(c);
      return response instanceof Response ? response : c.body(null, 204);
    })
    .onError((error) => Response.json({ error: error.message }, { status: 502 }));
});
afterAll(() => fixture?.cleanup());

beforeEach(() => {
  mocks.revalidate.mockReset();
  mocks.put.mockReset();
});

describe('kitchen-sink ISR revalidation', () => {
  it('reports a rejected purge instead of storing a successful revalidation timestamp', async () => {
    mocks.revalidate.mockRejectedValue(new Error('provider purge failed'));
    const response = await app.request('/', { method: 'POST' });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'provider purge failed' });
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('records success after the purge completes', async () => {
    const response = await app.request('/', { method: 'POST' });
    expect(response.status).toBe(204);
    expect(mocks.revalidate).toHaveBeenCalledWith({ paths: ['/revalidate'] });
    expect(mocks.put).toHaveBeenCalledWith('revalidate:last', expect.any(String));
    expect(mocks.put.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.revalidate.mock.invocationCallOrder[0],
    );
  });
});
