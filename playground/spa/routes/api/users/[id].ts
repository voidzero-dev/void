import { users } from '@schema';
import { object, string } from 'valibot';
import { defineHandler } from 'void';
import { db, eq } from 'void/db';

export const GET = defineHandler.withValidator({
  params: object({ id: string() }),
})(async (c, { params }) => {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, Number(params.id)));

  if (!user) {
    return new Response('Not found', { status: 404 });
  }
  return user;
});
