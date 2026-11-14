import { escapeHtml } from './shared.ts';

export interface ClientUnit {
  module: number;
  order: number;
  names: Array<string>;
  code: string;
  dependencies: Array<string>;
}
export interface ViewResources {
  components: Record<
    string,
    { dynamic: boolean; dependencies: Array<string>; templates: Array<[string, string]> }
  >;
  units: Record<string, ClientUnit>;
  componentUnits: Record<string, string>;
  register: string;
}
/** Worker-safe assembly of request-specific resources. No module registry or request state is shared. */
export function renderResources(roots: Iterable<string>, resources: ViewResources): string {
  const selected = new Set<string>();
  function include(id: string) {
    if (selected.has(id)) {
      return;
    }
    const component = resources.components[id];
    if (!component) {
      throw new Error(`Missing view resources: ${id}`);
    }
    selected.add(id);
    for (const dependency of component.dependencies) {
      include(dependency);
    }
  }
  for (const root of roots) {
    include(root);
  }
  if (!selected.size) {
    return '';
  }
  const wanted = new Set<string>();
  const modules = new Map<number, Map<string, ClientUnit>>();
  function use(id: string) {
    if (wanted.has(id)) {
      return;
    }
    const unit = resources.units[id];
    if (!unit) {
      throw new Error(`Missing view client source: ${id}`);
    }
    wanted.add(id);
    if (!modules.has(unit.module)) {
      modules.set(unit.module, new Map());
    }
    modules.get(unit.module)!.set(id, unit);
    for (const dependency of unit.dependencies) {
      use(dependency);
    }
  }
  for (const id of selected) {
    use(resources.componentUnits[id]!);
  }
  use(resources.register);
  let code = '';
  // Preserve module initialization order; function declarations remain naturally hoisted.
  const initialized = new Set<number>();
  function initialize(id: number) {
    if (initialized.has(id)) {
      return;
    }
    initialized.add(id);
    for (const unit of modules.get(id)!.values()) {
      for (const dependency of unit.dependencies) {
        const target = resources.units[dependency]!.module;
        if (target !== id) {
          initialize(target);
        }
      }
    }
    code +=
      [...modules.get(id)!.values()]
        .sort((a, b) => a.order - b.order)
        .map((unit) => unit.code)
        .join('\n') + '\n';
  }
  for (const id of modules.keys()) {
    initialize(id);
  }
  const registration = resources.units[resources.register]!;
  for (const id of selected) {
    if (resources.components[id]!.dynamic) {
      const unit = resources.units[resources.componentUnits[id]!]!;
      code += `${registration.names[0]}(${JSON.stringify(id)},${unit.names[0]});`;
    }
  }
  const templates = [...selected]
    .flatMap((id) => resources.components[id]!.templates)
    .map(([id, html]) => `<template id="${escapeHtml(id)}">${html}</template>`)
    .join('');
  // Escape the HTML raw-text terminator even when it appears inside a JS string or comment.
  return `${templates}<script type="module" data-void-view>${code.replace(/<\/script/gi, '<\\/script')}</script>`;
}
