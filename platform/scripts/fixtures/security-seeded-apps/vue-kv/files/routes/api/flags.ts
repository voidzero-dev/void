import { defineHandler } from 'void';
import { kv } from 'void/kv';

// GET /api/flags — public: the client reads flags to show or hide features.
export const GET = defineHandler(async () => {
  const listed = await kv.list({ prefix: 'flag:' });
  const result: Record<string, boolean> = {};
  for (const key of listed.keys) {
    const flag = await kv.get<{ enabled: boolean }>(key.name);
    result[key.name.slice('flag:'.length)] = flag?.enabled ?? false;
  }
  return result;
});
