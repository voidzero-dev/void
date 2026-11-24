import { html } from 'hono/html';
import { jsx, type Child } from 'hono/jsx';
import { renderBodyAttrs, renderHeadToString, renderHtmlAttrs } from '../../pages/head.ts';
import type { PageObject } from '../../pages/protocol.ts';
import type { CloudContext } from '../handler/index.ts';
import type { ClientAssetTags } from './assets.ts';

type PageView = (props: PageObject['props']) => Child | Promise<Child>;
type ContextView = (c: CloudContext) => Child | Promise<Child>;
type PageModule =
  | { loader?: undefined; default: ContextView }
  | { loader: (c: CloudContext) => unknown; default: PageView };
type LayoutView = (c: CloudContext, children: Child) => Child | Promise<Child>;
type ViewPlan = {
  layouts: Array<() => Promise<{ default: LayoutView }>>;
} & (
  | { boundary: true; load: () => Promise<{ default: ContextView }> }
  | { boundary?: false; load: () => Promise<PageModule> }
);

async function bindView(
  plan: ViewPlan,
  page: PageObject,
  c: CloudContext,
): Promise<() => Child | Promise<Child>> {
  if (plan.boundary) {
    const { default: view } = await plan.load();
    assertView(view, page.component);
    return () => view(c);
  }
  const module = await plan.load();
  assertView(module.default, page.component);
  if (module.loader) {
    return () => module.default(page.props);
  }
  return () => module.default(c);
}

function assertView(view: unknown, component: string): void {
  if (typeof view !== 'function') {
    throw new Error(`Expected a default component export for ${component}`);
  }
}

export function createServerViewRenderer(
  plans: Record<string, ViewPlan>,
): (page: PageObject, assets: ClientAssetTags, url: string, c?: CloudContext) => Promise<string> {
  return async (page: PageObject, assets: ClientAssetTags, _url: string, c?: CloudContext) => {
    if (!c) {
      throw new Error('Void server views need a request context.');
    }
    const plan = plans[page.component];
    if (!plan) {
      throw new Error(`Unknown Void server view: ${page.component}`);
    }
    const [view, ...layouts] = await Promise.all([
      bindView(plan, page, c),
      ...plan.layouts.map((load) => load()),
    ]);
    // Lazy nodes let Hono evaluate descendants inside a layout's context provider.
    let content: Child = jsx(view, {});
    for (const { default: Layout } of layouts.reverse()) {
      if (typeof Layout !== 'function') {
        throw new Error(`Expected a default component export in a layout for ${page.component}`);
      }
      const children = content;
      content = jsx(() => Layout(c, children), {});
    }
    // Hono's html helper resolves promises anywhere in the JSX tree and escapes text.
    const body = (await html`${content}`).toString();
    const head = page.head;
    return `<!doctype html><html${head ? renderHtmlAttrs(head) : ''}><head>${head ? renderHeadToString(head) : ''}${assets.css}</head><body${head ? renderBodyAttrs(head) : ''}>${body}</body></html>`;
  };
}
