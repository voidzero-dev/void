import { describe, expect, it, vi } from 'vite-plus/test';
import { Buffer } from '../../src/cli/node-buffer.ts';
import {
  appendInlineQuery,
  DEV_CSS_ASSET_ENDPOINT,
  DEV_CSS_ASSET_MODULE_ID,
  extractInlineCss,
  normalizeDevCssUrl,
  pagesDevCssAssetsPlugin,
} from '../../src/pages/dev-css-assets.ts';

type Middleware = (
  req: {
    headers: Record<string, string | undefined>;
    method?: string;
    url?: string;
  },
  res: {
    end(chunk?: string): void;
    setHeader(name: string, value: string): void;
    statusCode: number;
  },
  next: () => void,
) => void | Promise<void>;

function createMiddleware(): Middleware {
  let middleware: Middleware | undefined;
  const [plugin] = pagesDevCssAssetsPlugin('/root', 'secret');
  const configureServer = plugin.configureServer as (server: unknown) => void;
  configureServer({
    config: { logger: { warn() {}, warnOnce() {} } },
    environments: { client: {} },
    middlewares: {
      use(fn: Middleware) {
        middleware = fn;
      },
    },
    watcher: { on() {} },
  });
  if (!middleware) {
    throw new Error('Expected middleware to be registered.');
  }
  return middleware;
}

function createConfiguredPlugin(address = '::', resolvedLocalUrl?: string) {
  const [plugin] = pagesDevCssAssetsPlugin('/root', 'secret');
  const configureServer = plugin.configureServer as (server: unknown) => void;
  configureServer({
    config: {
      logger: { warn() {}, warnOnce() {} },
      server: {},
    },
    environments: { client: {} },
    httpServer: {
      address: () => ({ address, port: 6199 }),
    },
    middlewares: {
      use() {},
    },
    resolvedUrls: resolvedLocalUrl ? { local: [resolvedLocalUrl] } : undefined,
    watcher: { on() {} },
  });
  return plugin;
}

function loadDevAssetModule(plugin: ReturnType<typeof createConfiguredPlugin>): string {
  const load = plugin.load as (this: unknown, id: string) => string;
  return load.call({}, `\0${DEV_CSS_ASSET_MODULE_ID}`);
}

type DevAssetModule = {
  getVoidPagesDevCss(
    request: Request,
    env: { ASSETS?: { fetch(request: Request): Promise<Response> } },
    payload: unknown,
  ): Promise<Array<{ css: string; id: string; url: string }>>;
};

async function importDevAssetModule(
  plugin: ReturnType<typeof createConfiguredPlugin>,
): Promise<DevAssetModule> {
  const code = loadDevAssetModule(plugin);
  const encoded = Buffer.from(`${code}\n//# sourceURL=void-pages-dev-assets-test.mjs`).toString(
    'base64',
  );
  return import(`data:text/javascript;base64,${encoded}`) as Promise<DevAssetModule>;
}

function createResponse() {
  return {
    body: '',
    headers: new Map<string, string>(),
    statusCode: 200,
    end(chunk = '') {
      this.body += chunk;
    },
    setHeader(name: string, value: string) {
      this.headers.set(name.toLowerCase(), value);
    },
  };
}

async function postCollector(
  middleware: Middleware,
  body: unknown,
): Promise<ReturnType<typeof createResponse>> {
  const response = createResponse();
  const payload = Buffer.from(JSON.stringify(body));
  await middleware(
    {
      async *[Symbol.asyncIterator]() {
        yield payload;
      },
      headers: {
        authorization: 'Bearer secret',
        'x-void-dev-asset-request': 'pages-css',
      },
      method: 'POST',
      url: DEV_CSS_ASSET_ENDPOINT,
    } as never,
    response,
    () => {
      throw new Error('Unexpected next() call.');
    },
  );
  return response;
}

function createCollector({
  nodes,
  transforms,
  resolve,
}: {
  nodes: Map<string, { id: string; url: string }>;
  transforms: Record<string, string>;
  resolve: (specifier: string) => Promise<{ id: string } | undefined>;
}) {
  let middleware: Middleware | undefined;
  const transformCalls: Array<string> = [];
  const [assetPlugin, edgePlugin] = pagesDevCssAssetsPlugin('/root', 'secret');
  const configureServer = assetPlugin.configureServer as (server: unknown) => void;
  configureServer({
    config: { logger: { warn() {}, warnOnce() {} }, server: {} },
    environments: {
      client: {
        moduleGraph: {
          getModuleByUrl: async (url: string) => nodes.get(url),
        },
        transformRequest: async (url: string) => {
          transformCalls.push(url);
          return { code: transforms[url] ?? '' };
        },
      },
    },
    middlewares: {
      use(fn: Middleware) {
        middleware = fn;
      },
    },
    watcher: { on() {} },
  });
  const transform = edgePlugin.transform as (
    this: unknown,
    code: string,
    id: string,
  ) => Promise<void>;
  return {
    transformCalls,
    transform: (code: string, id: string) =>
      transform.call({ environment: { name: 'client' }, resolve }, code, id),
    async collect(rootPhases: Array<Array<string>>): Promise<{ assets: unknown }> {
      const response = await postCollector(middleware!, { rootPhases });
      return JSON.parse(response.body) as { assets: unknown };
    },
  };
}

