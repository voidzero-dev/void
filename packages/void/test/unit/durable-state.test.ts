import { describe, expect, it, vi } from 'vite-plus/test';
import { defineDurableState } from '../../src/runtime/durable/index.ts';
import { getRuntimeRequestResource, withRuntimeEnv } from '../../src/runtime/env/runtime.ts';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: DurableObjectState,
      readonly env: Record<string, unknown>,
    ) {}
  },
}));

function createObjectState(initial?: unknown): {
  state: DurableObjectState;
  records: Map<string, unknown>;
  alarms: Array<number | Date>;
} {
  const records = new Map<string, unknown>();
  if (initial !== undefined) {
    records.set('__void_durable_state', initial);
  }
  const alarms: Array<number | Date> = [];
  const storage = {
    get(key: string) {
      return Promise.resolve(structuredClone(records.get(key)));
    },
    put(key: string, value: unknown) {
      records.set(key, structuredClone(value));
      return Promise.resolve();
    },
    setAlarm(value: number | Date) {
      alarms.push(value);
      return Promise.resolve();
    },
    deleteAlarm() {
      alarms.length = 0;
      return Promise.resolve();
    },
  } as unknown as DurableObjectStorage;
  const state = {
    id: { name: 'counter' },
    storage,
    blockConcurrencyWhile<T>(callback: () => Promise<T>) {
      return callback();
    },
  } as unknown as DurableObjectState;
  return { state, records, alarms };
}

describe('defineDurableState', () => {
  it('serializes typed RPC mutations and persists state', async () => {
    const Counter = defineDurableState({
      initialState: { count: 0 },
      methods: {
        async increment(context, amount: number) {
          await Promise.resolve();
          context.state.count += amount;
          return context.state.count;
        },
      },
    });
    const fixture = createObjectState();
    const object = new Counter.class(fixture.state, {});

    expect(await Promise.all([object.increment(1), object.increment(2)])).toEqual([1, 3]);
    expect(fixture.records.get('__void_durable_state')).toEqual({
      __voidDurableState: true,
      version: 0,
      value: { count: 3 },
    });
  });

  it('rolls back in-memory state when an operation fails', async () => {
    const Counter = defineDurableState({
      initialState: { count: 0 },
      methods: {
        fail(context) {
          context.state.count += 1;
          throw new Error('failed');
        },
        read(context) {
          return context.state.count;
        },
      },
    });
    const fixture = createObjectState();
    const object = new Counter.class(fixture.state, {});

    await expect(object.fail()).rejects.toThrow('failed');
    expect(await object.read()).toBe(0);
    expect(fixture.records.get('__void_durable_state')).toEqual({
      __voidDurableState: true,
      version: 0,
      value: { count: 0 },
    });
  });

  it('runs persisted state migrations before handling methods', async () => {
    const Counter = defineDurableState({
      initialState: { count: 0, label: 'new' },
      version: 2,
      migrations: [
        {
          version: 1,
          migrate(value) {
            const old = value as { count: number };
            return { count: old.count + 1, label: 'migrated' };
          },
        },
        {
          version: 2,
          migrate(value) {
            const old = value as { count: number; label: string };
            return { ...old, label: old.label.toUpperCase() };
          },
        },
      ],
      methods: {
        read(context) {
          return context.state;
        },
      },
    });
    const fixture = createObjectState({
      __voidDurableState: true,
      version: 0,
      value: { count: 4 },
    });
    const object = new Counter.class(fixture.state, {});

    expect(await object.read()).toEqual({ count: 5, label: 'MIGRATED' });
    expect(fixture.records.get('__void_durable_state')).toMatchObject({ version: 2 });
  });

  it('rejects gaps in the declared state migration history', () => {
    expect(() =>
      defineDurableState({
        initialState: { count: 0 },
        version: 2,
        migrations: [{ version: 2, migrate: () => ({ count: 0 }) }],
        methods: {},
      }),
    ).toThrow('missing state migration for version 1');
  });

  it('supports fetch and alarm hooks with the same persisted state', async () => {
    const State = defineDurableState({
      initialState: { alarmCount: 0 },
      methods: {},
      fetch(context) {
        return Response.json(context.state);
      },
      async alarm(context) {
        context.state.alarmCount += 1;
        await context.setAlarm(Date.now() + 1000);
      },
    });
    const fixture = createObjectState();
    const object = new State.class(fixture.state, {});

    await object.alarm();
    expect(await (await object.fetch(new Request('https://example.com'))).json()).toEqual({
      alarmCount: 1,
    });
    expect(fixture.alarms).toHaveLength(1);
  });

  it('uses one request resource per durable object invocation', async () => {
    const resourceKey = {};
    let nextResource = 0;
    const State = defineDurableState({
      initialState: {},
      methods: {
        readResource() {
          const first = getRuntimeRequestResource(resourceKey, () => ++nextResource);
          const second = getRuntimeRequestResource(resourceKey, () => ++nextResource);
          return [first, second];
        },
      },
    });
    const fixture = createObjectState();
    const object = new State.class(fixture.state, {});

    expect(await object.readResource()).toEqual([1, 1]);
    expect(await object.readResource()).toEqual([2, 2]);
  });

  it('resolves its convention-bound namespace for typed stub lookup', async () => {
    const Counter = defineDurableState({
      initialState: { count: 0 },
      methods: {
        increment(context, amount: number) {
          context.state.count += amount;
          return context.state.count;
        },
      },
    });
    const id = { name: 'global' } as unknown as DurableObjectId;
    const stub = { increment: () => Promise.resolve(1) };
    const namespace = {
      idFromName(name: string) {
        expect(name).toBe('global');
        return id;
      },
      get(resolvedId: DurableObjectId) {
        expect(resolvedId).toBe(id);
        return stub;
      },
    } as unknown as DurableObjectNamespace;

    Counter.__bind('COUNTER');
    const result = withRuntimeEnv({ COUNTER: namespace }, () => Counter.get('global'));

    expect(result).toBe(stub);
    expect(await result.increment(1)).toBe(1);
  });
});
