import { defineHandler } from 'void';
import { USERS } from './_data.ts';

export type Props = Readonly<{
  user: (typeof USERS)[number];
}>;

export const loader = defineHandler<Props>((c) => {
  const id = Number(c.req.param('id'));
  const user = USERS.find((u) => u.id === id);

  if (!user) {
    return c.notFound();
  }

  return { user };
});
