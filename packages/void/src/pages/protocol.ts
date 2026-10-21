import type { CloudBindings, CloudContext } from '../runtime/handler.ts';
import { isConvertedResponse } from '../runtime/response.ts';
import { hasActionKey, searchWithoutActionKey } from './action-key.ts';
import { DEFERRED, separateDeferred, type ResolvedDeferredGroup } from './defer.ts';
import {
  resolveHead,
  renderBodyAttrs,
  renderHeadToString,
  renderHtmlAttrs,
  type HeadDescriptor,
  type HeadConfig,
} from './head.ts';
import { escapeScriptJson } from './script-json.ts';
import { serializePageData } from './serialize.ts';
import type { DevCssAsset, PageRenderMode } from './types.ts';
import { ValidationError } from './validation-error.ts';

export { ValidationError };

const POWERED_BY = { 'X-Powered-By': 'Void' } as const;
const RENDER_ERROR_ASSET_TAGS_KEY = '__voidPageAssetTags';

/** Escape characters that are unsafe inside inline <script> tags to prevent XSS. */
export function safeJsonStringify(value: unknown): string {
  return escapeScriptJson(JSON.stringify(value) ?? 'null');
}

export type PageObject = {
  component: string;
  props: Record<string, unknown>;
  params: Record<string, string>;
  shared: Record<string, unknown>;
  url: string;
  errors: Record<string, string> | null;
  head?: HeadDescriptor;
  deferred?: Array<string>;
  deferredKeys?: Record<string, string>;
  /** Error message per failed deferred group in a prefetch payload. */
  deferredErrors?: Record<string, string>;
};

export type PageRenderResult = string | ReadableStream<Uint8Array>;

type ValidationIssue = {
  message?: string;
  path?: string;
};

type ValidationSlotIssue = {
  slot?: string;
  issues?: Array<ValidationIssue>;
};

type ValidationErrorBody = {
  issues?: Array<ValidationSlotIssue>;
};

type PageHandler = ((c: CloudContext) => unknown | Promise<unknown>) | undefined;
type PageHeadHandler =
  | ((c: CloudContext, props: Record<string, unknown>) => HeadDescriptor | undefined)
  | undefined;
type PageRenderOptions = {
  renderMode?: PageRenderMode;
  /** Dev server build: rejected deferred props keep their raw error message. */
  dev?: boolean;
};
type AssetTags = {
  css: string;
  preloads: string;
  body: string;
  devCss?: Array<DevCssAsset>;
  devCssNonce?: string;
};
type RenderPage = (pageObj: PageObject, assetTags: AssetTags) => Promise<PageRenderResult>;
type RenderPageWithMetadata = RenderPage & {
  preambleScript?: string;
};
type GetAssetTags = (req: Request, env: CloudBindings, componentId: string) => Promise<AssetTags>;

function isPagesRequest(c: CloudContext): boolean {
  return c.req.header('x-voidpages') === 'true';
}

function pageResponseHeaders(c: CloudContext, headers: Record<string, string>): Headers {
  const out = new Headers(c.res.headers);
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'vary') {
      appendVary(out, value);
    } else {
      out.set(key, value);
    }
  }
  return out;
}

function appendVary(headers: Headers, name: string): void {
  const existing =
    headers
      .get('Vary')
      ?.split(',')
      .map((value) => value.trim().toLowerCase()) ?? [];
  if (!existing.includes('*') && !existing.includes(name.toLowerCase())) {
    headers.append('Vary', name);
  }
}

function escapeHtmlAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function serializeStyleCss(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style');
}

function serializeDevCssAssets(assets: Array<DevCssAsset>, nonce: string): string {
  return assets
    .map(
      (asset) =>
        `<style data-vite-dev-id="${escapeHtmlAttr(asset.id ?? asset.url)}" nonce="${escapeHtmlAttr(nonce)}">${serializeStyleCss(asset.css)}</style>`,
    )
    .join('\n');
}

function hasCompatibleStyleSource(value: string, nonceSource: string): boolean {
  return value === "'unsafe-inline'" || value === nonceSource;
}

