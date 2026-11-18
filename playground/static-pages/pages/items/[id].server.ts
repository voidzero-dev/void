import { defineHandler } from 'void';
import type { PageParams } from 'void/routes';

export type Props = Readonly<{
  id: string;
}>;

export const loader = defineHandler<Props>((c) => {
  const { id } = c.req.param() as PageParams<'/items/[id]'>;
  return { id };
});
