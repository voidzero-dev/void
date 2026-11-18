import { env } from 'cloudflare:workers';
import { defineHandler } from 'void';

// GET /api/admin/export — every account as CSV, for the admin dashboard.
export const GET = defineHandler(async (c) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  const { results } = await env.DB.prepare(
    'SELECT id, email, name, plan, created_at FROM accounts ORDER BY id',
  ).all<Record<string, string>>();
  const lines = results.map((row) =>
    [row.id, row.email, row.name, row.plan, row.created_at].join(','),
  );
  return c.text(['id,email,name,plan,created_at', ...lines].join('\n'), 200, {
    'content-type': 'text/csv',
  });
});
