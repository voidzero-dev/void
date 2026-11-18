import { defineHandler } from 'void';
import { requireSession } from '../../lib/session.ts';

// Only these public sites are fetched; redirects are not followed.
const ALLOWED_HOSTS = new Set(['github.com', 'www.youtube.com', 'en.wikipedia.org']);

export const GET = defineHandler(async (c) => {
  await requireSession(c);
  let target: URL;
  try {
    target = new URL(c.req.query('url') ?? '');
  } catch {
    return c.json({ error: 'bad url' }, 400);
  }
  if (target.protocol !== 'https:' || target.port !== '' || !ALLOWED_HOSTS.has(target.hostname)) {
    return c.json({ error: 'site not supported' }, 400);
  }
  const response = await fetch(target, { redirect: 'manual' });
  if (response.status !== 200) {
    return { title: null };
  }
  const text = (await response.text()).slice(0, 100_000);
  const from = text.indexOf('<title>');
  const to = from === -1 ? -1 : text.indexOf('</title>', from);
  return {
    title:
      to === -1
        ? null
        : text
            .slice(from + 7, to)
            .trim()
            .slice(0, 200),
  };
});
