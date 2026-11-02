import { existsSync } from 'node:fs';
import { join, dirname, basename, extname, toSlash } from 'pathslash';
import { glob } from 'tinyglobby';
import { parseSync } from 'vite';
import { voidWarn } from '../log.ts';
import { readProjectPaths, type ProjectPaths } from '../project-paths.ts';
import {
  isRouteEnabledForEnvironment,
  parseRouteFilename,
  type RouteEnvironment,
} from '../router/parse-filename.ts';
import { bindingNames } from '../shared/ast-bindings.ts';
import {
  isIdentifier,
  isLiteral,
  moduleExportName,
  type AstExportNamedDeclaration,
  type AstFunctionDeclaration,
  type AstNode,
  type AstProgram,
  type AstVariableDeclaration,
} from '../shared/ast.ts';
import { ROUTE_EXTENSIONS, ROUTE_EXTENSIONS_SET } from '../shared/route-extensions.ts';
import { deriveFromSource } from '../shared/source-analysis-cache.ts';
import { staticExportInitializers, staticLiteral } from '../shared/static-exports.ts';
import { MARKDOWN_SCRIPT_RE, scriptBlocks } from './island-imports.ts';
import { resolveNamedLayout } from './layout-resolution.ts';
import { patternToRegex } from './manifest.ts';
import type {
  ExplicitBoolean,
  PageDefinition,
  PageRenderMode,
  PrerenderMode,
  LayoutDefinition,
  NamedLayoutDefinition,
  PageScanResult,
  SsrMode,
} from './types.ts';

const COMPONENT_EXTENSIONS = ['vue', 'tsx', 'jsx', 'svelte', 'md'];
const PAGE_METHODS = new Set(['loader', 'action', 'actions']);
export const MAX_REVALIDATE = 31536000; // 1 year in seconds

/** Layout paths already reported; a dev server rescans pages on every file change. */
const warnedLayoutPaths = new Set<string>();
/** Unreachable pages already reported, for the same reason. */
const warnedShadowedPages = new Set<string>();

type PageRenderingSource = {
  componentPath: string;
  island?: boolean;
  ssr?: ExplicitBoolean;
  prerender?: ExplicitBoolean;
  methods: Array<string>;
  params: Array<string>;
  catchAll: boolean;
  hasGetPrerenderPaths?: boolean;
};

type PageScanOptions = {
  output?: 'server' | 'static';
  paths?: ProjectPaths;
  pagesDir?: string;
  /** Report pages that share a route. Off when another framework owns pages/ (Nuxt nests users.vue and users/index.vue). */
  checkRoutes?: boolean;
  /** Keep only pages for this environment (`.dev` / `.prod` suffix). Unset keeps every page. */
  environment?: RouteEnvironment;
};

type ResolvedPageRendering = {
  ssrMode: SsrMode;
  prerenderMode: PrerenderMode;
  renderMode: PageRenderMode;
  shouldPrerender: boolean;
};

type PageServerMetadata = {
  methods: Array<string>;
  revalidate?: number;
  prerender?: ExplicitBoolean;
  ssr?: ExplicitBoolean;
  hasGetPrerenderPaths?: boolean;
};

function componentLayout(source: string, filename: string): string | false | undefined {
  if (!source.includes('layout')) {
    return undefined;
  }
  for (const script of scriptBlocks(source, filename)) {
    if (!script.source.includes('layout')) {
      continue;
    }
    const initializer = staticExportInitializers(
      script.filename,
      script.source,
      new Set(['layout']),
    ).get('layout');
    const value = staticLiteral(initializer);
    if (typeof value === 'string' || value === false) {
      return value;
    }
  }
  return undefined;
}

const TRANSPARENT_EXPRESSION_TYPES = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
]);

function readLiteral(node: AstNode | null | undefined): unknown {
  while (node && TRANSPARENT_EXPRESSION_TYPES.has(node.type)) {
    node = node.expression as AstNode | undefined;
  }
  return isLiteral(node) ? node.value : undefined;
}

