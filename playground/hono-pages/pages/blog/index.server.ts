import * as v from 'valibot';
import { defineHandler } from 'void';
import { POSTS } from './_data.ts';

export type Props = Readonly<{
  posts: typeof POSTS;
}>;

export const loader = defineHandler<Props>(() => {
  return { posts: POSTS };
});

export const action = defineHandler.withValidator({
  body: v.object({
    title: v.pipe(v.string(), v.minLength(1, 'Title is required')),
    body: v.pipe(v.string(), v.minLength(1, 'Body is required')),
  }),
})(async (c, { body }) => {
  const slug = body.title.toLowerCase().replace(/\s+/g, '-');
  POSTS.push({ slug, title: body.title, body: body.body });
});
