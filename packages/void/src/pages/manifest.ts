import { resolveLayoutIds, toLayoutId } from './layout-resolution.ts';
import type { PageScanResult } from './types.ts';

/**
 * Generates the component import map and layout tree as code strings.
 * Used by both SSR renderer and client entry virtual modules.
 *
 * Client entries load this eagerly, so it grows with every page. Each page id
 * is written once, identical layout chains are shared, and static routes are
 * matched by exact lookup instead of a RegExp per page. The emitted bindings
 * (`components`, `layoutTree`, `routeMeta`, `matchRoute`) keep their shape.
 */
export function generateComponentManifest(scan: PageScanResult, pagesDir: string): string {
  const load = (filePath: string) => `() => import(${JSON.stringify(`${pagesDir}/${filePath}`)})`;

  const chains: Array<string> = [];
  const chainIndexes = new Map<string, number>();
  const staticRows: Array<string> = [];
  const dynamicRows: Array<string> = [];
  // Routes are in precedence order. Static routes ahead of every dynamic route
  // can be looked up exactly without changing which route matches first.
  let inStaticPrefix = true;
  for (const page of scan.pages) {
    const chain = JSON.stringify(resolveLayoutIds(page, scan.layouts, scan.namedLayouts));
    let chainIndex = chain === '[]' ? -1 : chainIndexes.get(chain);
    if (chainIndex === undefined) {
      chainIndex = chains.push(chain) - 1;
      chainIndexes.set(chain, chainIndex);
    }
    const id = JSON.stringify(page.componentId);
    inStaticPrefix &&= isStaticPattern(page.pattern);
    if (inStaticPrefix) {
      const pattern =
        page.pattern === `/${page.componentId}` ? '' : `, ${JSON.stringify(page.pattern)}`;
      staticRows.push(`  [${id}, ${load(page.componentPath)}, ${chainIndex}${pattern}],`);
    } else {
      dynamicRows.push(
        `  [${patternToRegex(page.pattern)}, ${id}, ${load(page.componentPath)}, ${chainIndex}],`,
      );
    }
  }

  const lines: Array<string> = [];
  lines.push('const components = {};');
  lines.push(`const __voidLayoutChains = [${chains.join(', ')}];`);
  // [componentId, load, layout chain index (-1 for none), pattern unless "/" + componentId]
  lines.push('const __voidStaticRoutes = [', ...staticRows, '];');
  // [pattern, componentId, load, layout chain index]
  lines.push('const __voidDynamicRoutes = [', ...dynamicRows, '];');
  lines.push(`const layoutTree = {};
const __voidStaticRouteIds = new Map();
for (const [id, load, chain, pattern = "/" + id] of __voidStaticRoutes) {
  components[id] = load;
  if (chain >= 0) layoutTree[id] = __voidLayoutChains[chain];
  if (!__voidStaticRouteIds.has(pattern)) __voidStaticRouteIds.set(pattern, id);
}
const routes = [];
for (const [pattern, id, load, chain] of __voidDynamicRoutes) {
  components[id] = load;
  if (chain >= 0) layoutTree[id] = __voidLayoutChains[chain];
  routes.push({ pattern, id });
}`);
  // Layouts follow pages, as in the previous object literal where a layout won a shared key.
  for (const layout of [...scan.layouts, ...scan.namedLayouts]) {
    lines.push(`components[${JSON.stringify(toLayoutId(layout))}] = ${load(layout.filePath)};`);
  }

  // Route metadata (sparse — only island pages)
  lines.push('const routeMeta = {');
  for (const page of scan.pages) {
    if (page.island) {
      lines.push(`  ${JSON.stringify(page.componentId)}: { island: true },`);
    }
  }
  lines.push('};');

  lines.push(`function matchRoute(url) {
  const path = new URL(url, "http://x").pathname;
  const id = __voidStaticRouteIds.get(path);
  if (id !== undefined) return id;
  for (const r of routes) {
    if (r.pattern.test(path)) return r.id;
  }
  return null;
}`);

  return lines.join('\n');
}

/** Whether `patternToRegex` matches only the pattern's own text. */
function isStaticPattern(pattern: string): boolean {
  return pattern.split('/').every((segment) => segment !== '*' && !/^:[^/]+$/.test(segment));
}

function patternToRegex(pattern: string): string {
  const regexSource = pattern
    .split('/')
    .map((segment) => {
      if (segment === '*') {
        return '(.*)';
      }
      if (/^:[^/{}]+\{\.\+\}$/.test(segment)) {
        return '(.+)';
      }
      if (/^:[^/]+$/.test(segment)) {
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/')
    .replace(/\//g, '\\/');
  return `/^${regexSource}$/`;
}
