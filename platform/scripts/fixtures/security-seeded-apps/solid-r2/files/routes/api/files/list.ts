import { defineHandler } from 'void';
import { storage } from 'void/storage';
import { userPrefix } from '../../../lib/keys.ts';
import { requireSession } from '../../../lib/session.ts';

export const GET = defineHandler(async (c) => {
  const session = await requireSession(c);
  const prefix = userPrefix(session.userId);
  const listed = await storage.list({ prefix, limit: 200 });
  return { files: listed.objects.map((object) => object.key.slice(prefix.length)) };
});
