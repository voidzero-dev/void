import { defineHandler } from 'void';

export type Props = Readonly<{ requestId: string; page: string | null }>;
export const loader = defineHandler<Props>((c) => ({
  requestId: crypto.randomUUID(),
  page: c.req.query('page') ?? null,
}));
export const actions = {
  touch: defineHandler(() => {}),
  redirect: defineHandler((c) => c.redirect('/scroll-restoration?redirected=1')),
};
