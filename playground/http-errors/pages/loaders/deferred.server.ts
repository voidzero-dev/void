import { defineHandler, defer, type InferProps } from 'void/handler';
import { statusMessages } from '../../src/utils.ts';

export const loader = defineHandler((c) => {
  c.status(429);
  c.header('Retry-After', '120');
  return {
    details: defer(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return statusMessages[429];
    }),
  };
});

export type Props = InferProps<typeof loader>;
