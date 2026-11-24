import { minLength, object, pipe, string } from 'valibot';
import { defineHandler } from 'void';
import { POSTS } from './_data.ts';

export type Props = Readonly<{
  posts: typeof POSTS;
}>;

export const loader = defineHandler<Props>(() => {
  return { posts: POSTS };
});

export const action = defineHandler.withValidator({
  body: object({
    title: pipe(string(), minLength(1, 'Title is required')),
    body: pipe(string(), minLength(1, 'Body is required')),
  }),
})(async (c, { body }) => {
  const slug = body.title.toLowerCase().replaceAll(/\s+/g, '-');
  POSTS.push({ slug, title: body.title, body: body.body });
});
