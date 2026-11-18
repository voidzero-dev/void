import { defineHandler } from 'void';
import { kv } from 'void/kv';

type Flag = { enabled: boolean; rollout: number; updatedAt: number };

const flags = kv.map<Flag>('flag:');

// PUT /api/admin/flags/:name — turn a feature flag on or off (admin console).
export const PUT = defineHandler(async (c) => {
  const name = c.req.param('name');
  const body = await c.req.json<{ enabled: boolean; rollout?: number }>();
  const flag: Flag = {
    enabled: Boolean(body.enabled),
    rollout: Math.min(100, Math.max(0, body.rollout ?? 100)),
    updatedAt: Date.now(),
  };
  await flags.put(name, flag);
  return { name, ...flag };
});

// DELETE /api/admin/flags/:name — remove a flag.
export const DELETE = defineHandler(async (c) => {
  await flags.delete(c.req.param('name'));
  return { deleted: true };
});
