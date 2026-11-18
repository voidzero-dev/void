import { defineHandler } from 'void';

// GET /api/avatar?hash=<md5> — proxies a Gravatar image so the page sets no third-party cookie.
export const GET = defineHandler(async (c) => {
  const hash = (c.req.query('hash') ?? '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(hash)) {
    return c.json({ error: 'bad hash' }, 400);
  }
  const upstream = await fetch(
    `https://www.gravatar.com/avatar/${encodeURIComponent(hash)}?s=128&d=identicon`,
  );
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'image/png' },
  });
});