function adjustCspValue(value: string, nonce: string): string {
  const nonceSource = `'nonce-${nonce}'`;
  const directives = value
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  const parsed = directives.map((directive) => {
    const [name = '', ...sources] = directive.split(/\s+/);
    return { name: name.toLowerCase(), originalName: name, sources };
  });

  const style =
    parsed.find((directive) => directive.name === 'style-src-elem') ??
    parsed.find((directive) => directive.name === 'style-src');
  if (style) {
    if (!style.sources.some((source) => hasCompatibleStyleSource(source, nonceSource))) {
      style.sources.push(nonceSource);
    }
  } else {
    const defaultSrc = parsed.find((directive) => directive.name === 'default-src');
    parsed.push({
      name: 'style-src',
      originalName: 'style-src',
      sources: [...(defaultSrc?.sources ?? []), nonceSource],
    });
  }
  return parsed
    .map((directive) => [directive.originalName, ...directive.sources].join(' '))
    .join('; ');
}

function adjustDevCssCsp(headers: Headers, nonce: string | undefined): Headers {
  if (!nonce) {
    return headers;
  }
  const csp = headers.get('content-security-policy');
  if (csp) {
    headers.set('content-security-policy', adjustCspValue(csp, nonce));
  }
  const cspReportOnly = headers.get('content-security-policy-report-only');
  if (cspReportOnly) {
    headers.set('content-security-policy-report-only', adjustCspValue(cspReportOnly, nonce));
  }
  return headers;
}

function prepareAssetTags(assetTags: AssetTags): AssetTags {
  if (!assetTags.devCss || assetTags.devCss.length === 0) {
    return assetTags;
  }
  const nonce = crypto.randomUUID().replaceAll('-', '');
  return {
    ...assetTags,
    css: [assetTags.css, serializeDevCssAssets(assetTags.devCss, nonce)].filter(Boolean).join('\n'),
    devCssNonce: nonce,
  };
}

function attachRenderErrorAssetTags(error: unknown, assetTags: AssetTags): never {
  if ((typeof error === 'object' || typeof error === 'function') && error !== null) {
    Object.defineProperty(error, RENDER_ERROR_ASSET_TAGS_KEY, {
      configurable: true,
      value: assetTags,
    });
  }
  throw error;
}

async function renderWithAssetTags(
  renderFn: RenderPage,
  pageObj: PageObject,
  assetTags: AssetTags,
): Promise<PageRenderResult> {
  try {
    return await renderFn(pageObj, assetTags);
  } catch (error) {
    attachRenderErrorAssetTags(error, assetTags);
  }
}

function renderClientOnlyPage(
  pageObj: PageObject,
  assetTags: AssetTags,
  renderFn: RenderPageWithMetadata,
): string {
  const pageData = serializePageData(pageObj);
  const headHtml = pageObj.head ? renderHeadToString(pageObj.head) : '';
  const htmlAttrs = pageObj.head ? renderHtmlAttrs(pageObj.head) : '';
  const bodyAttrs = pageObj.head ? renderBodyAttrs(pageObj.head) : '';
  const preambleScript = typeof renderFn.preambleScript === 'string' ? renderFn.preambleScript : '';

  return `<!doctype html>
<html${htmlAttrs}>
<head>${headHtml}${preambleScript}${assetTags.css}${assetTags.preloads}</head>
<body${bodyAttrs}>
  <script id="__VOID_PAGE_DATA__" type="application/json">${pageData}</script>
  <div id="app" data-void-ssr="false"></div>
  ${assetTags.body}
</body>
</html>`;
}

async function renderPageHtml(
  c: CloudContext,
  pageObj: PageObject,
  componentId: string,
  renderMode: PageRenderMode,
  renderFn: RenderPageWithMetadata,
  getAssetTags: GetAssetTags,
): Promise<{ html: PageRenderResult; assetTags: AssetTags }> {
  const assetTags = prepareAssetTags(await getAssetTags(c.req.raw, c.env, componentId));
  const html =
    renderMode === 'client'
      ? renderClientOnlyPage(pageObj, assetTags, renderFn)
      : await renderWithAssetTags(renderFn, pageObj, assetTags);
  return { html, assetTags };
}

function pageJsonResponse(c: CloudContext, pageObj: PageObject): Response {
  return Response.json(pageObj, {
    headers: pageResponseHeaders(c, {
      'X-VoidPages': 'true',
      Vary: 'X-VoidPages',
      ...POWERED_BY,
    }),
  });
}

function requestPathWithSearch(c: CloudContext): string {
  return c.req.path + new URL(c.req.url).search;
}

