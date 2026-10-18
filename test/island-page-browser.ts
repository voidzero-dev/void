import { writeFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { createServer, type PluginOption } from 'vite';
import { collectBrowserDiagnostics } from './browser-helpers.ts';

type IslandRenderer = {
  renderIslandPage(
    page: { component: string; props: Record<string, unknown> },
    assetTags: { css: string; preloads: string; body: string },
  ): Promise<string>;
};

export type IslandPageVisit = Readonly<{
  /** The HTML the server sent, before any island hydrated. */
  html: string;
  page: Page;
  diagnostics: () => string;
  close: () => Promise<void>;
}>;

/**
 * Serve `pages/index` under `root` through an adapter's island renderer in Vite
 * dev and open it in Chromium. `plugins` must include the adapter's
 * `islandsPlugin` and anything its pages need.
 */
export async function openIslandPage(
  root: string,
  // Plugins come from each package's own Vite types, so take them loosely here.
  options: { plugins: ReadonlyArray<object>; alias?: Record<string, string> },
): Promise<IslandPageVisit> {
  writeFileSync(`${root}/entry.js`, 'import "virtual:void-islands-client";\n');
  const browser = await chromium.launch();
  const server = await createServer({
    root,
    configFile: false,
    cacheDir: `${root}/.vite`,
    logLevel: 'silent',
    appType: 'custom',
    server: { port: 0, host: '127.0.0.1' },
    resolve: { alias: options.alias },
    plugins: [
      ...(options.plugins as Array<PluginOption>),
      {
        name: 'test:render-island-index',
        configureServer(viteServer) {
          viteServer.middlewares.use(async (request, response, next) => {
            if (request.url !== '/') {
              next();
              return;
            }
            try {
              const renderer = (await viteServer.ssrLoadModule(
                'virtual:void-islands-renderer',
              )) as IslandRenderer;
              const html = await renderer.renderIslandPage(
                { component: 'index', props: {} },
                { css: '', preloads: '', body: '<script type="module" src="/entry.js"></script>' },
              );
              response.setHeader('Content-Type', 'text/html');
              response.end(html);
            } catch (error) {
              next(error);
            }
          });
        },
      },
    ],
  });
  const close = async () => {
    await server.close();
    await browser.close();
  };
  try {
    await server.listen();
    const page = await browser.newPage();
    const diagnostics = collectBrowserDiagnostics(page);
    const response = await page.goto(server.resolvedUrls!.local[0]);
    return { html: await response!.text(), page, diagnostics, close };
  } catch (error) {
    await close();
    throw error;
  }
}
