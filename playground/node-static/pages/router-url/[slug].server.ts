import { defineHandler } from 'void';

export type Props = Readonly<{
  title: string;
}>;

export const prerender = true;

// "a b" is served at the encoded path /router-url/a%20b.
export function getPrerenderPaths() {
  return [{ slug: 'plain' }, { slug: 'a b' }];
}

export const loader = defineHandler<Props>(() => {
  return { title: 'Router URL' };
});