function requestParams(c: CloudContext): Record<string, string> {
  return c.req.param() as Record<string, string>;
}

/** Extract props from a handler result, handling Response wrapping from withValidator */
async function extractProps(result: unknown): Promise<Record<string, unknown>> {
  if (result instanceof Response) {
    const contentType = result.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return (await result.json()) as Record<string, unknown>;
    }
    return {};
  }
  return (result as Record<string, unknown>) ?? {};
}

/**
 * Run a page loader. Responses from convertReturnValue (withValidator/middleware
 * paths) always flow through to extractProps — they wrap plain return values
 * (objects as 200 JSON, null/undefined as 204, strings as text/html) and must be
 * unwrapped as page props.
 *
 * User-returned Responses: pass through errors/redirects (>= 300) and non-JSON
 * 200s (file downloads, streams). JSON 200s are still extracted as props for
 * backward compat with loaders using c.json().
 */
async function runLoader(
  handler: NonNullable<PageHandler>,
  c: CloudContext,
): Promise<Response | Record<string, unknown>> {
  const result = await handler(c);
  if (result instanceof Response && !isConvertedResponse(result)) {
    const contentType = result.headers.get('content-type') || '';
    if (result.status >= 300 || !contentType.includes('application/json')) {
      return result;
    }
  }
  return extractProps(result);
}

/** Flatten withValidator's { issues: [{ slot, issues: [{ message, path }] }] } into { field: message } */
export function flattenValidationErrors(body: unknown): Record<string, string> {
  const errors: Record<string, string> = {};
  const issues = (body as ValidationErrorBody | null)?.issues;
  if (issues) {
    for (const slotIssue of issues) {
      for (const issue of slotIssue.issues ?? []) {
        // path is a dot-joined string from flattenIssues (e.g. "name", "address.city")
        const key = typeof issue.path === 'string' ? issue.path : slotIssue.slot;
        if (typeof key === 'string') {
          errors[key] = issue.message ?? 'Invalid value';
        }
      }
    }
  }
  return errors;
}

/** Strip deferred sentinels from props, setting their keys to null. Used by mutations. */
function stripDeferred(props: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value && typeof value === 'object' && DEFERRED in value) {
      result[key] = null;
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function writeRenderResult(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  result: PageRenderResult,
): Promise<void> {
  if (typeof result === 'string') {
    await writer.write(encoder.encode(result));
    return;
  }

  const reader = result.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }
    await writer.write(value);
  }
}

function renderedResponse(
  c: CloudContext,
  result: PageRenderResult,
  contentType: string,
  assetTags?: AssetTags,
): Response {
  return new Response(result, {
    headers: adjustDevCssCsp(
      pageResponseHeaders(c, {
        'content-type': contentType,
        ...POWERED_BY,
      }),
      assetTags?.devCssNonce,
    ),
  });
}

/**
 * Message sent to the browser for a rejected deferred prop. HTTPException
 * messages are deliberate and pass through, as in the page error handler.
 * Anything else is logged and, outside dev, replaced with a generic message so
 * internal details (SQL, hostnames, URLs) do not reach the page.
 */
function deferredErrorMessage(err: unknown, dev: boolean): string {
  const message = err instanceof Error ? err.message : String(err);
  if (
    err &&
    typeof err === 'object' &&
    'getResponse' in err &&
    typeof err.getResponse === 'function'
  ) {
    return message;
  }
  console.error(err);
  return dev ? message : 'Internal Server Error';
}

/** Build a streaming response that sends an initial chunk then streams deferred results. */
function streamDeferredResponse(
  initialChunk: PageRenderResult,
  deferredMap: Record<string, ResolvedDeferredGroup>,
  c: CloudContext,
  contentType: string,
  dev: boolean,
  formatResolved: (group: string, data: unknown) => string,
  formatRejected: (group: string, error: string) => string,
  assetTags?: AssetTags,
): Response {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  const entries = Object.entries(deferredMap);
  const pendingChunks = entries.map(([group, { resolver }]) =>
    resolver(c)
      .then((data) => formatResolved(group, data))
      .catch((err: unknown) => formatRejected(group, deferredErrorMessage(err, dev))),
  );

  (async () => {
    await writeRenderResult(writer, encoder, initialChunk);
    await Promise.all(
      pendingChunks.map(async (chunk) => writer.write(encoder.encode(await chunk))),
    );
    await writer.close();
  })().catch((error: unknown) => {
    writer.abort(error).catch(() => {});
  });

  return renderedResponse(c, readable, contentType, assetTags);
}

