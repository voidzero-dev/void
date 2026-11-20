import { defineHandler } from 'void';
import { storage } from 'void/storage';
import { normalizeKey, userPrefix } from '../../../lib/keys.ts';
import { requireSession } from '../../../lib/session.ts';

// GET /api/files?name=reports/2026/q3.pdf — download one of the signed-in user's files.
export const GET = defineHandler(async (c) => {
  const session = await requireSession(c);
  const name = c.req.query('name');
  if (!name) {
    return c.json({ error: 'name is required' }, 400);
  }
  const key = normalizeKey(userPrefix(session.userId), name);
  const object = await storage.get(key);
  if (!object) {
    return c.notFound();
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('content-disposition', 'attachment');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(object.body, { headers });
});

// PUT /api/files?name=... — upload; the name must be a plain file name.
export const PUT = defineHandler(async (c) => {
  const session = await requireSession(c);
  const name = c.req.query('name') ?? '';
  if (!/^[\w.-]{1,128}$/.test(name) || name.startsWith('.')) {
    return c.json({ error: 'bad file name' }, 400);
  }
  await storage.put(`${userPrefix(session.userId)}${name}`, c.req.raw.body, {
    httpMetadata: { contentType: c.req.header('content-type') ?? 'application/octet-stream' },
  });
  return { stored: name };
});
