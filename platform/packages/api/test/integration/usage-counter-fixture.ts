import type { ApiEnv } from '../../src/env.ts';
import { UsageCounter } from '../../src/usage-counter.ts';
import type { CounterState } from '../../src/usage-counter.ts';

type FixtureStorage = {
  get: (key: string) => Promise<unknown>;
  put: (key: string, value: unknown) => Promise<void>;
  delete: (keys: string | Array<string>) => Promise<void>;
  list: (options: {
    prefix: string;
    startAfter?: string;
    limit: number;
  }) => Promise<Map<string, unknown>>;
  getAlarm: () => Promise<number | null>;
  setAlarm: (value: number) => Promise<void>;
  deleteAlarm: () => Promise<void>;
  transaction: <T>(run: (tx: FixtureStorage) => Promise<T>) => Promise<T>;
};

/** Execute the production counter against the integration database and routing fixture. */
export function createUsageCounterFixture(
  env: ApiEnv['Bindings'],
  initial: Record<string, Partial<CounterState>> = {},
): DurableObjectNamespace {
  const counters = new Map<string, UsageCounter>();
  return {
    idFromName: (id: string) => id,
    get: (id: string) => {
      let counter = counters.get(id);
      if (!counter) {
        let data = new Map<string, unknown>();
        if (initial[id]) {
          data.set('state', structuredClone(initial[id]));
        }
        let alarm: number | null = null;
        const storage: FixtureStorage = {
          get: async (key: string) => structuredClone(data.get(key)),
          put: async (key: string, value: unknown) => {
            data.set(key, structuredClone(value));
          },
          delete: async (keys: string | Array<string>) => {
            for (const key of typeof keys === 'string' ? [keys] : keys) {
              data.delete(key);
            }
          },
          list: async ({
            prefix,
            startAfter,
            limit,
          }: {
            prefix: string;
            startAfter?: string;
            limit: number;
          }) =>
            new Map(
              [...data.entries()]
                .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
                .sort(([a], [b]) => a.localeCompare(b))
                .slice(0, limit)
                .map(([key, value]) => [key, structuredClone(value)]),
            ),
          getAlarm: async () => alarm,
          setAlarm: async (value: number) => {
            alarm = value;
          },
          deleteAlarm: async () => {
            alarm = null;
          },
          transaction: async <T>(run: (tx: FixtureStorage) => Promise<T>) => {
            const original = data;
            const originalAlarm = alarm;
            data = new Map(structuredClone([...data.entries()]));
            try {
              return await run(storage);
            } catch (error) {
              data = original;
              alarm = originalAlarm;
              throw error;
            }
          },
        };
        const ctx = { storage };
        counter = new UsageCounter(ctx as never, env);
        // The Workers base-class stub does not install these inherited fields.
        Object.assign(counter, { ctx, env });
        counters.set(id, counter);
      }
      const activeCounter = counter;
      return { fetch: (request: Request) => activeCounter.fetch(request) };
    },
  } as unknown as DurableObjectNamespace;
}
