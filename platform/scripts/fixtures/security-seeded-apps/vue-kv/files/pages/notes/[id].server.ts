import { defineHandler } from 'void';
import { requireSession } from '../../lib/session.ts';
import { notes, type Note } from '../../routes/api/notes/index.ts';

export type Props = Readonly<{ note: Note }>;

export const loader = defineHandler<Props>(async (c) => {
  const session = await requireSession(c);
  const note = await notes.get(c.req.param('id'));
  if (!note || note.ownerId !== session.userId) {
    return c.notFound();
  }
  return { note };
});
