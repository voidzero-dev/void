import { users, posts, insertUserSchema, insertPostSchema } from '@schema';
import { number, object } from 'valibot';
import { defineHandler } from 'void';
import type { InferProps } from 'void';
import { db, eq, desc } from 'void/db';

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async () => {
  const allUsers = await db.select().from(users).orderBy(desc(users.id));
  const allPosts = await db
    .select({
      id: posts.id,
      title: posts.title,
      body: posts.body,
      author: users.name,
      createdAt: posts.createdAt,
    })
    .from(posts)
    .innerJoin(users, eq(posts.authorId, users.id))
    .orderBy(desc(posts.id));
  return { users: allUsers, posts: allPosts };
});

export const actions = {
  'create-user': defineHandler.withValidator({
    body: insertUserSchema,
  })(async (_c, { body }) => {
    await db.insert(users).values(body);
  }),

  'delete-user': defineHandler.withValidator({
    body: object({ id: number() }),
  })(async (_c, { body }) => {
    await db.delete(posts).where(eq(posts.authorId, body.id));
    await db.delete(users).where(eq(users.id, body.id));
  }),

  'create-post': defineHandler.withValidator({
    body: insertPostSchema,
  })(async (_c, { body }) => {
    await db.insert(posts).values(body);
  }),

  'delete-post': defineHandler.withValidator({
    body: object({ id: number() }),
  })(async (_c, { body }) => {
    await db.delete(posts).where(eq(posts.id, body.id));
  }),
};
