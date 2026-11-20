import { defineHandler } from 'void';
import { escapeHtml } from '../../lib/session.ts';
import { notes } from '../api/notes/index.ts';

// GET /embed/:id — a small card for embedding a shared note's title.
export const GET = defineHandler(async (c) => {
  const note = await notes.get(c.req.param('id'));
  if (!note || !note.shared) {
    return c.notFound();
  }
  return c.html(`<div class="note-card"><strong>${escapeHtml(note.title)}</strong></div>`);
});
