import { defineHandler } from 'void';

export type Props = Readonly<{ email: string; role: string }>;

export const loader = defineHandler<Props>((c) => {
  const user = c.get('user');
  if (!user) {
    return c.redirect('/login');
  }
  return { email: user.email, role: user.role };
});
