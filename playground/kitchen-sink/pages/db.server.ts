import { notes, insertNoteSchema, noteIdSchema } from '@schema';
import { defineHandler } from 'void';
import type { InferProps } from 'void';
import { db, eq, desc } from 'void/db';

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async () => {
  const rows = await db.select().from(notes).orderBy(desc(notes.id));
  return { notes: rows };
});

export const actions = {
  create: defineHandler.withValidator({
    body: insertNoteSchema,
  })(async (_c, { body }) => {
    await db.insert(notes).values(body);
  }),

  delete: defineHandler.withValidator({
    body: noteIdSchema,
  })(async (_c, { body }) => {
    await db.delete(notes).where(eq(notes.id, body.id));
  }),
};
