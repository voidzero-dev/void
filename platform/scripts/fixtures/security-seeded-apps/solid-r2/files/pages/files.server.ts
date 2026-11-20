import { defineHandler } from 'void';
import { storage } from 'void/storage';
import { userPrefix } from '../lib/keys.ts';
import { requireSession } from '../lib/session.ts';

export type Props = Readonly<{ files: Array<string> }>;

export const loader = defineHandler<Props>(async (c) => {
  const session = await requireSession(c);
  const prefix = userPrefix(session.userId);
  const listed = await storage.list({ prefix, limit: 50 });
  return { files: listed.objects.map((object) => object.key.slice(prefix.length)) };
});
