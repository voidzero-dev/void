import { jsx } from 'hono/jsx';
import type { Child, FC } from 'hono/jsx';
import { createSsrRouter, idleNavigationState } from 'void/pages-client';
import { renderBodyAttrs, renderHeadToString, renderHtmlAttrs } from 'void/pages-head';
import type { PageObject } from 'void/pages-protocol';
import { islandFrontmatterScript, serializePageData } from 'void/pages-server';
import {
  ErrorsContext,
  FrontmatterContext,
  NavigationContext,
  ParamsContext,
  RouterContext,
  SharedContext,
} from './context.ts';

// oxlint-disable-next-line no-explicit-any -- component props are narrowed by generated route types
type ComponentModule = { default: FC<any>; frontmatter?: Record<string, unknown> };

export type HonoPagesServerConfig = Readonly<{
  pageObj: PageObject;
  assetTags: { css: string; preloads: string; body: string };
  components: Record<string, () => Promise<ComponentModule>>;
  layoutTree: Record<string, Array<string>>;
  requestUrl?: string;
}>;

export type HonoIslandPagesServerConfig = Omit<HonoPagesServerConfig, 'requestUrl'> &
  Readonly<{
    /** Markdown pages that have a client script. */
    mdClientScriptIds: ReadonlySet<string>;
    /** Pages with an island or a client script; the others ship no JavaScript. */
    pagesNeedingClientJS: ReadonlySet<string>;
    isDev: boolean;
  }>;

type Renderable = { toString(): string | Promise<string> };

async function loadPage({
  pageObj,
  components,
  layoutTree,
}: Pick<HonoPagesServerConfig, 'pageObj' | 'components' | 'layoutTree'>): Promise<{
  pageModule: ComponentModule;
  element: Child;
}> {
  const pageModule = await components[pageObj.component]();
  const layoutIds = layoutTree[pageObj.component] || [];
  const layoutComponents = await Promise.all(
    layoutIds.map(async (id) => (await components[id]()).default),
  );

  let element: Child = jsx(pageModule.default, pageObj.props);
  for (let i = layoutComponents.length - 1; i >= 0; i--) {
    element = jsx(layoutComponents[i], {}, element);
  }
  return { pageModule, element };
}

function withPageContexts(pageObj: PageObject, element: Child): Renderable {
  return jsx(
    SharedContext.Provider,
    { value: pageObj.shared || {} },
    jsx(
      ParamsContext.Provider,
      { value: pageObj.params ?? {} },
      jsx(ErrorsContext.Provider, { value: pageObj.errors || {} }, element),
    ),
  );
}

// Hono JSX returns a promise when the tree has an async component.
async function renderToString(element: Renderable): Promise<string> {
  return String(await element.toString());
}

function renderDocument(pageObj: PageObject, head: string, body: string): string {
  const headHtml = pageObj.head ? renderHeadToString(pageObj.head) : '';
  const htmlAttrs = pageObj.head ? renderHtmlAttrs(pageObj.head) : '';
  const bodyAttrs = pageObj.head ? renderBodyAttrs(pageObj.head) : '';

  return `<!doctype html>
<html${htmlAttrs}>
<head>${headHtml}${head}</head>
<body${bodyAttrs}>
  ${body}
</body>
</html>`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** A regular page: rendered here, then hydrated and driven by the Void Router in the browser. */
export async function renderHonoPage(config: HonoPagesServerConfig): Promise<string> {
  const { pageObj, assetTags, requestUrl } = config;
  const { element } = await loadPage(config);

  const html = await renderToString(
    jsx(
      RouterContext.Provider,
      { value: createSsrRouter(pageObj.url || '/', pageObj.params ?? {}, requestUrl) },
      jsx(
        NavigationContext.Provider,
        { value: idleNavigationState() },
        withPageContexts(pageObj, element) as Child,
      ),
    ),
  );

  return renderDocument(
    pageObj,
    `${assetTags.css}${assetTags.preloads}`,
    `<script id="__VOID_PAGE_DATA__" type="application/json">${serializePageData(pageObj)}</script>
  <div id="app">${html}</div>
  ${assetTags.body}`,
  );
}

/** An island page or a Markdown page: static HTML, with JavaScript only for its islands. */
export async function renderHonoIslandPage(config: HonoIslandPagesServerConfig): Promise<string> {
  const { pageObj, assetTags, mdClientScriptIds, pagesNeedingClientJS, isDev } = config;
  const { pageModule, element } = await loadPage(config);

  // No RouterContext — islands have no Void Router.
  // Frontmatter wraps the layouts so they can read the Markdown page's values.
  const html = await renderToString(
    withPageContexts(
      pageObj,
      jsx(FrontmatterContext.Provider, { value: pageModule.frontmatter ?? {} }, element),
    ),
  );

  const needsClientJS = pagesNeedingClientJS.has(pageObj.component);
  // The dev client reloads the page when a file changes, also on pages without islands.
  const needsAssets = needsClientJS || isDev;
  // Islands hydrate as separate roots. Send the page frontmatter so their
  // useFrontmatter() returns the same value in the browser.
  const frontmatterScript =
    needsClientJS && html.includes('data-island=')
      ? islandFrontmatterScript(pageModule.frontmatter)
      : '';
  const mdScriptAttr = mdClientScriptIds.has(pageObj.component)
    ? ` data-md-script="${escapeAttr(pageObj.component)}"`
    : '';

  return renderDocument(
    pageObj,
    `${assetTags.css}${needsAssets ? assetTags.preloads : ''}`,
    `<div id="app"${mdScriptAttr}>${html}</div>
  ${frontmatterScript}${needsAssets ? assetTags.body : ''}`,
  );
}
