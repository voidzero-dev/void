import { normalizePath, parseSync } from 'vite';
import type { EnvironmentModuleNode, Plugin, ViteDevServer } from 'vite';
import { Buffer } from '../cli/node-buffer.ts';
import { staticModuleReferences } from '../shared/module-references.ts';
import type { DevCssAsset } from './types.ts';

export const DEV_CSS_ASSET_MODULE_ID = 'virtual:void-pages-dev-assets';
export const DEV_CSS_ASSET_ENDPOINT = '/__void/dev/pages-css';
const DEV_CSS_ASSET_GUARD_HEADER = 'X-Void-Dev-Asset-Request';
const DEV_CSS_ASSET_GUARD_VALUE = 'pages-css';

type DevCssRootPhases = Array<Array<string>>;

type DevCssRequestBody = {
  rootPhases?: DevCssRootPhases;
};

type OrderedEdgeStore = {
  version: number;
  set(importer: string, edges: Array<string>): void;
  getForNode(node: EnvironmentModuleNode): Array<string> | undefined;
};

const CSS_REQUEST_RE = /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)(?:$|[?#])/;
const STYLE_QUERY_RE = /[?&](?:vue|svelte|island-style)\b.*[?&]type=style\b|[?&]type=style\b/;
const CSS_BYPASS_RE = /[?&](?:raw|url|worker|sharedworker)\b/;
const SKIPPABLE_VIRTUAL_URL_RE =
  /^(?:\/@id\/__x00__)?virtual:void-client-(?:browser|worker)(?:$|[?#])/;

function splitQueryHash(value: string) {
  const index = value.search(/[?#]/);
  if (index === -1) {
    return { pathname: value, suffix: '' };
  }
  return { pathname: value.slice(0, index), suffix: value.slice(index) };
}

export function normalizeDevCssUrl(id: string, root: string): string {
  const normalized = normalizePath(id);
  if (normalized.startsWith('/@id/')) {
    return normalized;
  }
  if (normalized.startsWith('\0')) {
    return '/@id/__x00__' + normalized.slice(1);
  }
  if (normalized.startsWith('virtual:')) {
    return '/@id/__x00__' + normalized;
  }
  const { pathname, suffix } = splitQueryHash(normalized);
  const normalizedRoot = normalizePath(root);
  if (pathname === normalizedRoot || pathname.startsWith(normalizedRoot + '/')) {
    return '/' + normalizePath(pathname.slice(normalizedRoot.length + 1)) + suffix;
  }
  if (
    pathname.startsWith('/@fs/') ||
    pathname.startsWith('/@vite/') ||
    pathname.startsWith('/@react-refresh') ||
    pathname.startsWith('/node_modules/.vite/')
  ) {
    return normalized;
  }
  if (pathname.startsWith('/')) {
    const rootFirstSegment = normalizedRoot.split('/').filter(Boolean)[0];
    if (rootFirstSegment && !pathname.startsWith(`/${rootFirstSegment}/`)) {
      return normalized;
    }
    return '/@fs' + pathname + suffix;
  }
  return normalized;
}

function normalizeRequestUrl(url: string): string {
  return normalizePath(url).replace(/^\/@id\/__x00__/, '\0');
}

function isCssRequest(url: string): boolean {
  return !CSS_BYPASS_RE.test(url) && (CSS_REQUEST_RE.test(url) || STYLE_QUERY_RE.test(url));
}

function isOptimizedDepUrl(url: string): boolean {
  return normalizePath(url).startsWith('/node_modules/.vite/deps/');
}

function isSkippableVirtualUrl(url: string): boolean {
  const normalized = normalizePath(url);
  return (
    SKIPPABLE_VIRTUAL_URL_RE.test(normalized) ||
    (normalized.charCodeAt(0) === 0 &&
      /^virtual:void-client-(?:browser|worker)(?:$|[?#])/.test(normalized.slice(1)))
  );
}

export function appendInlineQuery(url: string): string {
  const parsed = new URL(url, 'http://void.local');
  if (!parsed.searchParams.has('inline')) {
    parsed.searchParams.append('inline', '');
  }
  return parsed.pathname + parsed.search + parsed.hash;
}

type CssOutputNode = {
  type: string;
  name?: string;
  value?: unknown;
  body?: Array<CssOutputNode>;
  declaration?: CssOutputNode;
  declarations?: Array<CssOutputNode>;
  id?: CssOutputNode;
  init?: CssOutputNode;
  expression?: CssOutputNode;
  left?: CssOutputNode;
  right?: CssOutputNode;
  kind?: string;
};

type CompiledCssOutput = { css?: string; id?: string; templateCss?: boolean };

function parseCssOutput(code: string): CompiledCssOutput {
  const program = parseSync('void-dev-css.js', code).program as CssOutputNode;
  const result: CompiledCssOutput = {};
  const readCss = (node: CssOutputNode | undefined): void => {
    if (node?.type === 'Literal' && typeof node.value === 'string') {
      result.css = node.value;
    } else if (node?.type === 'TemplateLiteral') {
      result.templateCss = true;
    }
  };
  for (const statement of program.body ?? []) {
    if (statement.type === 'ExportDefaultDeclaration') {
      readCss(statement.declaration);
    } else if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations ?? []) {
        if (declaration.id?.name === '__vite__css') {
          readCss(declaration.init);
        } else if (
          statement.kind === 'const' &&
          declaration.id?.name === '__vite__id' &&
          declaration.init?.type === 'Literal' &&
          typeof declaration.init.value === 'string'
        ) {
          result.id = declaration.init.value;
        }
      }
    } else if (
      statement.type === 'ExpressionStatement' &&
      statement.expression?.type === 'AssignmentExpression' &&
      statement.expression.left?.name === '__vite__css'
    ) {
      readCss(statement.expression.right);
    }
  }
  return result;
}

export function extractInlineCss(code: string): string {
  const result = parseCssOutput(code);
  if (result.templateCss) {
    throw new Error('Unexpected template literal inline CSS output.');
  }
  if (result.css === undefined) {
    throw new Error('Unable to extract inline CSS from Vite transform output.');
  }
  return result.css;
}

function createOrderedEdgeStore(root: string): OrderedEdgeStore {
  let version = 0;
  const byKey = new Map<string, Array<string>>();

  const aliasesForId = (id: string): Array<string> => {
    const normalized = normalizePath(id);
    const aliases = new Set<string>([normalized, normalizeDevCssUrl(normalized, root)]);
    if (normalized.startsWith('/@id/__x00__')) {
      aliases.add(normalized.replace('/@id/__x00__', '\0'));
    }
    return [...aliases];
  };

  return {
    get version() {
      return version;
    },
    set(importer, edges) {
      version++;
      for (const key of aliasesForId(importer)) {
        byKey.set(key, edges);
      }
    },
    getForNode(node) {
      const keys = [node.url, node.id].filter(
        (value): value is string => typeof value === 'string',
      );
      for (const key of keys) {
        const direct = byKey.get(normalizePath(key));
        if (direct) {
          return direct;
        }
        const url = normalizeDevCssUrl(key, root);
        const byUrl = byKey.get(url) ?? byKey.get(normalizeRequestUrl(url));
        if (byUrl) {
          return byUrl;
        }
      }

      const staticUrls = (node as EnvironmentModuleNode & { staticImportedUrls?: Set<string> })
        .staticImportedUrls;
      return staticUrls ? [...staticUrls] : undefined;
    },
  };
}

class DevCssProvider {
  private readonly cache = new Map<string, Array<DevCssAsset>>();
  private graphVersion = 0;

  constructor(
    private server: ViteDevServer,
    private root: string,
    private edgeStore: OrderedEdgeStore,
  ) {}

  invalidate(): void {
    this.graphVersion++;
    this.cache.clear();
  }

  async collect(rootPhases: DevCssRootPhases): Promise<Array<DevCssAsset>> {
    const normalizedPhases = rootPhases.map((phase) =>
      phase.map((root) => normalizeDevCssUrl(root, this.root)),
    );
    const cacheKey = JSON.stringify({
      roots: normalizedPhases,
      graphVersion: this.graphVersion,
      edgeVersion: this.edgeStore.version,
    });
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const environment = this.server.environments.client;
    const graph = environment.moduleGraph;
    const seen = new Set<EnvironmentModuleNode>();
    const seenCssUrls = new Set<string>();
    const cssUrls: Array<string> = [];
    const cssViteDevIds = new Map<string, string>();
    const transformedCss = new Map<string, string>();

    const addByUrl = async (rawUrl: string): Promise<void> => {
      const url = normalizeDevCssUrl(rawUrl, this.root);
      if (isOptimizedDepUrl(url)) {
        return;
      }
      const requestUrl = normalizeRequestUrl(url);
      let result: { code: string } | null | undefined;
      try {
        result = await environment.transformRequest(requestUrl);
      } catch (error) {
        if (!isSkippableVirtualUrl(url)) {
          this.server.config.logger.warnOnce(
            `[void] Skipping dev CSS traversal for ${url}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return;
      }
      const node =
        (await graph.getModuleByUrl(url)) ??
        (requestUrl !== url ? await graph.getModuleByUrl(requestUrl) : undefined);
      if (node) {
        await visit(node, result?.code);
      }
    };

    const visit = async (node: EnvironmentModuleNode, transformedCode?: string): Promise<void> => {
      if (seen.has(node)) {
        return;
      }
      seen.add(node);

      if (isCssRequest(node.url)) {
        if (!seenCssUrls.has(node.url)) {
          seenCssUrls.add(node.url);
          cssUrls.push(node.url);
        }
        if (transformedCode) {
          let output: ReturnType<typeof parseCssOutput> | undefined;
          try {
            output = parseCssOutput(transformedCode);
          } catch {
            // Some CSS-like modules only become extractable with ?inline.
          }
          cssViteDevIds.set(node.url, output?.id ?? node.id ?? node.url);
          if (output?.css !== undefined && !output.templateCss) {
            transformedCss.set(node.url, output.css);
          }
        } else {
          cssViteDevIds.set(node.url, node.id ?? node.url);
        }
        return;
      }

      if (isOptimizedDepUrl(node.url)) {
        return;
      }

      const staticUrls = this.edgeStore.getForNode(node);
      if (!staticUrls) {
        this.server.config.logger.warnOnce(
          `[void] Missing ordered static import metadata for ${node.url}; skipping broad dev CSS traversal.`,
        );
        return;
      }

      for (const dep of staticUrls) {
        await addByUrl(dep);
      }
    };

    for (const roots of normalizedPhases) {
      for (const root of roots) {
        await addByUrl(root);
      }
    }

    const assets: Array<DevCssAsset> = [];
    for (const url of cssUrls) {
      const existingCss = transformedCss.get(url);
      if (existingCss !== undefined) {
        assets.push({ url, id: cssViteDevIds.get(url) ?? url, css: existingCss });
        continue;
      }
      try {
        const result = await environment.transformRequest(appendInlineQuery(url));
        if (!result) {
          continue;
        }
        assets.push({
          url,
          id: cssViteDevIds.get(url) ?? url,
          css: extractInlineCss(result.code),
        });
      } catch (error) {
        this.server.config.logger.warnOnce(
          `[void] Skipping dev CSS asset for ${url}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.cache.set(cacheKey, assets);
    if (this.cache.size > 100) {
      const oldest = this.cache.keys().next().value;
      if (oldest) {
        this.cache.delete(oldest);
      }
    }
    return assets;
  }
}

async function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Array<Buffer> = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function getInternalDevOrigin(server: ViteDevServer): string {
  const address = server.httpServer?.address();
  if (address && typeof address === 'object') {
    const protocol = server.config.server.https ? 'https' : 'http';
    const rawHost =
      address.address === '::' || address.address === '0.0.0.0' ? '127.0.0.1' : address.address;
    const host = rawHost.includes(':') ? `[${rawHost}]` : rawHost;
    return `${protocol}://${host}:${address.port}`;
  }

  const localUrl = server.resolvedUrls?.local[0];
  if (localUrl) {
    return new URL(localUrl).origin;
  }

  const protocol = server.config.server.https ? 'https' : 'http';
  return `${protocol}://127.0.0.1:${server.config.server.port ?? 5173}`;
}

export function pagesDevCssAssetsPlugin(root: string, token: string): Array<Plugin> {
  const edgeStore = createOrderedEdgeStore(root);
  let provider: DevCssProvider | null = null;
  let viteServer: ViteDevServer | null = null;

  return [
    {
      name: 'void:pages-dev-css-assets',
      apply: 'serve',

      resolveId(id) {
        if (id !== DEV_CSS_ASSET_MODULE_ID) {
          return;
        }
        if (this.environment?.name === 'client') {
          throw new Error(
            `${DEV_CSS_ASSET_MODULE_ID} is server-only and cannot be imported by client code.`,
          );
        }
        return '\0' + DEV_CSS_ASSET_MODULE_ID;
      },

      load(id) {
        if (id !== '\0' + DEV_CSS_ASSET_MODULE_ID) {
          return;
        }
        if (this.environment?.name === 'client') {
          throw new Error(
            `${DEV_CSS_ASSET_MODULE_ID} is server-only and cannot be loaded by client code.`,
          );
        }
        const internalOrigin = viteServer
          ? getInternalDevOrigin(viteServer)
          : 'http://127.0.0.1:5173';
        return `
const TOKEN = ${JSON.stringify(token)};
const INTERNAL_ORIGIN = ${JSON.stringify(internalOrigin)};
const ENDPOINT = ${JSON.stringify(DEV_CSS_ASSET_ENDPOINT)};
const GUARD_HEADER = ${JSON.stringify(DEV_CSS_ASSET_GUARD_HEADER)};
const GUARD_VALUE = ${JSON.stringify(DEV_CSS_ASSET_GUARD_VALUE)};

function createDevCssRequest(url, payload, signal) {
  return new Request(url, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + TOKEN,
      "Content-Type": "application/json",
      [GUARD_HEADER]: GUARD_VALUE,
    },
    body: JSON.stringify(payload),
    signal,
  });
}

async function readDevCssResponse(response) {
  if (!response.ok) {
    throw new Error("HTTP " + response.status);
  }
  const body = await response.json();
  return Array.isArray(body.assets) ? body.assets : [];
}

export async function getVoidPagesDevCss(request, env, payload) {
  const attempts = [];
  attempts.push({
    fetcher: "global",
    label: INTERNAL_ORIGIN,
    url: new URL(ENDPOINT, INTERNAL_ORIGIN).toString(),
  });
  if (env?.ASSETS && typeof env.ASSETS.fetch === "function") {
    attempts.push({
      fetcher: env.ASSETS,
      label: "ASSETS",
      url: new URL(ENDPOINT, request.url).toString(),
    });
  }
  try {
    let lastError;
    let lastLabel = "unknown";
    for (const attempt of attempts) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      try {
        const request = createDevCssRequest(attempt.url, payload, controller.signal);
        const response =
          attempt.fetcher === "global"
            ? await fetch(request)
            : await attempt.fetcher.fetch(request);
        return await readDevCssResponse(response);
      } catch (error) {
        lastError = error;
        lastLabel = attempt.label;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error(
      lastLabel + ": " + (lastError instanceof Error ? lastError.message : String(lastError)),
    );
  } catch (error) {
    console.warn("[void] dev CSS collection failed:", error instanceof Error ? error.message : String(error));
    return [];
  }
}
`;
      },

      configureServer(server) {
        viteServer = server;
        provider = new DevCssProvider(server, root, edgeStore);
        const invalidate = () => provider?.invalidate();
        server.watcher.on('add', invalidate);
        server.watcher.on('change', invalidate);
        server.watcher.on('unlink', invalidate);

        server.middlewares.use(async (req, res, next) => {
          if (!req.url) {
            return next();
          }
          const url = new URL(req.url, 'http://void.local');
          if (
            url.pathname === '/@id/' + DEV_CSS_ASSET_MODULE_ID ||
            url.pathname === '/@id/__x00__' + DEV_CSS_ASSET_MODULE_ID
          ) {
            res.statusCode = 404;
            res.end('Not Found');
            return;
          }
          if (url.pathname !== DEV_CSS_ASSET_ENDPOINT) {
            return next();
          }
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end('Method Not Allowed');
            return;
          }
          if (req.headers[DEV_CSS_ASSET_GUARD_HEADER.toLowerCase()] !== DEV_CSS_ASSET_GUARD_VALUE) {
            res.statusCode = 403;
            res.end('Forbidden');
            return;
          }
          const auth = req.headers.authorization;
          if (auth !== `Bearer ${token}`) {
            res.statusCode = 401;
            res.end('Unauthorized');
            return;
          }
          try {
            const body = (await readJsonBody(req)) as DevCssRequestBody;
            const rootPhases = Array.isArray(body.rootPhases) ? body.rootPhases : [];
            const assets = await provider!.collect(rootPhases);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ assets }));
          } catch (error) {
            server.config.logger.warn(
              `[void] dev CSS collection failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ assets: [] }));
          }
        });
      },
    },
    {
      name: 'void:pages-dev-css-static-edges',
      apply: 'serve',
      enforce: 'post',

      async transform(code, id) {
        if (this.environment?.name !== 'client') {
          return;
        }
        if (id.includes('/node_modules/.vite/')) {
          return;
        }
        let parsed: ReturnType<typeof parseSync>;
        try {
          // Client transforms have already compiled TS, JSX, and framework components.
          parsed = parseSync(id, code, { lang: 'js' });
          if (parsed.errors.length > 0) {
            return;
          }
        } catch {
          return;
        }
        const edges: Array<string> = [];
        for (const { source } of staticModuleReferences(parsed, code)) {
          const resolved = await this.resolve(source, id, { skipSelf: true });
          if (resolved?.id) {
            edges.push(normalizeDevCssUrl(resolved.id, root));
          }
        }
        edgeStore.set(id, edges);
        return;
      },
    },
  ];
}
