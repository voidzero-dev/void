import { defineHandler } from 'void';
import { kv } from 'void/kv';
import { requireSession } from '../../../../lib/session.ts';

const flags = kv.map<{ enabled: boolean }>('flag:');
const admins = kv.map<boolean>('admin:');

export const PUT = defineHandler(async (c) => {
  const session = await requireSession(c);
  if ((await admins.get(session.userId)) !== true) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const body = await c.req.json<{ enabled: boolean }>();
  await flags.put(c.req.param('name'), { enabled: Boolean(body.enabled) });
  return { ok: true };
});
