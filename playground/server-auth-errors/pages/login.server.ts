import { defineHandler, type InferProps } from 'void';

export type Props = InferProps<typeof loader>;

export const loader = defineHandler((c) => {
  const destination = new URL(c.req.query('next') || '/', c.req.url);
  const next =
    destination.origin === new URL(c.req.url).origin
      ? destination.pathname + destination.search
      : '/';
  return { next };
});
