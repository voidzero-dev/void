import { verifyUsageEnvelope } from '@voidcloud/api/usage-auth';
import { describe, it, expect } from 'vite-plus/test';
import type { Env } from '../../src/env.ts';
import { recordRequest, sendUsageEvent } from '../../src/metering.ts';

function createMockEnv(): { env: Env; writes: Array<unknown> } {
  const writes: Array<unknown> = [];
  const env = {
    ANALYTICS: {
      writeDataPoint: (data: unknown) => writes.push(data),
    },
  } as unknown as Env;
  return { env, writes };
}

describe('recordRequest', () => {
  it('writes data point with correct shape', () => {
    const { env, writes } = createMockEnv();

    recordRequest(env, {
      projectId: 'proj_abc',
      type: 'api',
      method: 'POST',
      status: 200,
      responseBytes: 1234,
      durationMs: 42,
      slug: 'my-app',
    });

    expect(writes).toHaveLength(1);
    const dp = writes[0] as {
      indexes: Array<string>;
      blobs: Array<string>;
      doubles: Array<number>;
    };

    expect(dp.indexes).toEqual(['proj_abc']);
    expect(dp.blobs).toEqual(['proj_abc', 'api', 'POST', '200', 'my-app', '']);
    expect(dp.doubles).toEqual([1, 1234, 42]);
  });

  it('sets index to projectId for sampling', () => {
    const { env, writes } = createMockEnv();

    recordRequest(env, {
      projectId: 'proj_xyz',
      type: 'static',
      method: 'GET',
      status: 304,
      responseBytes: 0,
      durationMs: 5,
      slug: 'other-app',
    });

    const dp = writes[0] as { indexes: Array<string> };
    expect(dp.indexes[0]).toBe('proj_xyz');
  });

  it('converts status to string in blobs', () => {
    const { env, writes } = createMockEnv();

    recordRequest(env, {
      projectId: 'proj_1',
      type: 'ssr',
      method: 'GET',
      status: 500,
      responseBytes: 100,
      durationMs: 200,
      slug: 'ssr-app',
    });

    const dp = writes[0] as { blobs: Array<string> };
    expect(dp.blobs[3]).toBe('500');
  });

  it('records platform failure attribution in blob6', () => {
    const { env, writes } = createMockEnv();

    recordRequest(env, {
      projectId: 'proj_1',
      type: 'static',
      method: 'GET',
      status: 503,
      responseBytes: 0,
      durationMs: 10_000,
      slug: 'docs',
      failureKind: 'platform-static-asset-timeout',
    });

    const dp = writes[0] as { blobs: Array<string> };
    expect(dp.blobs[5]).toBe('platform-static-asset-timeout');
  });

  it('always sets double1 to 1 for counting', () => {
    const { env, writes } = createMockEnv();

    recordRequest(env, {
      projectId: 'proj_1',
      type: 'isr',
      method: 'GET',
      status: 200,
      responseBytes: 5000,
      durationMs: 100,
      slug: 'isr-app',
    });

    const dp = writes[0] as { doubles: Array<number> };
    expect(dp.doubles[0]).toBe(1);
    expect(dp.doubles[1]).toBe(5000);
    expect(dp.doubles[2]).toBe(100);
  });

  it('handles all supported request types', () => {
    const { env, writes } = createMockEnv();
    const types = ['api', 'static', 'ssr', 'isr', 'websocket'] as const;

    for (const type of types) {
      recordRequest(env, {
        projectId: 'proj_1',
        type,
        method: 'GET',
        status: 200,
        responseBytes: 0,
        durationMs: 0,
        slug: 'test',
      });
    }

    expect(writes).toHaveLength(5);
    const recordedTypes = (writes as Array<{ blobs: Array<string> }>).map((w) => w.blobs[1]);
    expect(recordedTypes).toEqual(['api', 'static', 'ssr', 'isr', 'websocket']);
  });
});

describe('sendUsageEvent', () => {
  const event = {
    projectId: 'project-1',
    userId: 'user-1',
    slug: 'my-app',
    requests: 1,
    responseBytes: 123,
  };

  it('publishes an authenticated dispatch envelope with the private KV key', async () => {
    const key = 'dispatch-usage-test-key';
    const sent: Array<unknown> = [];
    const env = {
      ROUTING: { get: async () => key },
      USAGE_QUEUE: { send: async (message: unknown) => sent.push(message) },
    } as unknown as Env;

    await sendUsageEvent(env, event);

    expect(sent).toHaveLength(1);
    const envelope = await verifyUsageEnvelope<typeof event>(sent[0], key);
    expect(envelope?.source).toBe('dispatch');
    expect(envelope?.event).toEqual(event);
  });

  it('does not emit an unsigned compatibility frame while the key is unavailable', async () => {
    const sent: Array<unknown> = [];
    const env = {
      ROUTING: { get: async () => null },
      USAGE_QUEUE: { send: async (message: unknown) => sent.push(message) },
    } as unknown as Env;

    await expect(sendUsageEvent(env, event)).rejects.toThrow('Usage metering is not initialized');
    expect(sent).toEqual([]);
  });
});
