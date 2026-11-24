import { defineHandler } from 'void';
import type { InferProps } from 'void';

export const ssr = false;
export const prerender = true;

export const loader = defineHandler(() => ({
  title: 'Client-only Static Page',
  marker: 'static-loader-props',
}));

export type Props = InferProps<typeof loader>;
