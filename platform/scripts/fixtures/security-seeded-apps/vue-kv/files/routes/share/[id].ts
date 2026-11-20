import { defineHandler } from 'void';
import { notes } from '../api/notes/index.ts';

// GET /share/:id — public read-only page for a shared note.
export const GET = defineHandler(async (c) => {
  const note = await notes.get(c.req.param('id'));
  if (!note || !note.shared) {
    return c.notFound();
  }
  return c.html(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${note.title}</title></head>
  <body>
    <article>
      <h1>${note.title}</h1>
      <div class="note-body">${note.body.replaceAll('\n', '<br>')}</div>
    </article>
  </body>
</html>`);
});