function detectPageServerMetadata(source: string, filename: string): PageServerMetadata {
  const metadata: PageServerMetadata = { methods: [] };
  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(filename, source);
  } catch {
    return metadata;
  }

  const program = parsed.program as unknown as AstProgram;
  for (const node of program.body ?? []) {
    if (node.type !== 'ExportNamedDeclaration') {
      continue;
    }
    const exported = node as AstExportNamedDeclaration;
    if (exported.exportKind === 'type') {
      continue;
    }
    const declaration = exported.declaration;
    if (declaration?.type === 'VariableDeclaration') {
      const variables = declaration as AstVariableDeclaration;
      for (const variable of variables.declarations ?? []) {
        for (const name of bindingNames(variable.id)) {
          if (PAGE_METHODS.has(name)) {
            metadata.methods.push(name);
          } else if (name === 'getPrerenderPaths') {
            metadata.hasGetPrerenderPaths = true;
          }
        }
        if (isIdentifier(variable.id) && variables.kind === 'const') {
          const name = variable.id.name;
          if (name === 'revalidate') {
            const value = readLiteral(variable.init);
            if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
              metadata.revalidate = value;
            }
          } else if (name === 'prerender' || name === 'ssr') {
            const value = readLiteral(variable.init);
            if (typeof value === 'boolean') {
              metadata[name] = value;
            }
          }
        }
      }
    } else if (declaration?.type === 'FunctionDeclaration') {
      const functionName = (declaration as AstFunctionDeclaration).id;
      if (isIdentifier(functionName)) {
        if (PAGE_METHODS.has(functionName.name)) {
          metadata.methods.push(functionName.name);
        } else if (functionName.name === 'getPrerenderPaths') {
          metadata.hasGetPrerenderPaths = true;
        }
      }
    }
    for (const specifier of exported.specifiers ?? []) {
      const name = moduleExportName(specifier.exported);
      if (specifier.exportKind === 'type' || name === undefined) {
        continue;
      }
      if (PAGE_METHODS.has(name)) {
        metadata.methods.push(name);
      } else if (name === 'getPrerenderPaths') {
        metadata.hasGetPrerenderPaths = true;
      }
    }
  }
  return metadata;
}

function inferAutoPrerender(page: PageRenderingSource, options?: PageScanOptions): boolean {
  const isDynamic = page.params.length > 0 || page.catchAll;

  if (options?.output === 'static') {
    return !isDynamic || page.hasGetPrerenderPaths === true;
  }

  return page.island === true && !page.methods.includes('loader') && !isDynamic;
}

function resolvePageRendering(
  page: PageRenderingSource,
  options?: PageScanOptions,
): ResolvedPageRendering {
  if (page.island && page.ssr === false) {
    throw new Error(`pages: ssr = false is not valid for island page '${page.componentPath}'.`);
  }

  const ssrMode: SsrMode = page.ssr === true ? 'server' : page.ssr === false ? 'client' : 'auto';
  const prerenderMode: PrerenderMode =
    page.prerender === true ? 'force' : page.prerender === false ? 'disabled' : 'auto';
  const renderMode: PageRenderMode =
    page.island === true ? 'island' : ssrMode === 'client' ? 'client' : 'server';
  const shouldPrerender =
    prerenderMode === 'force' || (prerenderMode === 'auto' && inferAutoPrerender(page, options));

  return { ssrMode, prerenderMode, renderMode, shouldPrerender };
}

/**
 * The environment a file under pages/ is limited to, read from its name the way
 * scanPages does: `home.dev.tsx`, `home.dev.island.vue` and `home.dev.server.ts`
 * give 'dev'. Files the scanner skips (`_` segments, other extensions) give null.
 */
export function pageFileEnvironment(relativePath: string): RouteEnvironment | null {
  const segments = toSlash(relativePath).split('/');
  if (segments.some((segment) => segment.startsWith('_'))) {
    return null;
  }
  const file = segments[segments.length - 1];
  const ext = extname(file);
  let base = basename(file, ext);
  if (ROUTE_EXTENSIONS_SET.has(ext) && base.endsWith('.server')) {
    base = base.slice(0, -'.server'.length);
  } else if (COMPONENT_EXTENSIONS.includes(ext.slice(1))) {
    if (base.endsWith('.island')) {
      base = base.slice(0, -'.island'.length);
    }
  } else {
    return null;
  }
  return base.endsWith('.dev') ? 'dev' : base.endsWith('.prod') ? 'prod' : null;
}

