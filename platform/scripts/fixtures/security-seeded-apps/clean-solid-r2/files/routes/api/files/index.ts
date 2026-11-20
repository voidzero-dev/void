import { defineHandler } from 'void';
import { storage } from 'void/storage';
import { isPlainName, userPrefix } from '../../../lib/keys.ts';
import { requireSession } from '../../../lib/session.ts';

export const GET = defineHandler(async (c) => {
  const session = await requireSession(c);
  const name = c.req.query('name') ?? '';
  if (!isPlainName(name)) {
    return c.json({ error: 'bad file name' }, 400);
  }
  const object = await storage.get(`${userPrefix(session.userId)}${name}`);
  if (!object) {
    return c.notFound();
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('content-disposition', 'attachment');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(object.body, { headers });
});
