import { defineHandler } from 'void';

export type Props = Readonly<{ requestId: string }>;
export const loader = defineHandler<Props>(() => ({ requestId: crypto.randomUUID() }));
export const actions = {
  touch: defineHandler(() => {}),
  redirect: defineHandler((c) => c.redirect('/scroll-restoration?redirected=1')),
};