export async function scanPages(root: string, options?: PageScanOptions): Promise<PageScanResult> {
  const pagesDir = options?.pagesDir ?? options?.paths?.pagesDir ?? readProjectPaths(root).pagesDir;
  if (!existsSync(pagesDir)) {
    return { pages: [], layouts: [], namedLayouts: [] };
  }

  const pattern = `**/*.{${COMPONENT_EXTENSIONS.join(',')}}`;
  const files = await glob(pattern, { cwd: pagesDir, absolute: false });

  const pages: Array<PageDefinition> = [];
  const layouts: Array<LayoutDefinition> = [];
  const namedLayouts: Array<NamedLayoutDefinition> = [];

  // Glob traversal order can vary between identical scans. Keep layout inventories stable too.
  for (const file of files.sort()) {
    const segments = file.split('/');
    // Skip files starting with _ in any segment (except _layouts/)
    if (segments.some((s) => s.startsWith('_') && s !== '_layouts')) {
      continue;
    }

    const ext = extname(file);
    let base = basename(file, ext);
    if (base.endsWith('.server') && ROUTE_EXTENSIONS_SET.has(ext)) {
      continue;
    }

    // Detect island suffix (.island.tsx, .island.vue, etc.)
    let island: boolean | undefined;
    let hasIslandSuffix = false;
    if (base.endsWith('.island')) {
      island = true;
      hasIslandSuffix = true;
      base = base.slice(0, -'.island'.length);
    }
    // .md files are implicitly island (static HTML, zero client JS)
    if (ext === '.md') {
      island = true;
    }

    // Named layout files: _layouts/name.vue, dir/_layouts/name.vue
    const layoutsDirIdx = segments.indexOf('_layouts');
    if (layoutsDirIdx !== -1) {
      // Only files directly inside _layouts/ (not nested deeper)
      if (layoutsDirIdx === segments.length - 2) {
        namedLayouts.push({
          name: base,
          directory: segments.slice(0, layoutsDirIdx).join('/'),
          filePath: file,
          island,
        });
      }
      continue;
    }

    // Layout files
    if (base === 'layout') {
      const dir = dirname(file);
      layouts.push({
        directory: dir === '.' ? '' : dir,
        filePath: file,
        island,
      });
      continue;
    }

    // Page files — parse as route
    // Convert component extensions to .ts so the route parser handles them uniformly.
    // Strip .island suffix before parsing so route patterns are clean.
    const parseName = hasIslandSuffix
      ? file.replace(`.island${ext}`, '.ts')
      : file.replace(ext, '.ts');
    const route = parseRouteFilename(parseName);
    // Skip pages for the other environment before reading their companion.
    if (!isRouteEnabledForEnvironment(route, options?.environment)) {
      continue;
    }
    const componentId =
      file
        .replace(ext, '')
        .replace(/\.island$/, '')
        .replace(/\/index$/, '')
        .replace(/^index$/, '') || 'index';

    // Check for a server companion — server files never have .island suffix
    let serverPath: string | null = null;
    const methods: Array<string> = [];
    let revalidate: number | undefined;
    let prerender: ExplicitBoolean;
    let ssr: ExplicitBoolean;
    let hasGetPrerenderPaths: boolean | undefined;
    const serverBase = hasIslandSuffix ? file.replace(`.island${ext}`, '') : file.replace(ext, '');
    for (const serverExt of ROUTE_EXTENSIONS) {
      const candidate = `${serverBase}.server.${serverExt}`;
      if (existsSync(join(pagesDir, candidate))) {
        serverPath = candidate;

        const metadata = deriveFromSource(join(pagesDir, candidate), 'page-server', (source) =>
          detectPageServerMetadata(source, candidate),
        );

        methods.push(...metadata.methods);
        revalidate = metadata.revalidate;
        prerender = metadata.prerender;
        ssr = metadata.ssr;
        hasGetPrerenderPaths = metadata.hasGetPrerenderPaths;
        break;
      }
    }

    const rendering = resolvePageRendering(
      {
        componentPath: file,
        island,
        ssr,
        prerender,
        methods,
        params: route.params,
        catchAll: route.catchAll,
        hasGetPrerenderPaths,
      },
      options,
    );

    // Prerender → max revalidate (applies to all pages)
    if (rendering.shouldPrerender && revalidate === undefined) {
      revalidate = MAX_REVALIDATE;
    }

    // Extract frontmatter metadata and layout from .md files, or layout from component files
    let metadata: { title?: string; description?: string } | undefined;
    let layout: string | false | undefined;

    if (ext === '.md') {
      ({ metadata, layout } = deriveFromSource(join(pagesDir, file), 'page-markdown', (source) => ({
        metadata: extractFrontmatterMeta(source),
        layout: extractFrontmatterLayout(source),
      })));
    } else {
      layout = deriveFromSource(join(pagesDir, file), 'page-layout', (source) =>
        componentLayout(source, file),
      );
    }

    pages.push({
      pattern: route.pattern,
      params: route.params,
      catchAll: route.catchAll,
      componentPath: file,
      serverPath,
      methods,
      componentId,
      revalidate,
      prerender,
      ssr,
      ...rendering,
      hasGetPrerenderPaths,
      island,
      metadata: metadata ? { ...metadata } : undefined,
      layout,
      ...(route.env ? { env: route.env } : {}),
    });
  }

  // Sort: static before dynamic, catch-all last
  pages.sort((a, b) => {
    if (a.catchAll !== b.catchAll) {
      return a.catchAll ? 1 : -1;
    }
    const aDynamic = a.pattern.includes(':');
    const bDynamic = b.pattern.includes(':');
    if (aDynamic !== bDynamic) {
      return aDynamic ? 1 : -1;
    }
    return a.pattern.localeCompare(b.pattern);
  });

  if (options?.checkRoutes !== false) {
    // At most one page per route in each environment. A scan for every
    // environment checks dev and prod on their own, so a .dev + .prod pair is fine.
    const environments = options?.environment ? [options.environment] : (['dev', 'prod'] as const);
    for (const environment of environments) {
      const live = pages.filter((page) =>
        isRouteEnabledForEnvironment({ env: page.env ?? null }, environment),
      );
      assertOnePagePerRoute(live);
      warnShadowedPages(pagesDir, live);
    }
  }

  // Validate: throw when regular pages are under island layouts
  for (const page of pages) {
    if (page.island) {
      continue;
    }
    const dir = dirname(page.componentPath);
    const segments = dir === '.' ? [] : dir.split('/');
    const ancestors = ['', ...segments.map((_, index) => segments.slice(0, index + 1).join('/'))];
    if (layouts.some((l) => l.island && ancestors.includes(l.directory))) {
      throw new Error(
        `pages: Regular page '${page.componentPath}' is under an island layout. Add a .island suffix.`,
      );
    }
  }

  // Validate named layout references
  for (const page of pages) {
    if (page.layout === undefined || page.layout === false) {
      continue;
    }
    const isExclusive = page.layout.startsWith('!');
    const name = isExclusive ? page.layout.slice(1) : page.layout;
    if (name.startsWith('.') || name.startsWith('/')) {
      const key = `${pagesDir}\0${page.componentPath}\0${page.layout}`;
      if (!warnedLayoutPaths.has(key)) {
        warnedLayoutPaths.add(key);
        voidWarn(
          `pages: Page '${page.componentPath}' specifies layout '${page.layout}'. Layout paths are not supported, so the default layouts are used. Use the name of a file in a _layouts/ directory, such as 'landing'.`,
        );
      }
      continue;
    }
    if (!resolveNamedLayout(name, page.componentId, namedLayouts, page.componentPath)) {
      throw new Error(
        `pages: Page '${page.componentPath}' specifies layout '${page.layout}', but _layouts/${name}.vue was not found in any ancestor directory.`,
      );
    }
  }

  return { pages, layouts, namedLayouts };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Group sorted pages by `key`, keeping only groups with more than one page. */
function pagesSharing(
  pages: Array<PageDefinition>,
  key: (page: PageDefinition) => string,
): Array<Array<PageDefinition>> {
  const groups = new Map<string, Array<PageDefinition>>();
  for (const page of pages) {
    const group = groups.get(key(page));
    if (group) {
      group.push(page);
    } else {
      groups.set(key(page), [page]);
    }
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

/**
 * Two files for one path have no stable winner: the server and the client can
 * each pick a different one, and the order can change between runs.
 */
function assertOnePagePerRoute(pages: Array<PageDefinition>): void {
  assertNoneShare(
    pages,
    (page) => page.pattern,
    'pages: Multiple page files resolve to the same route:',
    'Keep one page file per route and rename or remove the others.',
  );
  // index.tsx and index/index.tsx have different routes but the same page id.
  assertNoneShare(
    pages,
    (page) => page.componentId,
    'pages: Multiple page files resolve to the same page id:',
    'Rename or remove one of them.',
  );
}

function assertNoneShare(
  pages: Array<PageDefinition>,
  key: (page: PageDefinition) => string,
  title: string,
  hint: string,
): void {
  const clashes = pagesSharing(pages, key)
    .map((group) => ({
      key: key(group[0]),
      files: group.map((page) => page.componentPath).sort(compareText),
    }))
    .sort((left, right) => compareText(left.key, right.key))
    .map(
      (clash) =>
        `  ${JSON.stringify(clash.key)}: ${clash.files.map((file) => JSON.stringify(file)).join(', ')}`,
    );
  if (clashes.length > 0) {
    throw new Error([title, ...clashes, hint].join('\n'));
  }
}

/** Dynamic routes that match the same URLs, such as [id] and [slug]: only the first is ever used. */
function warnShadowedPages(pagesDir: string, pages: Array<PageDefinition>): void {
  for (const [used, ...shadowed] of pagesSharing(pages, (page) => patternToRegex(page.pattern))) {
    for (const page of shadowed) {
      const key = `${pagesDir}\0${used.componentPath}\0${page.componentPath}`;
      if (warnedShadowedPages.has(key)) {
        continue;
      }
      warnedShadowedPages.add(key);
      voidWarn(
        `pages: Page '${page.componentPath}' (${page.pattern}) is never used: '${used.componentPath}' (${used.pattern}) matches the same URLs first. Remove one of them.`,
      );
    }
  }
}

/** Return the raw YAML frontmatter of markdown source, after any leading <script> block. */
function markdownFrontmatter(source: string): string | undefined {
  const body = source.replace(MARKDOWN_SCRIPT_RE, '');
  return body.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
}

/** Read a single-line `key: value` field, stripping surrounding quotes. */
function frontmatterField(yaml: string, key: string): string | undefined {
  return yaml
    .match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, '');
}

/** Extract title and description from YAML frontmatter in markdown source. */
function extractFrontmatterMeta(
  source: string,
): { title?: string; description?: string } | undefined {
  const yaml = markdownFrontmatter(source);
  if (yaml === undefined) {
    return undefined;
  }
  const title = frontmatterField(yaml, 'title');
  const description = frontmatterField(yaml, 'description');
  if (!title && !description) {
    return undefined;
  }
  return { title, description };
}

/** Extract layout field from YAML frontmatter in markdown source. */
function extractFrontmatterLayout(source: string): string | false | undefined {
  const yaml = markdownFrontmatter(source);
  if (yaml === undefined) {
    return undefined;
  }
  const value = frontmatterField(yaml, 'layout');
  if (!value) {
    return undefined;
  }
  if (value === 'false') {
    return false;
  }
  return value;
}

export {
  resolveLayoutChain,
  resolveNamedLayout,
  resolveEffectiveLayoutChain,
} from './layout-resolution.ts';
