import type { LayoutDefinition, NamedLayoutDefinition } from './types.ts';

type ResolvedLayoutEntry = {
  id: string;
  directory: string;
  definition: LayoutDefinition | NamedLayoutDefinition;
};

function isNamedLayout(
  layout: LayoutDefinition | NamedLayoutDefinition,
): layout is NamedLayoutDefinition {
  return 'name' in layout;
}

export function toLayoutId(layout: LayoutDefinition | NamedLayoutDefinition): string {
  if (isNamedLayout(layout)) {
    return layout.directory
      ? `${layout.directory}/_layouts/${layout.name}`
      : `_layouts/${layout.name}`;
  }
  return layout.directory ? `${layout.directory}/layout` : 'layout';
}

function resolveLayoutDirectories(componentId: string, componentPath?: string): Array<string> {
  if (componentPath) {
    const segments = componentPath.split('/');
    segments.pop();
    return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
  }

  const parts = componentId.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

/** Resolve the layout chain for a component (innermost last) */
export function resolveLayoutChain(
  componentId: string,
  layouts: Array<LayoutDefinition>,
  componentPath?: string,
): Array<LayoutDefinition> {
  const chain: Array<LayoutDefinition> = [];

  const root = layouts.find((layout) => layout.directory === '');
  if (root) {
    chain.push(root);
  }

  for (const dir of resolveLayoutDirectories(componentId, componentPath)) {
    const layout = layouts.find((candidate) => candidate.directory === dir);
    if (layout) {
      chain.push(layout);
    }
  }

  return chain;
}

/** Walk up directory tree to find closest _layouts/<name> */
export function resolveNamedLayout(
  name: string,
  componentId: string,
  namedLayouts: Array<NamedLayoutDefinition>,
  componentPath?: string,
): NamedLayoutDefinition | null {
  const dirs = resolveLayoutDirectories(componentId, componentPath).reverse();
  dirs.push(''); // root last
  for (const directory of dirs) {
    const found = namedLayouts.find(
      (namedLayout) => namedLayout.name === name && namedLayout.directory === directory,
    );
    if (found) {
      return found;
    }
  }
  return null;
}

export function resolveEffectiveLayoutEntries(
  page: { componentId: string; componentPath?: string; layout?: string | false },
  layouts: Array<LayoutDefinition>,
  namedLayouts: Array<NamedLayoutDefinition>,
): Array<ResolvedLayoutEntry> {
  if (page.layout === false) {
    return [];
  }

  const defaultChain = resolveLayoutChain(page.componentId, layouts, page.componentPath).map(
    (layout) => ({
      id: toLayoutId(layout),
      directory: layout.directory,
      definition: layout,
    }),
  );

  if (page.layout === undefined) {
    return defaultChain;
  }

  const isExclusive = page.layout.startsWith('!');
  const name = isExclusive ? page.layout.slice(1) : page.layout;
  const resolved = resolveNamedLayout(name, page.componentId, namedLayouts, page.componentPath);
  if (!resolved) {
    return defaultChain;
  }

  const namedEntry = {
    id: toLayoutId(resolved),
    directory:
      defaultChain.at(-1)?.directory ??
      (page.componentPath ?? page.componentId).split('/').slice(0, -1).join('/'),
    definition: resolved,
  };

  if (isExclusive || defaultChain.length === 0) {
    namedEntry.directory = (page.componentPath ?? page.componentId)
      .split('/')
      .slice(0, -1)
      .join('/');
    return [namedEntry];
  }

  const chain = [...defaultChain];
  chain[chain.length - 1] = namedEntry;
  return chain;
}

/** Resolve effective layout chain accounting for named layout selection */
export function resolveEffectiveLayoutChain(
  page: { componentId: string; componentPath?: string; layout?: string | false },
  layouts: Array<LayoutDefinition>,
  namedLayouts: Array<NamedLayoutDefinition>,
): Array<LayoutDefinition | NamedLayoutDefinition> {
  return resolveEffectiveLayoutEntries(page, layouts, namedLayouts).map(
    (layout) => layout.definition,
  );
}

export function resolveLayoutIds(
  page: { componentId: string; componentPath?: string; layout?: string | false },
  layouts: Array<LayoutDefinition>,
  namedLayouts: Array<NamedLayoutDefinition>,
): Array<string> {
  return resolveEffectiveLayoutEntries(page, layouts, namedLayouts).map((layout) => layout.id);
}
