import { describe, expect, it, vi } from 'vite-plus/test';
import type { CloudContext } from '../../src/runtime/handler/index.ts';
import { __setLiveDev, defineLiveStream } from '../../src/runtime/live/index.ts';
import type { LiveLimits } from '../../src/runtime/live/index.ts';
import { createLiveDurableObject } from '../../src/runtime/live/server.ts';

const LIMITS: LiveLimits = {
  maxSubscriptionsPerConnection: 256,
  maxSubscriptionsPerTopic: 64,
  maxOperationsPerControlRequest: 100,
  maxQueuedEventsPerConnection: 100,
  maxEncodedEventSize: 64 * 1024,
  deliveryAttemptTimeoutMs: 1500,
};

describe('live Durable Object runtime', () => {
  it('rejects duplicate stream ids at startup', () => {
    const id = `duplicate-${crypto.randomUUID()}`;
    defineLiveStream({ id, allowAnonymousControl: true });
    expect(() => defineLiveStream({ id, allowAnonymousControl: true })).toThrow(
      `live: duplicate stream id "${id}".`,
    );
  });

  it('rejects invalid live limits before registering the stream id', () => {
    const id = `limits-${crypto.randomUUID()}`;

    expect(() =>
      defineLiveStream({
        id,
        allowAnonymousControl: true,
        limits: { maxQueuedEventsPerConnection: Number.NaN },
      }),
    ).toThrow('limits.maxQueuedEventsPerConnection must be a positive finite integer');
    expect(() =>
      defineLiveStream({
        id,
        allowAnonymousControl: true,
        limits: { maxSubscriptionsPerTopic: 257 },
      }),
    ).toThrow('limits.maxSubscriptionsPerTopic must be at most 256');
    expect(() => defineLiveStream({ id, allowAnonymousControl: true })).not.toThrow();
  });

  it('returns per-operation errors for invalid control operations', async () => {
    const harness = createHarness();
    const stream = defineLiveStream({
      id: `control-${crypto.randomUUID()}`,
      allowAnonymousControl: true,
    });
    const connectionId = 'connection-control-1';
    const connectResponse = await stream.connect(
      liveContext(harness.env, `https://void.live/live?connectionId=${connectionId}`),
    );
    const reader = connectResponse.body!.getReader();
    await readFrame(reader);

    const controlResponse = await stream.control(
      liveContext(harness.env, 'https://void.live/live', {
        connectionId,
        operations: [
          { kind: 'subscribe', id: 'valid-card', topic: 'post:12' },
          { kind: 'subscribe', id: 'bad-topic', topic: '' },
          { kind: 'unsubscribe', id: 'bad\nid' },
        ],
      }),
    );
    const body = await controlResponse.json();

    expect(controlResponse.ok).toBe(true);
    expect(body).toMatchObject({
      accepted: true,
      results: [
        { ok: true, kind: 'subscribe', id: 'valid-card', topic: 'post:12' },
        { ok: false, kind: 'subscribe', id: 'bad-topic', error: { code: 'INVALID_TOPIC' } },
        { ok: false, kind: 'unsubscribe', error: { code: 'INVALID_SUBSCRIPTION_ID' } },
      ],
    });
    await reader.cancel();
  });

  it('prunes stale topic rows before enforcing the topic cap', async () => {
    const harness = createHarness();
    const topic = harness.stub('live:app:topic:topic-key');
    const limits = { ...LIMITS, maxSubscriptionsPerTopic: 1 };

    const stale = await register(topic, {
      connectionId: 'stale-connection-0001',
      subscriptionId: 'comments',
      limits,
    });
    expect(stale.ok).toBe(true);

    const current = await register(topic, {
      connectionId: 'current-connection-001',
      subscriptionId: 'comments',
      limits,
    });
    expect(current.ok).toBe(true);
  });

  it('bounds publish delivery attempts', async () => {
    const LiveDurableObject = createLiveDurableObject();
    const state = createState();
    const env = {
      VOID_LIVE: {
        idFromName(name: string) {
          return name as unknown as DurableObjectId;
        },
        get() {
          return {
            fetch() {
              return new Promise<Response>(() => {});
            },
          } as unknown as DurableObjectStub;
        },
      } as unknown as DurableObjectNamespace,
    };
    const topic = new LiveDurableObject(state, env);
    const limits = { ...LIMITS, deliveryAttemptTimeoutMs: 10 };

    await register(topic, {
      connectionId: 'slow-connection-0001',
      subscriptionId: 'comments',
      limits,
    });

    const startedAt = Date.now();
    const response = await topic.fetch(
      jsonRequest('/publish', {
        streamId: 'app',
        topic: 'post:12',
        topicKey: 'topic-key',
        data: { body: 'hello' },
        limits,
      }),
    );

    expect(response.ok).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it.each([
    ['/deliver', 'timeout'],
    ['/deliver', 'error'],
    ['/deliver', '503'],
    ['/check', 'timeout'],
    ['/check', 'error'],
    ['/check', '503'],
  ])('keeps subscriptions after a transient %s %s', async (path, failure) => {
    let failing = false;
    const harness = createHarness({
      fetch(_name, request) {
        if (failing && new URL(request.url).pathname === path) {
          if (failure === 'timeout') {
            return new Promise<Response>(() => {});
          }
          if (failure === 'error') {
            return Promise.reject(new Error('temporarily unavailable'));
          }
          return Promise.resolve(new Response('unavailable', { status: 503 }));
        }
      },
    });
    const { reader } = await connectAndSubscribe(harness, 'connection-transient-0001', [
      { kind: 'subscribe', id: 'card', topic: 'post:12' },
    ]);
    try {
      const topicName = `live:app:topic:${await topicDigest('app', 'post:12')}`;
      failing = true;
      vi.useFakeTimers();
      const operation =
        path === '/check'
          ? harness.alarm(topicName)
          : harness.stub(topicName).fetch(
              jsonRequest('/publish', {
                streamId: 'app',
                topic: 'post:12',
                topicKey: await topicDigest('app', 'post:12'),
                data: 'missed',
                limits: LIMITS,
              }),
            );
      await vi.advanceTimersByTimeAsync(1501);
      await operation;
      vi.useRealTimers();
      expect(await harness.subscriberCount(topicName)).toBe(1);
      failing = false;
      await harness.publish('app', 'post:12', { title: 'Recovered' });
      expect(parseData(await readFrame(reader))).toMatchObject({ data: { title: 'Recovered' } });
    } finally {
      vi.useRealTimers();
      await reader.cancel();
    }
  });

  it('fans out publish deliveries six at a time and prunes missing connections', async () => {
    const pending: Array<(response: Response) => void> = [];
    let calls = 0;
    const harness = createHarness({
      fetch(_name, request) {
        if (new URL(request.url).pathname === '/deliver') {
          calls++;
          return new Promise<Response>((resolve) => {
            pending.push(resolve);
          });
        }
      },
    });
    const topic = harness.stub('live:app:topic:topic-key');
    await registerSubscribers(topic, 7);

    const publish = topic.fetch(
      jsonRequest('/publish', {
        streamId: 'app',
        topic: 'post:12',
        topicKey: 'topic-key',
        data: { body: 'hello' },
        limits: LIMITS,
      }),
    );

    await vi.waitFor(() => expect(calls).toBe(6));
    expect(pending).toHaveLength(6);
    for (const resolve of pending.slice(0, 6)) {
      resolve(new Response('connection missing', { status: 410 }));
    }
    await vi.waitFor(() => expect(calls).toBe(7));
    pending[6](new Response('connection missing', { status: 410 }));

    expect((await publish).ok).toBe(true);
    expect(await harness.subscriberCount('live:app:topic:topic-key')).toBe(0);
  });

  it('propagates delivery 413 without starting another fanout batch', async () => {
    let calls = 0;
    const harness = createHarness({
      fetch(_name, request) {
        if (new URL(request.url).pathname === '/deliver') {
          calls++;
          return Promise.resolve(
            calls === 1
              ? new Response('event too large', { status: 413 })
              : Response.json({ delivered: 1, stale: [] }),
          );
        }
      },
    });
    const topic = harness.stub('live:app:topic:topic-key');
    await registerSubscribers(topic, 7);

    const response = await topic.fetch(
      jsonRequest('/publish', {
        streamId: 'app',
        topic: 'post:12',
        topicKey: 'topic-key',
        data: { body: 'hello' },
        limits: LIMITS,
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.text()).toBe('event too large');
    expect(calls).toBe(6);
  });

  it('checks stale subscribers six connections at a time during alarm pruning', async () => {
    const pending: Array<(response: Response) => void> = [];
    let calls = 0;
    const harness = createHarness({
      fetch(_name, request) {
        if (new URL(request.url).pathname === '/check') {
          calls++;
          return new Promise<Response>((resolve) => {
            pending.push(resolve);
          });
        }
      },
    });
    const topicName = 'live:app:topic:topic-key';
    const topic = harness.stub(topicName);
    await registerSubscribers(topic, 7);

    const prune = harness.alarm(topicName);
    await vi.waitFor(() => expect(calls).toBe(6));
    expect(pending).toHaveLength(6);
    for (const resolve of pending.slice(0, 6)) {
      resolve(Response.json({ stale: [0] }));
    }
    await vi.waitFor(() => expect(calls).toBe(7));
    pending[6](Response.json({ stale: [0] }));

    await prune;
    expect(await harness.subscriberCount(topicName)).toBe(0);
  });

  it('serializes publishes for one topic so slow stale connections cannot reorder events', async () => {
    let slowCalls = 0;
    let resolveSlowFirst: ((response: Response) => void) | undefined;
    let markSlowFirstStarted: (() => void) | undefined;
    const slowFirstStarted = new Promise<void>((resolve) => {
      markSlowFirstStarted = resolve;
    });
    const harness = createHarness({
      fetch(name, request) {
        if (
          name === 'live:app:connection:slow-connection-0001' &&
          new URL(request.url).pathname === '/deliver'
        ) {
          slowCalls++;
          if (slowCalls === 1) {
            return new Promise<Response>((resolve) => {
              markSlowFirstStarted!();
              resolveSlowFirst = resolve;
            });
          }
          return Promise.resolve(new Response('connection missing', { status: 410 }));
        }
      },
    });
    const topicKey = await topicDigest('app', 'post:12');
    const topic = harness.stub(`live:app:topic:${topicKey}`);
    await register(topic, {
      topicKey,
      connectionId: 'slow-connection-0001',
      subscriptionId: 'slow-card',
    });

    const { reader } = await connectAndSubscribe(harness, 'connection-order-001', [
      { kind: 'subscribe', id: 'post-card', topic: 'post:12' },
    ]);

    const firstPublish = harness.publish('app', 'post:12', { seq: 1 });
    await slowFirstStarted;
    const secondPublish = harness.publish('app', 'post:12', { seq: 2 });
    await Promise.resolve();
    await Promise.resolve();
    resolveSlowFirst!(new Response('connection missing', { status: 410 }));

    expect(parseData(await readFrame(reader))).toMatchObject({ data: { seq: 1 } });
    expect(parseData(await readFrame(reader))).toMatchObject({ data: { seq: 2 } });
    await Promise.all([firstPublish, secondPublish]);
    await reader.cancel();
  });

  it('rejects oversized live events instead of reporting successful publish', async () => {
    const harness = createHarness();
    const { reader } = await connectAndSubscribe(harness, 'connection-large-001', [
      { kind: 'subscribe', id: 'post-card', topic: 'post:12' },
    ]);

    const publishResponse = await harness.publish(
      'app',
      'post:12',
      { body: 'x'.repeat(200) },
      { ...LIMITS, maxEncodedEventSize: 80 },
    );
    const body = await publishResponse.json();

    expect(publishResponse.status).toBe(413);
    expect(body).toMatchObject({
      accepted: false,
      error: { code: 'PAYLOAD_TOO_LARGE' },
    });
    await reader.cancel();
  });

  it('keeps replacement successful when old topic unregister fails', async () => {
    const oldTopicKey = await topicDigest('app', 'post:12');
    const harness = createHarness({
      fetch(name, request) {
        if (
          name === `live:app:topic:${oldTopicKey}` &&
          new URL(request.url).pathname === '/unregister'
        ) {
          return Promise.reject(new Error('temporary unregister failure'));
        }
      },
    });
    const { connection, message, reader } = await connectAndSubscribe(
      harness,
      'connection-replace-1',
      [{ kind: 'subscribe', id: 'post-card', topic: 'post:12' }],
    );

    const replaceResponse = await connection.fetch(
      jsonRequest('/control', {
        ...message,
        operations: [{ kind: 'subscribe', id: 'post-card', topic: 'post:13' }],
      }),
    );
    await expect(replaceResponse.json()).resolves.toMatchObject({
      accepted: true,
      results: [{ ok: true, kind: 'subscribe', id: 'post-card', topic: 'post:13' }],
    });

    await harness.publish('app', 'post:13', { title: 'Replacement' });
    expect(parseData(await readFrame(reader))).toMatchObject({
      subscriptionId: 'post-card',
      topic: 'post:13',
      data: { title: 'Replacement' },
    });
    await reader.cancel();
  });

  it('delivers multiple topics over one connection and unsubscribes individually', async () => {
    const harness = createHarness();
    const { connection, message, reader } = await connectAndSubscribe(
      harness,
      'connection-0000000001',
      [
        { kind: 'subscribe', id: 'post-card', topic: 'post:12' },
        { kind: 'subscribe', id: 'comments', topic: 'comment:2323' },
      ],
    );

    const postPublish = harness.publish('app', 'post:12', { title: 'Updated' });

    expect(parseData(await readFrame(reader))).toMatchObject({
      subscriptionId: 'post-card',
      topic: 'post:12',
      data: { title: 'Updated' },
    });
    await postPublish;

    const commentPublish = harness.publish('app', 'comment:2323', { count: 4 });
    expect(parseData(await readFrame(reader))).toMatchObject({
      subscriptionId: 'comments',
      topic: 'comment:2323',
      data: { count: 4 },
    });
    await commentPublish;

    await connection.fetch(
      jsonRequest('/control', {
        ...message,
        operations: [{ kind: 'unsubscribe', id: 'post-card' }],
      }),
    );

    await harness.publish('app', 'post:12', { title: 'Ignored' });
    const nextCommentPublish = harness.publish('app', 'comment:2323', { count: 5 });

    expect(parseData(await readFrame(reader))).toMatchObject({
      subscriptionId: 'comments',
      topic: 'comment:2323',
      data: { count: 5 },
    });
    await nextCommentPublish;

    await reader.cancel();
  });

  it('removes previous generation topic rows when a connection reconnects', async () => {
    const harness = createHarness();
    const limits = { ...LIMITS, maxSubscriptionsPerTopic: 1 };
    const {
      connection,
      message,
      reader: firstReader,
    } = await connectAndSubscribe(
      harness,
      'connection-0000000002',
      [{ kind: 'subscribe', id: 'old-card', topic: 'post:12' }],
      limits,
    );

    const second = await connection.fetch(jsonRequest('/connect', message));
    const secondReader = second.body!.getReader();
    await readFrame(secondReader);

    const controlResponse = await connection.fetch(
      jsonRequest('/control', {
        ...message,
        operations: [{ kind: 'subscribe', id: 'new-card', topic: 'post:12' }],
      }),
    );

    await expect(controlResponse.json()).resolves.toMatchObject({
      accepted: true,
      results: [{ ok: true, id: 'new-card', topic: 'post:12' }],
    });

    await firstReader.cancel().catch(() => {});
    await secondReader.cancel();
  });

  it('reconnects while the previous connection has an unread write', async () => {
    const harness = createHarness();
    const connectionId = 'connection-stalled-0001';
    const connection = harness.stub(`live:app:connection:${connectionId}`);
    const message = { streamId: 'app', connectionId, owner: 'user:1', limits: LIMITS };
    const first = await connection.fetch(jsonRequest('/connect', message));
    const second = await connection.fetch(jsonRequest('/connect', message));
    const reader = second.body!.getReader();
    try {
      expect(await readFrame(reader)).toBe(': connected');
      await expect(first.text()).rejects.toThrow();
    } finally {
      await reader.cancel();
    }
  });

  it('disconnects an overflowing queue without waiting for the reader', async () => {
    const harness = createHarness();
    const connectionId = 'connection-overflow-0001';
    const connection = harness.stub(`live:app:connection:${connectionId}`);
    const limits = { ...LIMITS, maxQueuedEventsPerConnection: 1 };
    const message = { streamId: 'app', connectionId, owner: 'user:1', limits };
    const response = await connection.fetch(jsonRequest('/connect', message));
    await connection.fetch(
      jsonRequest('/control', {
        ...message,
        operations: [{ kind: 'subscribe', id: 'card', topic: 'post:12' }],
      }),
    );
    await harness.publish('app', 'post:12', 'first');
    await harness.publish('app', 'post:12', 'overflow');
    await expect(response.text()).rejects.toThrow();
    expect(
      (await connection.fetch(jsonRequest('/control', { ...message, operations: [] }))).status,
    ).toBe(404);
    const topicName = `live:app:topic:${await topicDigest('app', 'post:12')}`;
    expect(await harness.subscriberCount(topicName)).toBe(0);
  });

  it('hides internal error text when a subscribe hook throws', async () => {
    const harness = createHarness();
    const error = new Error('secret detail');
    const stream = defineLiveStream({
      id: `subscribe-error-${crypto.randomUUID()}`,
      allowAnonymousControl: true,
      onSubscribe() {
        throw error;
      },
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await stream.control(
        liveContext(harness.env, 'https://void.live/live', {
          connectionId: 'connection-subscribe-error',
          operations: [{ kind: 'subscribe', id: 'card', topic: 'post:12' }],
        }),
      );
      const text = await response.text();

      expect(response.status).toBe(500);
      expect(JSON.parse(text)).toEqual({
        accepted: false,
        error: { code: 'INTERNAL_ERROR', message: 'live: internal error.' },
      });
      expect(text).not.toContain('secret detail');
      expect(consoleError).toHaveBeenCalledWith(error);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('hides internal error text when a connect hook throws', async () => {
    const harness = createHarness();
    const stream = defineLiveStream({
      id: `connect-error-${crypto.randomUUID()}`,
      allowAnonymousControl: true,
      onConnect() {
        throw new Error('secret detail');
      },
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await stream.connect(
        liveContext(harness.env, 'https://void.live/live?connectionId=connection-connect-error'),
      );
      const text = await response.text();

      expect(response.status).toBe(500);
      expect(JSON.parse(text)).toEqual({
        accepted: false,
        error: { code: 'INTERNAL_ERROR', message: 'live: internal error.' },
      });
      expect(text).not.toContain('secret detail');
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('sends the real hook error message in dev only', async () => {
    const harness = createHarness();
    const stream = defineLiveStream({
      id: `dev-error-${crypto.randomUUID()}`,
      allowAnonymousControl: true,
      onSubscribe() {
        throw new Error('hook detail');
      },
    });
    const control = () =>
      stream.control(
        liveContext(harness.env, 'https://void.live/live', {
          connectionId: 'connection-dev-error',
          operations: [{ kind: 'subscribe', id: 'card', topic: 'post:12' }],
        }),
      );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      __setLiveDev(true);
      const devResponse = await control();
      expect(devResponse.status).toBe(500);
      await expect(devResponse.json()).resolves.toEqual({
        accepted: false,
        error: { code: 'INTERNAL_ERROR', message: 'hook detail' },
      });

      __setLiveDev(false);
      const prodResponse = await control();
      expect(prodResponse.status).toBe(500);
      await expect(prodResponse.json()).resolves.toEqual({
        accepted: false,
        error: { code: 'INTERNAL_ERROR', message: 'live: internal error.' },
      });
    } finally {
      __setLiveDev(false);
      consoleError.mockRestore();
    }
  });

  it('keeps specific messages for invalid control requests', async () => {
    const harness = createHarness();
    const stream = defineLiveStream({
      id: `control-json-${crypto.randomUUID()}`,
      allowAnonymousControl: true,
    });
    const ctx = {
      env: harness.env,
      req: {
        raw: new Request('https://void.live/live', { method: 'POST', body: 'not json' }),
      },
      get() {
        return undefined;
      },
    } as unknown as CloudContext;

    const response = await stream.control(ctx);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      accepted: false,
      error: { code: 'BAD_REQUEST', message: 'live: control request body must be JSON.' },
    });
  });
});

function createHarness(options?: {
  fetch?: (name: string, request: Request) => Promise<Response> | undefined;
}) {
  const LiveDurableObject = createLiveDurableObject();
  const instances = new Map<
    string,
    { fetch(request: Request): Promise<Response>; alarm?(): Promise<void> }
  >();
  const states = new Map<string, DurableObjectState>();
  const env = {} as { VOID_LIVE: DurableObjectNamespace };
  const namespace = {
    idFromName(name: string) {
      return name as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      const name = id as unknown as string;
      return {
        fetch(input: RequestInfo | URL, init?: RequestInit) {
          const request = input instanceof Request ? input : new Request(input, init);
          const response = options?.fetch?.(name, request);
          if (response) {
            return response;
          }
          let instance = instances.get(name);
          if (!instance) {
            const state = createState();
            states.set(name, state);
            instance = new LiveDurableObject(state, env);
            instances.set(name, instance);
          }
          return instance.fetch(request);
        },
      } as DurableObjectStub;
    },
  } as DurableObjectNamespace;
  env.VOID_LIVE = namespace;

  return {
    env,
    async alarm(name: string): Promise<void> {
      await instances.get(name)?.alarm?.();
    },
    async subscriberCount(name: string): Promise<number> {
      const rows = await states.get(name)?.storage.list({ prefix: 'sub:' });
      return rows?.size ?? 0;
    },
    stub(name: string): DurableObjectStub {
      return namespace.get(namespace.idFromName(name));
    },
    async publish(streamId: string, topic: string, data: unknown, limits: LiveLimits = LIMITS) {
      const topicKey = await topicDigest(streamId, topic);
      const topicStub = namespace.get(namespace.idFromName(`live:${streamId}:topic:${topicKey}`));
      return topicStub.fetch(
        jsonRequest('/publish', {
          streamId,
          topic,
          topicKey,
          data,
          limits,
        }),
      );
    },
  };
}

function register(
  topic: { fetch(request: Request): Promise<Response> },
  overrides: Record<string, unknown>,
): Promise<Response> {
  return topic.fetch(
    jsonRequest('/register', {
      streamId: 'app',
      topic: 'post:12',
      topicKey: 'topic-key',
      subscriptionId: 'card',
      generation: 1,
      revision: 1,
      lastSeenAt: Date.now(),
      limits: LIMITS,
      ...overrides,
    }),
  );
}

async function registerSubscribers(topic: DurableObjectStub, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    const response = await register(topic, { connectionId: `connection-${index}` });
    expect(response.ok).toBe(true);
  }
}

async function connectAndSubscribe(
  harness: ReturnType<typeof createHarness>,
  connectionId: string,
  operations: Array<Record<string, unknown>>,
  limits: LiveLimits = LIMITS,
) {
  const connection = harness.stub(`live:app:connection:${connectionId}`);
  const message = { streamId: 'app', connectionId, owner: 'user:1', limits };
  const response = await connection.fetch(jsonRequest('/connect', message));
  const reader = response.body!.getReader();
  await readFrame(reader);
  await connection.fetch(jsonRequest('/control', { ...message, operations }));
  return { connection, message, reader };
}

function liveContext(env: unknown, url: string, body?: unknown): CloudContext {
  return {
    env,
    req: {
      raw: new Request(url, {
        method: body === undefined ? 'GET' : 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    },
    get() {
      return undefined;
    },
  } as unknown as CloudContext;
}

function createState(): DurableObjectState {
  const values = new Map<string, unknown>();
  return {
    storage: {
      get(key: string) {
        return Promise.resolve(values.get(key));
      },
      put(key: string, value: unknown) {
        values.set(key, value);
        return Promise.resolve();
      },
      delete(keyOrKeys: string | Array<string>) {
        for (const key of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) {
          values.delete(key);
        }
        return Promise.resolve();
      },
      list(options?: { prefix?: string }) {
        const result = new Map<string, unknown>();
        for (const [key, value] of values) {
          if (!options?.prefix || key.startsWith(options.prefix)) {
            result.set(key, value);
          }
        }
        return Promise.resolve(result);
      },
      setAlarm() {
        return Promise.resolve();
      },
    },
  } as unknown as DurableObjectState;
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`https://void.live${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let frame = '';
  while (!frame.includes('\n\n')) {
    const result = await reader.read();
    if (result.done) {
      throw new Error('stream ended before frame');
    }
    frame += decoder.decode(result.value, { stream: true });
  }
  return frame.slice(0, frame.indexOf('\n\n'));
}

function parseData(frame: string): unknown {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
    .join('\n');
  return JSON.parse(data);
}

async function topicDigest(streamId: string, topic: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${streamId}\u0000${topic}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const binary = String.fromCharCode(...new Uint8Array(digest));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
