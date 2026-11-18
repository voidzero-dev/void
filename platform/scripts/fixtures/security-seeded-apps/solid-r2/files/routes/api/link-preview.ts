import { defineHandler } from 'void';
import { requireSession } from '../../lib/session.ts';

function pick(html: string, start: string, end: string): string | null {
  const from = html.indexOf(start);
  if (from === -1) {
    return null;
  }
  const to = html.indexOf(end, from + start.length);
  return to === -1 ? null : html.slice(from + start.length, to).trim();
}

// GET /api/link-preview?url=https://... — title and a snippet for links pasted in comments.
export const GET = defineHandler(async (c) => {
  await requireSession(c);
  const url = c.req.query('url');
  if (!url) {
    return c.json({ error: 'url is required' }, 400);
  }
  const response = await fetch(url, { headers: { 'user-agent': 'files-preview/1.0' } });
  const text = await response.text();
  return {
    status: response.status,
    title: pick(text, '<title>', '</title>'),
    snippet: text.slice(0, 500),
  };
});