/** Handle GET page request — run handler, return page object or SSR HTML */
export async function handlePageGet(
  handler: PageHandler,
  headFn: PageHeadHandler,
  c: CloudContext,
  componentId: string,
  renderFn: RenderPage,
  getAssetTags: GetAssetTags,
  configHead?: HeadConfig,
  options?: PageRenderOptions,
): Promise<Response> {
  const renderMode = options?.renderMode ?? 'server';
  const shared = (c.get('shared') as Record<string, unknown> | undefined) ?? {};

  // Run loader and check for redirect/error responses before extracting props
  let props: Record<string, unknown> = {};
  if (handler) {
    const loaded = await runLoader(handler, c);
    if (loaded instanceof Response) {
      return loaded;
    }
    props = loaded;
  }

  const pageHead = headFn ? headFn(c, props) : undefined;
  const middlewareHead = c.get('headDefaults') as HeadDescriptor | undefined;
  const head = resolveHead(configHead, middlewareHead, pageHead);

  const { immediateProps, deferredMap } = separateDeferred(props);
  const hasDeferred = Object.keys(deferredMap).length > 0;

  // Build key-to-group mapping for the client
  const deferredKeys: Record<string, string> = {};
  for (const [group, { keys }] of Object.entries(deferredMap)) {
    for (const key of keys) {
      deferredKeys[key] = group;
    }
  }

  const pageObj: PageObject = {
    component: componentId,
    props: immediateProps,
    params: requestParams(c),
    shared,
    url: requestPathWithSearch(c),
    errors: null,
    ...(head && { head }),
    ...(hasDeferred && {
      deferred: Object.keys(deferredMap),
      deferredKeys,
    }),
  };

  // Island pages always render HTML — no Inertia JSON navigation
  if (renderMode !== 'island' && isPagesRequest(c)) {
    // Prefetch requests: resolve all deferred props inline (plain JSON, no streaming)
    const isPrefetch = c.req.header('purpose') === 'prefetch';
    if (isPrefetch && hasDeferred) {
      const resolvedProps: Record<string, unknown> = { ...immediateProps };
      let deferredErrors: Record<string, string> | undefined;
      await Promise.all(
        Object.entries(deferredMap).map(async ([group, { resolver, keys }]) => {
          try {
            const data = await resolver(c);
            if (keys.length === 1) {
              resolvedProps[keys[0]] = data ?? null;
            } else {
              const obj =
                typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
              for (const key of keys) {
                resolvedProps[key] = obj[key];
              }
            }
          } catch (err) {
            (deferredErrors ??= {})[group] = deferredErrorMessage(err, options?.dev === true);
            for (const key of keys) {
              delete resolvedProps[key];
            }
          }
        }),
      );
      return pageJsonResponse(c, {
        ...pageObj,
        props: resolvedProps,
        deferred: undefined,
        ...(deferredErrors && { deferredErrors }),
      });
    }

    if (!hasDeferred) {
      return pageJsonResponse(c, pageObj);
    }
    // Stream NDJSON: first line is PageObject, subsequent lines are deferred groups
    c.header('X-VoidPages', 'true');
    const headers = new Headers(c.res.headers);
    appendVary(headers, 'X-VoidPages');
    c.header('Vary', headers.get('Vary')!);
    return streamDeferredResponse(
      JSON.stringify(pageObj) + '\n',
      deferredMap,
      c,
      'application/x-ndjson',
      options?.dev === true,
      (group, data) => JSON.stringify({ __deferred: group, data: data ?? null }) + '\n',
      (group, error) => JSON.stringify({ __deferred: group, error }) + '\n',
    );
  }

  const { html, assetTags } = await renderPageHtml(
    c,
    pageObj,
    componentId,
    renderMode,
    renderFn,
    getAssetTags,
  );

  if (!hasDeferred) {
    return renderedResponse(c, html, 'text/html; charset=utf-8', assetTags);
  }

  // Stream HTML followed by deferred <script> tags
  return streamDeferredResponse(
    html,
    deferredMap,
    c,
    'text/html; charset=utf-8',
    options?.dev === true,
    (group, data) => {
      const g = safeJsonStringify(group);
      return `\n<script>(function(d){window.__resolveDeferred?window.__resolveDeferred(${g},d):(window.__deferredQueue??=[]).push([${g},d])})(${safeJsonStringify(data)})</script>`;
    },
    (group, error) => {
      const g = safeJsonStringify(group);
      return `\n<script>(function(e){window.__rejectDeferred?window.__rejectDeferred(${g},e):(window.__deferredQueue??=[]).push([${g},0,e])})(${safeJsonStringify(error)})</script>`;
    },
    assetTags,
  );
}