describe('pages dev CSS assets', () => {
  it('resolves transformed component imports and re-exports in source order', async () => {
    const [, plugin] = pagesDevCssAssetsPlugin('/root', 'secret');
    const transform = plugin.transform as (
      this: unknown,
      code: string,
      id: string,
    ) => Promise<void>;
    const resolve = vi.fn(async (source: string) => ({ id: `/root/${source}` }));
    await transform.call(
      { environment: { name: 'client' }, resolve },
      `import './first.css';
       export * from './second.js';
       import('./lazy.css');
       export { value } from './third.js';
       export {} from './fourth.js';
       import './last.css';`,
      '/root/page.vue?vue&type=script&lang.ts',
    );
    expect(resolve.mock.calls.map(([source]) => source)).toEqual([
      './first.css',
      './second.js',
      './third.js',
      './fourth.js',
      './last.css',
    ]);
  });

  it('preserves existing Vite client URLs during normalization', () => {
    expect(normalizeDevCssUrl('/@fs/Users/me/app/src/page.css', '/Users/me/app')).toBe(
      '/@fs/Users/me/app/src/page.css',
    );
    expect(normalizeDevCssUrl('/src/page.css?used', '/Users/me/app')).toBe('/src/page.css?used');
    expect(normalizeDevCssUrl('/pages/index.vue', '/Users/me/app')).toBe('/pages/index.vue');
    expect(normalizeDevCssUrl('/@vite/client', '/Users/me/app')).toBe('/@vite/client');
    expect(normalizeDevCssUrl('/@react-refresh', '/Users/me/app')).toBe('/@react-refresh');
  });

  it('normalizes filesystem ids under the project root to Vite root URLs', () => {
    expect(normalizeDevCssUrl('/Users/me/app/src/page.css', '/Users/me/app')).toBe('/src/page.css');
    expect(normalizeDevCssUrl('/Users/me/shared/page.css', '/Users/me/app')).toBe(
      '/@fs/Users/me/shared/page.css',
    );
  });

  it('appends inline without dropping existing query or hash', () => {
    expect(appendInlineQuery('/src/page.vue?vue&type=style&index=0.css#x')).toBe(
      '/src/page.vue?vue=&type=style&index=0.css&inline=#x',
    );
  });

  it('does not duplicate inline query', () => {
    expect(appendInlineQuery('/src/app.css?inline')).toBe('/src/app.css?inline');
  });

  it('extracts Vite inline CSS default exports', () => {
    expect(extractInlineCss('export default ".button{color:red}"')).toBe('.button{color:red}');
  });

  it('extracts Vite __vite__css assignments', () => {
    expect(
      extractInlineCss('const __vite__css = "body{margin:0}"\nexport default __vite__css'),
    ).toBe('body{margin:0}');
  });

  it('ignores CSS and style IDs mentioned only in comments or other strings', () => {
    const code = `// export default "wrong"
const note = "__vite__css = 'wrong'";
const __vite__id = "/root/real.css";
const __vite__css = ".real{}";
export default __vite__css;`;
    expect(extractInlineCss(code)).toBe('.real{}');
  });

  it('reads escaped CSS from JavaScript string literals', () => {
    expect(extractInlineCss(`export default '.quote{content:"it\\'s"}'`)).toBe(
      '.quote{content:"it\'s"}',
    );
  });

  it('rejects arbitrary inline CSS JavaScript', () => {
    expect(() => extractInlineCss('export default getCss()')).toThrow(/Unable to extract/);
  });

  it('rejects the token-bearing virtual module in the client environment', () => {
    const [plugin] = pagesDevCssAssetsPlugin('/root', 'secret');
    const resolveId = plugin.resolveId as (
      this: unknown,
      source: string,
      importer?: string,
      options?: unknown,
    ) => unknown;

    expect(() =>
      resolveId.call(
        { environment: { name: 'client' } },
        DEV_CSS_ASSET_MODULE_ID,
        undefined,
        {} as never,
      ),
    ).toThrow('server-only');
  });

  it('blocks direct client requests for the token-bearing virtual module', async () => {
    const middleware = createMiddleware();
    const response = createResponse();

    await middleware(
      { headers: {}, method: 'GET', url: `/@id/__x00__${DEV_CSS_ASSET_MODULE_ID}` },
      response,
      () => {
        throw new Error('Unexpected next() call.');
      },
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe('Not Found');
  });

  it('rejects dev asset endpoint requests with an invalid bearer token', async () => {
    const middleware = createMiddleware();
    const response = createResponse();

    await middleware(
      {
        headers: {
          authorization: 'Bearer wrong',
          'x-void-dev-asset-request': 'pages-css',
        },
        method: 'POST',
        url: DEV_CSS_ASSET_ENDPOINT,
      },
      response,
      () => {
        throw new Error('Unexpected next() call.');
      },
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toBe('Unauthorized');
  });

  it('uses the internal Vite origin before the ASSETS binding in dev', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const originalFetch = globalThis.fetch;
    const plugin = createConfiguredPlugin();
    const mod = await importDevAssetModule(plugin);
    const expectedAssets = [{ url: '/src/page.css', id: '/root/src/page.css', css: '.page{}' }];
    const assetsFetch = vi.fn(async () => {
      throw new Error('ASSETS should not handle the dev CSS endpoint when internal fetch works.');
    });
    const globalFetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe('http://127.0.0.1:6199/__void/dev/pages-css');
      expect(request.signal.aborted).toBe(false);
      return Response.json({ assets: expectedAssets });
    });
    globalThis.fetch = globalFetch as typeof fetch;

    try {
      const resultPromise = mod.getVoidPagesDevCss(
        new Request('https://app.local/dashboard'),
        {
          ASSETS: { fetch: assetsFetch },
        },
        { kind: 'pages', componentId: '/dashboard', rootPhases: [['/src/page.ts']] },
      );

      await expect(resultPromise).resolves.toEqual(expectedAssets);
      expect(globalFetch).toHaveBeenCalledTimes(1);
      expect(assetsFetch).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      warn.mockRestore();
    }
  });

  it('falls back when the internal endpoint returns malformed CSS assets', async () => {
    const mod = await importDevAssetModule(createConfiguredPlugin());
    const assets = [{ url: '/src/page.css', css: '.page{}' }];
    const fallbackFetch = vi.fn(async () => Response.json({ assets }));
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ assets: [{ url: '/src/page.css', css: null }] }));

    try {
      await expect(
        mod.getVoidPagesDevCss(
          new Request('https://app.local/dashboard'),
          { ASSETS: { fetch: fallbackFetch } },
          { kind: 'pages', componentId: '/dashboard', rootPhases: [['/src/page.ts']] },
        ),
      ).resolves.toEqual(assets);
      expect(fallbackFetch).toHaveBeenCalledOnce();
    } finally {
      fetch.mockRestore();
    }
  });

  it('uses a fresh abort signal for fallback attempts', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const originalFetch = globalThis.fetch;
    const plugin = createConfiguredPlugin();
    const mod = await importDevAssetModule(plugin);
    const expectedAssets = [{ url: '/src/page.css', id: '/root/src/page.css', css: '.page{}' }];
    const globalFetch = vi.fn(
      (request: Request) =>
        new Promise<Response>((_, reject) => {
          request.signal.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const assetsFetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe('https://app.local/__void/dev/pages-css');
      expect(request.signal.aborted).toBe(false);
      return Response.json({ assets: expectedAssets });
    });
    globalThis.fetch = globalFetch as typeof fetch;

    try {
      const resultPromise = mod.getVoidPagesDevCss(
        new Request('https://app.local/dashboard'),
        { ASSETS: { fetch: assetsFetch } },
        { kind: 'pages', componentId: '/dashboard', rootPhases: [['/src/page.ts']] },
      );

      await vi.advanceTimersByTimeAsync(1500);

      await expect(resultPromise).resolves.toEqual(expectedAssets);
      expect(globalFetch).toHaveBeenCalledTimes(1);
      expect(assetsFetch).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('prefers concrete bound IPv6 loopback over ambiguous localhost display URLs', () => {
    const plugin = createConfiguredPlugin('::1', 'http://localhost:6199/');
    const code = loadDevAssetModule(plugin);

    expect(code).toContain('const INTERNAL_ORIGIN = "http://[::1]:6199"');
    expect(code).not.toContain('const INTERNAL_ORIGIN = "http://localhost:6199"');
  });

  it('collects CSS through ordered static edges and ignores dynamic imports', async () => {
    const collector = createCollector({
      nodes: new Map([
        ['/src/page.ts', { id: '/root/src/page.ts', url: '/src/page.ts' }],
        ['/src/component.ts', { id: '/root/src/component.ts', url: '/src/component.ts' }],
        ['/src/static.css', { id: '/root/wrong.css', url: '/src/static.css' }],
        ['/src/dynamic.css', { id: '/root/src/dynamic.css', url: '/src/dynamic.css' }],
      ]),
      transforms: {
        '/src/static.css':
          '// const __vite__id = "/root/comment.css"\n' +
          `const note = '__vite__id = "/root/string.css"';\n` +
          'const __vite__id = "/root/src/static.css"\nconst __vite__css = ".static{}"',
        '/src/static.css?inline=': 'export default ".static{}"',
        '/src/dynamic.css':
          'const __vite__id = "/root/src/dynamic.css"\nconst __vite__css = ".dynamic{}"',
        '/src/dynamic.css?inline=': 'export default ".dynamic{}"',
      },
      resolve: async (specifier) => {
        if (specifier === './component.ts') {
          return { id: '/root/src/component.ts' };
        }
        if (specifier === './static.css') {
          return { id: '/root/src/static.css' };
        }
        if (specifier === './dynamic.css') {
          return { id: '/root/src/dynamic.css' };
        }
      },
    });

    await collector.transform(
      'import "./component.ts"; import("./dynamic.css");',
      '/root/src/page.ts',
    );
    await collector.transform('import "./static.css";', '/root/src/component.ts');

    const body = await collector.collect([['/src/page.ts']]);

    expect(body.assets).toEqual([
      { url: '/src/static.css', id: '/root/src/static.css', css: '.static{}' },
    ]);
    expect(collector.transformCalls).not.toContain('/src/dynamic.css');
  });

  it('uses Svelte style transform CSS without appending inline', async () => {
    const styleUrl = '/src/page.svelte?svelte&type=style&lang.css';
    const collector = createCollector({
      nodes: new Map([
        ['/src/page.ts', { id: '/root/src/page.ts', url: '/src/page.ts' }],
        [styleUrl, { id: `/root${styleUrl}`, url: styleUrl }],
      ]),
      transforms: {
        [styleUrl]:
          'const __vite__id = "/root/src/page.svelte?svelte&type=style&lang.css"\n' +
          'const __vite__css = ".svelte-page{color:red}"',
        [`${styleUrl}&inline=`]: 'export default function Component() {}',
      },
      resolve: async () => ({ id: `/root${styleUrl}` }),
    });

    await collector.transform(
      'import "./page.svelte?svelte&type=style&lang.css";',
      '/root/src/page.ts',
    );

    const body = await collector.collect([['/src/page.ts']]);

    expect(body.assets).toEqual([
      {
        url: styleUrl,
        id: '/root/src/page.svelte?svelte&type=style&lang.css',
        css: '.svelte-page{color:red}',
      },
    ]);
    expect(collector.transformCalls).not.toContain(`${styleUrl}&inline=`);
  });

  it('unwraps virtual /@id roots before transforming them', async () => {
    const collector = createCollector({
      nodes: new Map([
        [
          '/@id/__x00__virtual:void-pages-client',
          { id: '\0virtual:void-pages-client', url: '/@id/__x00__virtual:void-pages-client' },
        ],
        ['/src/page.css', { id: '/root/src/page.css', url: '/src/page.css' }],
      ]),
      transforms: { '/src/page.css?inline=': 'export default ".page{}"' },
      resolve: async () => ({ id: '/root/src/page.css' }),
    });

    await collector.transform('import "./page.css";', '\0virtual:void-pages-client');

    const body = await collector.collect([['/@id/__x00__virtual:void-pages-client']]);

    expect(collector.transformCalls[0]).toBe('\0virtual:void-pages-client');
    expect(body.assets).toEqual([
      { url: '/src/page.css', id: '/root/src/page.css', css: '.page{}' },
    ]);
  });

  it('skips optimized deps and continues collecting route CSS', async () => {
    const collector = createCollector({
      nodes: new Map([
        ['/src/page.ts', { id: '/root/src/page.ts', url: '/src/page.ts' }],
        ['/src/page.css', { id: '/root/src/page.css', url: '/src/page.css' }],
      ]),
      transforms: { '/src/page.css?inline=': 'export default ".page{}"' },
      resolve: async (specifier) => {
        if (specifier === './page.css') {
          return { id: '/root/src/page.css' };
        }
        return { id: '/node_modules/.vite/deps/react.js?v=123' };
      },
    });

    await collector.transform('import "react"; import "./page.css";', '/root/src/page.ts');

    const body = await collector.collect([['/src/page.ts']]);

    expect(collector.transformCalls).not.toContain('/node_modules/.vite/deps/react.js?v=123');
    expect(body.assets).toEqual([
      { url: '/src/page.css', id: '/root/src/page.css', css: '.page{}' },
    ]);
  });
});
