import { defineHandler } from 'void';

export type Props = Readonly<{
  title: string;
}>;

export const loader = defineHandler<Props>(() => {
  return { title: 'Home' };
});
