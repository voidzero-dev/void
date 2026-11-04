import { defineHandler, defineHead } from 'void';
import type { Href } from 'void/routes';

export type Props = Readonly<{
  title: string;
  absoluteUrl: Href;
  protocolRelativeUrl: Href;
}>;

export const loader = defineHandler<Props>((c) => {
  const url = new URL(c.req.url);
  // Exercise browser URL forms independently of the typed route inventory.
  return {
    title: 'Link Behavior',
    absoluteUrl: `${url.origin}/link-behavior` as Href,
    protocolRelativeUrl: `//${url.host}/link-behavior` as Href,
  };
});

export const head = defineHead<Props>((c, props) => {
  return { title: props.title };
});

// The POST Link on this page submits here; the page then shows its data again.
export const action = defineHandler(() => {});
