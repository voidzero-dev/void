import React, { type ComponentType } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { createSsrRouter, idleNavigationState } from 'void/pages-client';
import { renderBodyAttrs, renderHeadToString, renderHtmlAttrs } from 'void/pages-head';
import type { PageObject } from 'void/pages-protocol';
import { serializePageData } from 'void/pages-server';
import {
  ErrorsContext,
  NavigationContext,
  ParamsContext,
  RouterContext,
  SharedContext,
} from './context.ts';
import { DEFERRED_SHELL_CANCEL_REASON, DEFERRED_SHELL_DIGEST } from './deferred-shell.ts';
import { concatStreams } from './page-streams.ts';

// oxlint-disable-next-line no-explicit-any -- component props are narrowed by generated route types
type ComponentModule = { default: ComponentType<any> };

export type ReactPagesServerConfig = Readonly<{
  pageObj: PageObject;
  assetTags: { css: string; preloads: string; body: string };
  components: Record<string, () => Promise<ComponentModule>>;
  layoutTree: Record<string, Array<string>>;
  requestUrl?: string;
  preambleScript?: string;
}>;

function createPendingDeferred(): Promise<never> {
  return new Promise(() => {});
}

function propsForReactRender(pageObj: PageObject): Record<string, unknown> {
  if (!pageObj.deferredKeys) {
    return pageObj.props;
  }
  const props = { ...pageObj.props };
  for (const key of Object.keys(pageObj.deferredKeys)) {
    props[key] = createPendingDeferred();
  }
  return props;
}

function textStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

export async function renderReactPage({
  pageObj,
  assetTags,
  components,
  layoutTree,
  requestUrl,
  preambleScript = '',
}: ReactPagesServerConfig): Promise<ReadableStream<Uint8Array>> {
  const PageComponent = (await components[pageObj.component]()).default;
  const layoutIds = layoutTree[pageObj.component] || [];
  const layoutComponents = await Promise.all(
    layoutIds.map(async (id) => (await components[id]()).default),
  );
  const renderProps = propsForReactRender(pageObj);

  let element = React.createElement(PageComponent, renderProps);
  for (let i = layoutComponents.length - 1; i >= 0; i--) {
    element = React.createElement(layoutComponents[i], null, element);
  }

  element = React.createElement(
    RouterContext.Provider,
    { value: createSsrRouter(pageObj.url || '/', pageObj.params ?? {}, requestUrl) },
    React.createElement(
      NavigationContext.Provider,
      { value: idleNavigationState() },
      React.createElement(
        React.Suspense,
        { fallback: null },
        React.createElement(
          SharedContext.Provider,
          { value: pageObj.shared || {} },
          React.createElement(
            ParamsContext.Provider,
            { value: pageObj.params ?? {} },
            React.createElement(ErrorsContext.Provider, { value: pageObj.errors || {} }, element),
          ),
        ),
      ),
    ),
  );

  // React calls onError inside its work loop, so it must not throw. The outer
  // Suspense turns page errors into a client-render fallback; fail the render
  // instead when they happen before the shell, so the caller serves its error page.
  let shellError: { error: unknown } | undefined;
  let shellSent = false;
  const deferredAbort = pageObj.deferredKeys ? new AbortController() : undefined;
  const appStream = await renderToReadableStream(element, {
    signal: deferredAbort?.signal,
    onError(error) {
      if (error === DEFERRED_SHELL_CANCEL_REASON) {
        return DEFERRED_SHELL_DIGEST;
      }
      if (shellSent) {
        console.error(error);
        return;
      }
      shellError ??= { error };
    },
  });
  if (shellError) {
    await appStream.cancel(shellError.error);
    throw shellError.error;
  }
  shellSent = true;
  // Void streams deferred values separately. Let React finish its fallback
  // boundaries with an identifiable digest instead of truncating its stream.
  deferredAbort?.abort(DEFERRED_SHELL_CANCEL_REASON);
  const pageData = serializePageData(pageObj);
  const headHtml = pageObj.head ? renderHeadToString(pageObj.head) : '';
  const htmlAttrs = pageObj.head ? renderHtmlAttrs(pageObj.head) : '';
  const bodyAttrs = pageObj.head ? renderBodyAttrs(pageObj.head) : '';

  return concatStreams([
    textStream(`<!doctype html>
<html${htmlAttrs}>
<head>${headHtml}${preambleScript}${assetTags.css}${assetTags.preloads}</head>
<body${bodyAttrs}>
  ${pageObj.documentOnly ? '' : `<script id="__VOID_PAGE_DATA__" type="application/json">${pageData}</script>`}
  <div id="app">`),
    appStream,
    textStream(`</div>
  ${assetTags.body}
</body>
</html>`),
  ]);
}
