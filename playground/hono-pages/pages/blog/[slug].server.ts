import { defineHandler } from 'void';
import { POSTS } from './_data.ts';

export type Props = Readonly<{
  post: (typeof POSTS)[number];
}>;

export const loader = defineHandler<Props>((c) => {
  const slug = c.req.param('slug');
  const post = POSTS.find((p) => p.slug === slug);
  if (!post) {
    return c.notFound();
  }
  return { post };
});
