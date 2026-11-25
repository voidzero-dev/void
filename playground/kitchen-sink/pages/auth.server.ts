import { defineHandler } from 'void';
import type { InferProps } from 'void';
import { getSession } from 'void/auth';

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(() => {
  const auth = getSession();
  return {
    user: auth?.user ?? null,
    session: auth?.session ?? null,
  };
});
