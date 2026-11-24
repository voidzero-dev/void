import { renderToString } from 'react-dom/server';
import { defineRender } from 'void';
import App from './App.tsx';

async function readBlogPost(slug: string): Promise<string | null> {
  return (await import(`../blog/${slug}.md?raw`)).default;
}

export default defineRender(async (c, assetTags) => {
  const url = new URL(c.req.url);
  const currentCount = Number((await c.env.KV.get('ssr:visits')) ?? '0');
  const nextCount = currentCount + 1;
  await c.env.KV.put('ssr:visits', String(nextCount));

  const blogMatch = url.pathname.match(/^\/blog\/(.+)$/);
  const blogContent = blogMatch ? await readBlogPost(blogMatch[1]) : null;

  const appHtml = renderToString(
    <App url={url.pathname} visitCount={nextCount} blogContent={blogContent} />,
  );
  const stateJson = JSON.stringify({ visits: nextCount, blogContent }).replaceAll(
    '<',
    String.raw`\u003c`,
  );
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Void SSR Playground</title>
    <script>window.__STATE__=${stateJson}</script>
    ${assetTags.css}${assetTags.preloads}
  </head>
  <body>
    <div id="root">${appHtml}</div>
    ${assetTags.body}
  </body>
</html>`;

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
});
