import { defineHandler } from 'void';

export type Props = Readonly<{ requestId: string; page: string | null }>;
export const loader = defineHandler<Props>((c) => ({
  requestId: crypto.randomUUID(),
  page: c.req.query('page') ?? null,
}));
export const actions = {
  touch: defineHandler(() => {}),
  anchor: defineHandler((c) => c.redirect('/scroll-restoration?anchored=1#details')),
  typedAnchor: defineHandler((c) =>
    c.redirect({
      pathname: '/scroll-restoration',
      query: { anchored: 1 },
      hash: 'details',
    }),
  ),
  redirect: defineHandler((c) => c.redirect('/scroll-restoration?redirected=1')),
};
