import { tags } from 'virtual:tags';
import { defineHandler } from 'void';
import type { PageParams } from 'void/routes';

export type Props = Readonly<{
  tag: string;
}>;

export const prerender = true;

export function getPrerenderPaths() {
  return tags.map((tag: string) => ({ tag }));
}

export const loader = defineHandler<Props>((c) => {
  const { tag } = c.req.param() as PageParams<'/tags/[tag]'>;
  return { tag };
});
