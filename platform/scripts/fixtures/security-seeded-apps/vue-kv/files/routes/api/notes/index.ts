import { defineHandler } from 'void';
import { kv } from 'void/kv';
import { requireSession } from '../../../lib/session.ts';

export type Note = { id: string; ownerId: string; title: string; body: string; shared: boolean };

export const notes = kv.map<Note>('note:');

// POST /api/notes — create a note; `shared: true` makes it readable at /share/:id.
export const POST = defineHandler(async (c) => {
  const session = await requireSession(c);
  const input = await c.req.json<{ title: string; body: string; shared?: boolean }>();
  const note: Note = {
    id: crypto.randomUUID(),
    ownerId: session.userId,
    title: String(input.title).slice(0, 200),
    body: String(input.body).slice(0, 20_000),
    shared: input.shared === true,
  };
  await notes.put(note.id, note);
  return { id: note.id };
});
