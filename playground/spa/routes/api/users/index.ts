import { users } from '@schema';
import { email as valibotEmail, minLength, object, pipe, string } from 'valibot';
import { defineHandler } from 'void';
import { db } from 'void/db';

export const GET = defineHandler(async () => {
  return db.select().from(users);
});

export const POST = defineHandler.withValidator({
  body: object({
    name: pipe(string(), minLength(1)),
    email: pipe(string(), valibotEmail()),
  }),
})(async (c, { body }) => {
  await db.insert(users).values({ name: body.name, email: body.email });
  return { created: true };
});
