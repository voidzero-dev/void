import { defineHandler } from 'void';
import type { PageParams } from 'void/routes';

export type Props = Readonly<{
  slug: string;
}>;

export const prerender = true;

export function getPrerenderPaths() {
  return [{ slug: 'hello' }, { slug: 'world' }];
}

export const loader = defineHandler<Props>((c) => {
  const { slug } = c.req.param() as PageParams<'/posts/[slug]'>;
  return { slug };
});
