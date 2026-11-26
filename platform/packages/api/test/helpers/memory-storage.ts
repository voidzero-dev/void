import { vi } from 'vite-plus/test';

/**
 * An in-memory Durable Object storage for unit tests: get/put/delete/list plus one
 * alarm. Values are cloned on the way in and out, like the real storage.
 * `alarms` lists every setAlarm time; `alarm.at` is the one now armed.
 */
export function memoryDurableStorage() {
  const map = new Map<string, unknown>();
  const alarms: Array<number> = [];
  const alarm: { at: number | null } = { at: null };
  const storage = {
    async get<T>(key: string) {
      return structuredClone(map.get(key)) as T | undefined;
    },
    async put(key: string, value: unknown) {
      map.set(key, structuredClone(value));
    },
    async delete(keys: string | Array<string>) {
      if (!Array.isArray(keys)) {
        return map.delete(keys);
      }
      let count = 0;
      for (const key of keys) {
        count += map.delete(key) ? 1 : 0;
      }
      return count;
    },
    async list<T>(options: { prefix?: string } = {}) {
      return new Map(
        [...map].filter(([key]) => key.startsWith(options.prefix ?? '')) as Array<[string, T]>,
      );
    },
    async getAlarm() {
      return alarm.at;
    },
    setAlarm: vi.fn(async (time: number | Date) => {
      alarms.push(Number(time));
      alarm.at = Number(time);
    }),
    deleteAlarm: vi.fn(async () => {
      alarm.at = null;
    }),
  };
  return { storage: storage as unknown as DurableObjectStorage, map, alarms, alarm };
}
