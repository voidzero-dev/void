import { resolveEffectiveLayoutEntries } from './layout-resolution.ts';
import type { PageBoundaryDefinition, PageScanResult } from './types.ts';

export type BoundaryPlan = {
  id: string;
  componentId: string;
  filePath: string;
  directory: string;
  kind: 'error' | 'not-found';
  source: string;
  layouts: Array<string>;
};
export type PageBoundaryPlans = {
  notFound?: string;
  notFoundErrors?: Array<string>;
  errors: Array<string>;
  catches: Array<{ depth: number; plan: string }>;
};
export type BoundaryManifest = {
  plans: Record<string, BoundaryPlan>;
  pages: Record<string, PageBoundaryPlans>;
  root?: string;
  rootErrors?: Array<string>;
};
const encloses = (outer: string, inner: string) =>
  !outer || outer === inner || inner.startsWith(outer + '/');

/** Build-local render identities preserve a named layout's logical placement. */
export function createBoundaryManifest(scan: PageScanResult): BoundaryManifest {
  if (!scan.boundaries?.length) {
    return { plans: {}, pages: {} };
  }
  const plans: BoundaryManifest['plans'] = {};
  const pages: BoundaryManifest['pages'] = {};
  const pageIds = new Set(scan.pages.map((page) => page.componentId));
  const layoutKey = (id: string) => (pageIds.has(id) ? id.replace(/(^|\/)([^/]+)$/, '$1_$2') : id);
  for (const page of scan.pages) {
    const directory = page.componentPath.split('/').slice(0, -1).join('/');
    const layouts = resolveEffectiveLayoutEntries(page, scan.layouts, scan.namedLayouts);
    const candidates = (scan.boundaries ?? [])
      .filter((b) => encloses(b.directory, directory))
      .sort((a, b) => b.directory.length - a.directory.length);
    const add = (boundary: PageBoundaryDefinition) => {
      const retained = layouts
        .filter((l) => encloses(l.directory, boundary.directory))
        .map((l) => layoutKey(l.id));
      const id = `_void:boundary:${JSON.stringify([page.componentId, boundary.componentId, retained])}`;
      plans[id] = { id, ...boundary, source: page.componentId, layouts: retained };
      return id;
    };
    const errors = candidates.filter((b) => b.kind === 'error');
    const notFound = candidates.find((b) => b.kind === 'not-found');
    pages[page.componentId] = {
      ...(notFound
        ? {
            notFound: add(notFound),
            notFoundErrors: errors
              .filter((b) => encloses(b.directory, notFound.directory))
              .map(add),
          }
        : {}),
      errors: errors.map(add),
      catches: errors.map((b) => ({
        depth: layouts.filter((l) => encloses(l.directory, b.directory)).length,
        plan: add(b),
      })),
    };
  }
  const root = scan.boundaries?.find((b) => b.kind === 'not-found' && !b.directory);
  if (root) {
    const id = `_void:boundary:root-not-found:${JSON.stringify(scan.layouts.filter((l) => !l.directory).map((l) => l.filePath))}`;
    plans[id] = {
      id,
      ...root,
      source: id,
      layouts: scan.layouts
        .filter((l) => !l.directory)
        .map((l) => layoutKey(l.directory ? l.directory + '/layout' : 'layout')),
    };
    const error = scan.boundaries?.find((b) => b.kind === 'error' && !b.directory);
    const rootErrors: Array<string> = [];
    if (error) {
      const errorId = `_void:boundary:root-error:${id}`;
      plans[errorId] = { ...error, id: errorId, source: id, layouts: [...plans[id].layouts] };
      rootErrors.push(errorId);
    }
    pages[id] = {
      errors: rootErrors,
      catches: rootErrors.map((plan) => ({ depth: plans[id].layouts.length, plan })),
    };
    return { plans, pages, root: id, rootErrors };
  }
  return { plans, pages };
}
