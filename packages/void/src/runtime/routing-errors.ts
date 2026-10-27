import type { Context } from 'hono';
import { renderDefaultErrorPage } from './error-pages/index.ts';

type ErrorPageStatus = 404 | 500;

type StackFrame = {
  functionName: string;
  file: string;
  line: number;
  column: number;
  displayPath: string;
  href: string;
  raw: string;
};
type ErrorDetails = { name: string; message: string; stack: string; frames: Array<StackFrame> };
export type ErrorRendererOptions = { dev?: boolean; projectRoot: string; homeDir: string };
export type ErrorRenderer = {
  createResponse: (
    request: Request,
    status: ErrorPageStatus,
    title: string,
    error?: unknown,
  ) => Response;
  serveCustomPage: (
    context: Context,
    status: ErrorPageStatus,
    title: string,
    error?: unknown,
  ) => Promise<Response>;
  onError: (error: Error, context: Context) => Promise<Response> | Response;
};
const ERROR_PAGE_FONT_STACK =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const errorStack = Error as unknown as {
  captureStackTrace?: (error: Error, constructor?: Function) => void;
  prepareStackTrace?: (error: Error, sites: Array<NodeJS.CallSite>) => unknown;
};

/** Error rendering is shared by generated Pages apps; production never includes exception details. */
export function createErrorRenderer(options: ErrorRendererOptions): ErrorRenderer {
  const dev = options.dev === true;
  function escapeHtml(value: unknown): string {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function shouldServeHtmlErrorPage(request: Request): boolean {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return false;
    }
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return false;
    }
    if (/\/[^/]+\.[^/]+$/.test(url.pathname)) {
      return false;
    }
    const destination = request.headers.get('sec-fetch-dest');
    if (destination && destination !== 'document' && destination !== 'empty') {
      return false;
    }
    const accept = request.headers.get('accept');
    return !accept || accept.includes('text/html') || accept.includes('*/*');
  }

  function normalizeFsPath(value: unknown): string {
    return typeof value === 'string' ? value.replaceAll('\\', '/') : '';
  }

  function isAbsolutePath(value: string): boolean {
    return value.startsWith('/') || /^[A-Za-z]:\//.test(value);
  }

  function toDisplayPath(value: unknown): string {
    const path = normalizeFsPath(value);
    const homeDir = normalizeFsPath(options.homeDir);
    const projectRoot = normalizeFsPath(options.projectRoot);
    if (!path) {
      return '';
    }
    if (projectRoot && (path === projectRoot || path.startsWith(projectRoot + '/'))) {
      const suffix = path.slice(projectRoot.length).replace(/^\/?/, '');
      return suffix ? './' + suffix : './';
    }
    if (homeDir && (path === homeDir || path.startsWith(homeDir + '/'))) {
      const suffix = path.slice(homeDir.length).replace(/^\/?/, '');
      return suffix ? '~/' + suffix : '~/';
    }
    return path;
  }

  function editorHref(value: unknown, line: number, column: number): string {
    const path = normalizeFsPath(value);
    if (!isAbsolutePath(path)) {
      return '';
    }
    return (
      'vscode://file/' +
      encodeURI(path).replaceAll('#', '%23').replaceAll('?', '%3F') +
      ':' +
      String(line) +
      ':' +
      String(column)
    );
  }

  function createStackFrame(
    functionName: string | null | undefined,
    file: unknown,
    line: unknown,
    column: unknown,
    raw: string,
  ): StackFrame | null {
    const normalizedFile = normalizeFsPath(file);
    const lineNumber = Number(line);
    const columnNumber = Number(column);
    if (!normalizedFile || !Number.isFinite(lineNumber) || lineNumber <= 0) {
      return null;
    }
    const safeColumn = Number.isFinite(columnNumber) && columnNumber > 0 ? columnNumber : 1;
    return {
      functionName: functionName || '',
      file: normalizedFile,
      line: lineNumber,
      column: safeColumn,
      displayPath: toDisplayPath(normalizedFile),
      href: editorHref(normalizedFile, lineNumber, safeColumn),
      raw: raw || '',
    };
  }

  function parseFrameLocation(value: string): StackFrame | null {
    const match = value.match(/^(.*):(\d+):(\d+)$/);
    if (!match) {
      return null;
    }
    return createStackFrame('', match[1], Number(match[2]), Number(match[3]), value);
  }

  function parseStackFrames(stack: string): Array<StackFrame> {
    if (!stack) {
      return [];
    }
    const frames = [];
    for (const rawLine of stack.split(/\n+/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      let frame = null;
      let match = line.match(/^at\s+(?:async\s+)?(.+?)\s+\((.+)\)$/);
      if (match) {
        const location = parseFrameLocation(match[2]);
        frame = location ? { ...location, functionName: match[1] } : null;
      } else {
        match = line.match(/^at\s+(.+)$/);
        if (match) {
          frame = parseFrameLocation(match[1]);
        } else {
          match = line.match(/^(.*?)@(.+)$/);
          if (match) {
            const location = parseFrameLocation(match[2]);
            frame = location ? { ...location, functionName: match[1] } : null;
          }
        }
      }
      if (frame) {
        frames.push({ ...frame, raw: line });
      }
    }
    return frames;
  }

  function getStackFrames(error: unknown): Array<StackFrame> {
    if (!(error instanceof Error)) {
      return [];
    }
    if (!error.stack && typeof errorStack.captureStackTrace === 'function') {
      try {
        errorStack.captureStackTrace(error, getStackFrames);
      } catch {
        // Ignore runtimes that reject captureStackTrace on thrown errors.
      }
    }
    const originalPrepareStackTrace = errorStack.prepareStackTrace;
    try {
      errorStack.prepareStackTrace = (_, callSites) => callSites;
      const structured: unknown = error.stack;
      if (Array.isArray(structured)) {
        const frames = [];
        for (const callSite of structured) {
          try {
            const fileName = callSite.getFileName?.() || callSite.getScriptNameOrSourceURL?.();
            const line = callSite.getLineNumber?.();
            const column = callSite.getColumnNumber?.();
            const functionName = callSite.getFunctionName?.() || callSite.getMethodName?.() || '';
            const frame = createStackFrame(
              functionName,
              fileName || '',
              line,
              column,
              String(callSite),
            );
            if (frame) {
              frames.push(frame);
            }
          } catch {
            // Ignore malformed CallSite entries and continue rendering.
          }
        }
        if (frames.length > 0) {
          return frames;
        }
      }
    } catch {
      // Fall through to string parsing.
    } finally {
      errorStack.prepareStackTrace = originalPrepareStackTrace;
    }
    return parseStackFrames(typeof error.stack === 'string' ? error.stack : '');
  }

  function describeThrownValue(value: unknown): ErrorDetails {
    if (value instanceof Error) {
      return {
        name: value.name || 'Error',
        message: value.message || '',
        stack: typeof value.stack === 'string' ? value.stack : '',
        frames: getStackFrames(value),
      };
    }
    if (typeof value === 'string') {
      return { name: 'Thrown value', message: value, stack: '', frames: [] };
    }
    let message = '';
    try {
      if (typeof value === 'object' && value !== null) {
        message = JSON.stringify(value, null, 2) ?? String(value);
      } else {
        message = String(value);
      }
    } catch {
      message = String(value);
    }
    return { name: 'Thrown value', message, stack: '', frames: [] };
  }

  function renderStack(entry: ErrorDetails): string {
    if (Array.isArray(entry.frames) && entry.frames.length > 0) {
      const items = entry.frames
        .map((frame) => {
          const name = frame.functionName || '(anonymous)';
          const location = frame.displayPath + ':' + frame.line + ':' + frame.column;
          const body = `<span class="__void-error-frame-function">${escapeHtml(name)}</span><span class="__void-error-frame-location">${escapeHtml(location)}</span>`;
          if (frame.href) {
            return `<a class="__void-error-frame" href="${escapeHtml(frame.href)}">${body}</a>`;
          }
          return `<div class="__void-error-frame is-static">${body}</div>`;
        })
        .join('');
      return `<div class="__void-error-stack"><div class="__void-error-stack-label">Stack trace</div><div class="__void-error-frames">${items}</div></div>`;
    }
    if (!entry.stack) {
      return '';
    }
    return `<div class="__void-error-stack"><div class="__void-error-stack-label">Stack trace</div><pre>${escapeHtml(entry.stack)}</pre></div>`;
  }

  function collectErrorChain(error: unknown): Array<ErrorDetails & { label: string }> {
    const chain = [];
    const seen = new Set();
    let current = error;
    let depth = 0;
    while (current != null && depth < 8 && !seen.has(current)) {
      seen.add(current);
      const entry = describeThrownValue(current);
      chain.push({
        label: depth === 0 ? 'Error' : 'Cause ' + depth,
        ...entry,
      });
      current = current instanceof Error ? current.cause : undefined;
      depth += 1;
    }
    if (current != null) {
      chain.push({
        label: 'Cause ' + depth,
        name: 'Truncated',
        message: 'Additional nested causes were omitted.',
        stack: '',
        frames: [],
      });
    }
    if (chain.length === 0) {
      chain.push({
        label: 'Error',
        name: 'Unknown error',
        message: 'No error details were available.',
        stack: '',
        frames: [],
      });
    }
    return chain;
  }

  function renderDevErrorOverlay(status: number, title: string, error: unknown): string {
    const chain = collectErrorChain(error);
    const errorCountLabel = chain.length + (chain.length === 1 ? ' Error' : ' Errors');
    const sections = chain
      .map((entry, index) => {
        const heading = entry.name || (index === 0 ? title : 'Cause');
        const message = entry.message || title;
        const stack = renderStack(entry);
        if (index === 0) {
          return `<section class="__void-error-section is-root"><p class="__void-error-message">${escapeHtml(message)}</p>${stack}</section>`;
        }
        return `<section class="__void-error-section"><div class="__void-error-kicker">${escapeHtml(entry.label)}</div><h2>${escapeHtml(heading)}</h2><p>${escapeHtml(message)}</p>${stack}</section>`;
      })
      .join('');
    return `<style>
    .__void-error-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      pointer-events: none;
      font-family: ${ERROR_PAGE_FONT_STACK};
      color: #f5f5f5;
    }
    .__void-error-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(10, 10, 10, 0.52);
      backdrop-filter: blur(4px);
      transition: opacity 180ms ease;
    }
    .__void-error-panel {
      position: absolute;
      inset: auto auto 24px 24px;
      inline-size: min(760px, calc(100vw - 48px));
      max-block-size: min(80dvh, 920px);
      overflow: auto;
      pointer-events: auto;
      border-radius: 32px;
      corner-shape: squircle;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: linear-gradient(180deg, rgba(24, 24, 27, 0.98), rgba(9, 9, 11, 0.98));
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
      padding: 12px 16px;
      transition: transform 180ms ease, opacity 180ms ease;
      transform-origin: bottom left;
    }
    .__void-error-close {
      position: absolute;
      inset: 12px 12px auto auto;
      inline-size: 36px;
      block-size: 36px;
      border: 0;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
      color: #fafafa;
      cursor: pointer;
      display: grid;
      place-items: center;
      padding: 0;
    }
    .__void-error-close:hover {
      background: rgba(255, 255, 255, 0.14);
    }
    .__void-error-close svg {
      inline-size: 16px;
      block-size: 16px;
      display: block;
    }
    .__void-error-minimized {
      position: absolute;
      inset: auto auto 24px 24px;
      pointer-events: none;
      opacity: 0;
      transform: scale(0.92);
      transform-origin: bottom left;
      border: 1px solid rgba(248, 113, 113, 0.35);
      border-radius: 32px;
      corner-shape: squircle;
      background: rgba(24, 24, 27, 0.96);
      color: #fca5a5;
      padding: 12px 8px;
      box-shadow: 0 18px 36px rgba(0, 0, 0, 0.28);
      cursor: pointer;
      font: 700 13px/1 ${ERROR_PAGE_FONT_STACK};
      letter-spacing: 0.04em;
      text-transform: uppercase;
      transition: transform 180ms ease, opacity 180ms ease;
    }
    .__void-error-header {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-block-end: 0;
      padding-right: 52px;
    }
    .__void-error-status {
      margin: 0;
      color: #fca5a5;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .__void-error-section {
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding-top: 16px;
      margin-top: 16px;
    }
    .__void-error-section.is-root {
      border-top: 0;
      padding-top: 0;
      margin-top: 0;
    }
    .__void-error-message {
      margin: 0;
      color: #fff;
      font-size: 1.7rem;
      line-height: 1.15;
      letter-spacing: -0.03em;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .__void-error-kicker {
      margin-bottom: 6px;
      color: #fda4af;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .__void-error-section h2 {
      margin: 0 0 8px;
      font-size: 1.05rem;
      color: #fff;
    }
    .__void-error-section p {
      margin: 0;
      color: #e4e4e7;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .__void-error-stack {
      margin-top: 18px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 32px;
      background: rgba(255, 255, 255, 0.03);
      corner-shape: squircle;
      overflow: hidden;
    }
    .__void-error-stack-label {
      padding: 12px 14px 10px;
      color: #f4f4f5;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .__void-error-frames {
      display: flex;
      flex-direction: column;
    }
    .__void-error-frame {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
      padding: 12px 14px;
      color: inherit;
      text-decoration: none;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
    }
    .__void-error-frame:first-child {
      border-top: 0;
    }
    .__void-error-frame:hover {
      background: rgba(255, 255, 255, 0.05);
    }
    .__void-error-frame.is-static {
      cursor: default;
    }
    .__void-error-frame-function {
      flex: 1 1 auto;
      min-width: 0;
      color: #fafafa;
      font: 600 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .__void-error-frame-location {
      flex: 0 1 52%;
      min-width: 0;
      color: #fda4af;
      font: 500 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      text-align: right;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .__void-error-section pre {
      margin: 0;
      padding: 12px 14px;
      overflow: auto;
      color: #e4e4e7;
      font: 500 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .__void-error-overlay.is-minimized .__void-error-backdrop {
      opacity: 0;
      pointer-events: none;
    }
    .__void-error-overlay.is-minimized .__void-error-panel {
      opacity: 0;
      pointer-events: none;
      transform: scale(0.92);
    }
    .__void-error-overlay.is-minimized .__void-error-minimized {
      opacity: 1;
      pointer-events: auto;
      transform: scale(1);
    }
    @media (max-width: 720px) {
      .__void-error-panel {
        inset: auto 12px 12px 12px;
        inline-size: auto;
        max-block-size: min(70dvh, 920px);
        padding: 16px;
      }
      .__void-error-minimized {
        inset: auto auto 12px 12px;
      }
      .__void-error-frame {
        flex-direction: column;
        align-items: flex-start;
      }
      .__void-error-frame-location {
        text-align: left;
      }
    }
  </style>
<aside class="__void-error-overlay" data-void-error-overlay role="dialog" aria-label="Void dev error overlay"><div class="__void-error-backdrop" data-void-error-backdrop></div><section class="__void-error-panel"><button type="button" class="__void-error-close" data-void-error-close aria-label="Minimize error overlay"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.757 3.757 12.243 12.243M12.243 3.757 3.757 12.243" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg></button><header class="__void-error-header"><p class="__void-error-status">${escapeHtml(String(status) + ': ' + title)}</p></header>${sections}</section><button type="button" class="__void-error-minimized" data-void-error-toggle aria-label="Show dev error overlay" aria-expanded="true">${escapeHtml(errorCountLabel)}</button><script>(function(){const script=document.currentScript;if(!(script instanceof HTMLScriptElement))return;const root=script.closest("[data-void-error-overlay]");if(!(root instanceof HTMLElement))return;const backdrop=root.querySelector("[data-void-error-backdrop]");const closeButton=root.querySelector("[data-void-error-close]");const toggle=root.querySelector("[data-void-error-toggle]");const setMinimized=(minimized)=>{root.classList.toggle("is-minimized", minimized);if(toggle instanceof HTMLElement)toggle.setAttribute("aria-expanded", minimized ? "false" : "true");};if(backdrop instanceof HTMLElement)backdrop.addEventListener("click",()=>setMinimized(true));if(closeButton instanceof HTMLElement)closeButton.addEventListener("click",()=>setMinimized(true));if(toggle instanceof HTMLElement)toggle.addEventListener("click",()=>setMinimized(false));})();</script></aside>`;
  }

  function injectDevErrorOverlay(html: string, overlay: string): string {
    return /<\/body\s*>/i.test(html)
      ? html.replace(/<\/body\s*>/i, overlay + '</body>')
      : html + overlay;
  }

  function getErrorAssetCss(error: unknown): string {
    const tags =
      error &&
      (typeof error === 'object' || typeof error === 'function') &&
      '__voidPageAssetTags' in error
        ? error.__voidPageAssetTags
        : null;
    return tags && typeof tags === 'object' && 'css' in tags && typeof tags.css === 'string'
      ? tags.css
      : '';
  }

  function injectErrorAssetCss(html: string, css: string): string {
    if (!css) {
      return html;
    }
    return /<\/head\s*>/i.test(html) ? html.replace(/<\/head\s*>/i, css + '</head>') : css + html;
  }

  function renderErrorPage(status: ErrorPageStatus, title: string, error?: unknown): string {
    const page = renderDefaultErrorPage(status);
    const html = injectErrorAssetCss(page, getErrorAssetCss(error));
    return dev && status === 500 && error
      ? injectDevErrorOverlay(html, renderDevErrorOverlay(status, title, error))
      : html;
  }

  function createErrorResponse(
    request: Request,
    status: ErrorPageStatus,
    title: string,
    error?: unknown,
  ): Response {
    if (!shouldServeHtmlErrorPage(request)) {
      return new Response(title, { status });
    }
    return new Response(request.method === 'HEAD' ? null : renderErrorPage(status, title, error), {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  async function serveCustomPage(
    c: Context,
    status: ErrorPageStatus,
    fallbackText: string,
    error?: unknown,
  ): Promise<Response> {
    try {
      const assets = c.env?.ASSETS;
      if (assets && typeof assets.fetch === 'function') {
        const request = new Request(new URL('/' + status + '.html', c.req.url));
        const response: Response = await assets.fetch(request);
        if (response.ok) {
          const assetCss = getErrorAssetCss(error);
          const showOverlay =
            dev && status === 500 && !!error && shouldServeHtmlErrorPage(c.req.raw);
          if (assetCss || showOverlay) {
            const html = injectErrorAssetCss(await response.text(), assetCss);
            const body = showOverlay
              ? injectDevErrorOverlay(html, renderDevErrorOverlay(status, fallbackText, error))
              : html;
            return new Response(c.req.method === 'HEAD' ? null : body, {
              status,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          return new Response(response.body, {
            status,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
      }
    } catch {
      /* Asset failure falls back to the built-in page. */
    }
    return createErrorResponse(c.req.raw, status, fallbackText, error);
  }
  return {
    createResponse: createErrorResponse,
    serveCustomPage,
    onError: (error, c) => {
      if (
        error &&
        typeof error === 'object' &&
        'getResponse' in error &&
        typeof error.getResponse === 'function'
      ) {
        return error.getResponse() as Response;
      }
      console.error(error);
      return serveCustomPage(c, 500, 'Internal Server Error', error);
    },
  };
}
