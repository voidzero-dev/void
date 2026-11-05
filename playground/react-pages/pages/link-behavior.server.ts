import { defineHandler, defineHead } from 'void';
import type { Href } from 'void/routes';

export type Props = Readonly<{
  title: string;
  absoluteUrl: Href;
  protocolRelativeUrl: Href;
}>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const loader = defineHandler<Props>(async (c) => {
  if (c.req.query('abort-slow')) {
    await sleep(1000);
  }

  const url = new URL(c.req.url);
  // Exercise browser URL forms independently of the typed route inventory.
  return {
    title: 'Link Behavior',
    absoluteUrl: `${url.origin}/link-behavior` as Href,
    protocolRelativeUrl: `//${url.host}/link-behavior` as Href,
  };
});

export const head = defineHead<Props>((c, props) => {
  return {
    title: props.title,
    link: [
      { rel: 'stylesheet', href: '/hash-navigation-test.css' },
      {
        rel: 'preload',
        href: '/hash-navigation-test.woff2',
        as: 'font',
        type: 'font/woff2',
        crossorigin: 'anonymous',
      },
    ],
  };
});

// The POST Link on this page submits here; the page then shows its data again.
export const action = defineHandler(() => {});