function isSameOriginAction(request: Request): boolean {
  const origin = new URL(request.url).origin;
  const suppliedOrigin = request.headers.get('Origin');
  if (suppliedOrigin !== null) {
    return suppliedOrigin === origin;
  }
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return false;
  }
  const referer = request.headers.get('Referer');
  if (referer !== null) {
    try {
      return new URL(referer).origin === origin;
    } catch {
      return false;
    }
  }
  // Non-browser clients may omit browser-controlled origin metadata entirely.
  return true;
}

/** Handle POST/PUT/PATCH/DELETE page request — run mutation, then re-run GET or redirect */
export async function handlePageMutation(
  mutationHandler: PageHandler,
  getHandler: PageHandler,
  headFn: PageHeadHandler,
  c: CloudContext,
  componentId: string,
  renderFn: RenderPage,
  getAssetTags: GetAssetTags,
  configHead?: HeadConfig,
  options?: PageRenderOptions,
): Promise<Response> {
  if (!isSameOriginAction(c.req.raw)) {
    return new Response('Cross-origin page actions are not allowed.', { status: 403 });
  }
  const renderMode = options?.renderMode ?? 'server';
  const shared = (c.get('shared') as Record<string, unknown> | undefined) ?? {};
  const middlewareHead = c.get('headDefaults') as HeadDescriptor | undefined;

  function buildMutationPageObj(
    props: Record<string, unknown>,
    errors: Record<string, string> | null,
  ): PageObject {
    const pageHead = headFn ? headFn(c, props) : undefined;
    const head = resolveHead(configHead, middlewareHead, pageHead);
    return {
      component: componentId,
      props,
      params: requestParams(c),
      shared,
      url: hasActionKey(c.req.raw)
        ? c.req.path + searchWithoutActionKey(new URL(c.req.url).search)
        : requestPathWithSearch(c),
      errors,
      ...(head && { head }),
    };
  }

  /** Re-run the GET loader and respond with the page, optionally carrying validation errors. */
  async function respondWithPage(errors: Record<string, string> | null): Promise<Response> {
    const loaded = getHandler ? await runLoader(getHandler, c) : {};
    if (loaded instanceof Response) {
      return loaded;
    }
    const pageObj = buildMutationPageObj(stripDeferred(loaded), errors);
    if (isPagesRequest(c)) {
      return pageJsonResponse(c, pageObj);
    }
    const { html, assetTags } = await renderPageHtml(
      c,
      pageObj,
      componentId,
      renderMode,
      renderFn,
      getAssetTags,
    );
    return renderedResponse(c, html, 'text/html; charset=utf-8', assetTags);
  }

  function respondWithErrors(errors: Record<string, string>): Promise<Response> {
    if (renderMode === 'island') {
      return Promise.resolve(Response.json({ errors }, { status: 422 }));
    }
    return respondWithPage(errors);
  }

  let result: unknown;
  try {
    result = mutationHandler ? await mutationHandler(c) : undefined;
  } catch (e) {
    if (e instanceof ValidationError) {
      return respondWithErrors(e.errors);
    }
    throw e;
  }

  // Handle Response results (from withValidator or explicit redirect)
  if (result instanceof Response) {
    const status = result.status;
    // Redirect
    if (status >= 300 && status < 400) {
      return result;
    }
    // Only a withValidator issues body becomes field errors; other 400s pass through
    if (status === 400) {
      const body: unknown = await result
        .clone()
        .json()
        .catch(() => null);
      if (Array.isArray((body as ValidationErrorBody | null)?.issues)) {
        return respondWithErrors(flattenValidationErrors(body));
      }
      return result;
    }
    // 204 (void from withValidator) — fall through to re-run GET
    if (status !== 204) {
      return result;
    }
  }

  // void — re-run GET with fresh props
  if (renderMode === 'island') {
    return Response.json({ success: true });
  }
  return respondWithPage(null);
}
