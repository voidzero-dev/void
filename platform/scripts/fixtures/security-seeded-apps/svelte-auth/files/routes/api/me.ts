import { defineHandler } from 'void';

export const GET = defineHandler((c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return { id: user.sub, email: user.email, role: user.role };
});
