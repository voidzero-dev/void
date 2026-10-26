import type { RouteEnvironment } from '../router/parse-filename.ts';

export type ExplicitBoolean = true | false | undefined;

export type SsrMode = 'auto' | 'server' | 'client';

export type PrerenderMode = 'auto' | 'force' | 'disabled';

export type PageRenderMode = 'server' | 'client' | 'island';

export type PageDefinition = {
  /** URL pattern, e.g. "/users/:id" */
  pattern: string;
  /** Route params, e.g. ["id"] */
  params: Array<string>;
  /** Whether this is a catch-all route */
  catchAll: boolean;
  /** Component file relative path, e.g. "users/[id].vue" */
  componentPath: string;
  /** Server handler file relative path, e.g. "users/[id].server.ts" */
  serverPath: string | null;
  /** HTTP methods exported by server handler */
  methods: Array<string>;
  /** Component ID used in page object, e.g. "users/[id]" */
  componentId: string;
  /** Edge caching revalidate TTL in seconds, from .server.ts export */
  revalidate?: number;
  /** Whether `export const prerender = true/false` is set in server handler */
  prerender?: ExplicitBoolean;
  /** Whether `export const ssr = true/false` is set in server handler */
  ssr?: ExplicitBoolean;
  /** Normalized SSR mode from the public `ssr` export */
  ssrMode: SsrMode;
  /** Normalized prerender mode from the public `prerender` export */
  prerenderMode: PrerenderMode;
  /** Normalized page render mode */
  renderMode: PageRenderMode;
  /** Whether this page should participate in prerender collection */
  shouldPrerender: boolean;
  /** Whether `export function getPrerenderPaths` is defined in server handler */
  hasGetPrerenderPaths?: boolean;
  /** Whether this is an island page (.island.tsx/.island.vue) */
  island?: boolean;
  /** Frontmatter metadata extracted from .md files (title, description) */
  metadata?: { title?: string; description?: string };
  /** Named layout selection: "name", "!name", or false */
  layout?: string | false;
  /** Environment from a `.dev` / `.prod` file suffix. Unset means both. */
  env?: RouteEnvironment;
};

export type LayoutDefinition = {
  /** Directory path relative to pages/, e.g. "" (root) or "users" */
  directory: string;
  /** Layout file relative path, e.g. "layout.vue" or "users/layout.vue" */
  filePath: string;
  /** Whether this is an island layout (layout.island.tsx/.island.vue) */
  island?: boolean;
};

export type NamedLayoutDefinition = {
  /** Layout name, e.g. "home", "post" */
  name: string;
  /** Directory containing _layouts/, e.g. "" (root) or "guide" */
  directory: string;
  /** File path relative to pages/, e.g. "_layouts/home.vue" */
  filePath: string;
  /** Whether this is an island layout */
  island?: boolean;
};

export type PageScanResult = {
  pages: Array<PageDefinition>;
  layouts: Array<LayoutDefinition>;
  namedLayouts: Array<NamedLayoutDefinition>;
};

export type DevCssAsset = {
  /** Vite client URL used to request the CSS module. */
  url: string;
  /** Vite dev style id used by the client to adopt/update SSR-inlined styles. */
  id?: string;
  /** CSS bytes returned by Vite's client environment transform with ?inline. */
  css: string;
};
