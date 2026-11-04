import { defineHandler } from 'void';

export type Props = Readonly<{
  revision: string;
}>;

export const loader = defineHandler<Props>((c) => ({
  revision:
    c.req.method === 'POST' || c.req.header('cookie')?.includes('transition-revision=updated')
      ? 'updated'
      : 'initial',
}));

export const actions = {
  ping: defineHandler(async (c) => {
    c.header('Set-Cookie', 'transition-revision=updated; Path=/; SameSite=Lax');
  }),
};
