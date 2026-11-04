import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import solid from 'vite-plugin-solid';
import { expect, it } from 'vite-plus/test';
import { pagesPlugin } from '../../src/plugin-pages.ts';

const PAGE = `import { Link, useParams } from "@void/solid";
export default function Post(props) {
  const params = useParams();
  return <main>
    <h1 id="title">{props.title}</h1>
    <p id="slug">{params.slug}</p>
    <Link href="/posts/b">Post b</Link>
  </main>;
}`;

const LAYOUT = `import { useParams } from "@void/solid";
export default function Layout(props) {
  const params = useParams();
  return <div><p id="layout-slug">{params.slug}</p>{props.children}</div>;
}`;

function pageData(slug: string) {
  return {
    component: 'posts/[slug]',
    props: { title: `Post ${slug}` },
    params: { slug },
    shared: {},
    url: `/posts/${slug}`,
  };
}

// The document a Void Worker sends for a client-rendered page. It boots the real
// generated pages client, which then fetches pageData() as JSON on a Link navigation.
function clientDocument(slug: string): string {
  return `<!doctype html>
<script id="__VOID_PAGE_DATA__" type="application/json">${JSON.stringify(pageData(slug))}</script>
<div id="app" data-void-ssr="false"></div>
<script type="module" src="/@id/__x00__virtual:void-pages-client"></script>`;
}

it('useParams() follows navigation between two params of the same page', async () => {
  const root = mkdtempSync(join(import.meta.dirname, '.tmp-use-params-'));
  const pages = join(root, 'pages');
  mkdirSync(join(pages, 'posts'), { recursive: true });
  writeFileSync(join(pages, 'layout.tsx'), LAYOUT);
  writeFileSync(join(pages, 'posts', '[slug].tsx'), PAGE);

  const browser = await chromium.launch();
  const server = await createServer({
    root,
    configFile: false,
    cacheDir: join(root, '.vite'),
    logLevel: 'silent',
    appType: 'custom',
    server: { port: 0, host: '127.0.0.1' },
    resolve: { alias: { '@void/solid': join(import.meta.dirname, '../../src/runtime/index.ts') } },
    plugins: [
      solid(),
      pagesPlugin(pages, { root }),
      {
        name: 'test:void-page-responses',
        configureServer(viteServer) {
          viteServer.middlewares.use((req, res, next) => {
            const slug = /^\/posts\/(\w+)$/.exec(req.url ?? '')?.[1];
            if (!slug) {
              next();
              return;
            }
            if (req.headers['x-voidpages']) {
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('X-VoidPages', 'true');
              res.end(JSON.stringify(pageData(slug)));
              return;
            }
            res.setHeader('Content-Type', 'text/html');
            res.end(clientDocument(slug));
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const page = await browser.newPage();
    await page.goto(`${server.resolvedUrls!.local[0]}posts/a`);
    await page.waitForSelector('#app[data-hydrated="true"]');
    expect(await page.textContent('#slug')).toBe('a');
    expect(await page.textContent('#layout-slug')).toBe('a');

    // A full reload would also render "b", so check that the document survives.
    await page.evaluate(() => {
      document.documentElement.dataset.sameDocument = 'true';
    });
    await page.click('a[href="/posts/b"]');
    await page.waitForFunction(() => document.getElementById('title')?.textContent === 'Post b');
    expect(await page.textContent('#slug')).toBe('b');
    expect(await page.textContent('#layout-slug')).toBe('b');
    expect(await page.getAttribute('html', 'data-same-document')).toBe('true');
  } finally {
    await server.close();
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
});
