export { renderResources } from './resources.ts';
import type { ViewResult } from './index.ts';
import {
  instanceStyles,
  attribute,
  escapeHtml,
  type Binding,
  type Initialize,
  type Encoded,
} from './shared.ts';
export class Html implements ViewResult {
  readonly __view = true;
  constructor(
    readonly value: string,
    readonly components: ReadonlySet<string> = new Set(),
  ) {}
}
export function render(value: unknown): string {
  if (value == null || typeof value === 'boolean') {
    return '';
  }
  if (value instanceof Html) {
    return value.value;
  }
  if (Array.isArray(value)) {
    return value.map(render).join('');
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return escapeHtml(value);
  }
  throw new Error('Views can render only compiled HTML, scalars, and arrays');
}
function collect(value: unknown, components: Set<string>, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (value instanceof Html) {
    for (const id of value.components) {
      components.add(id);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collect(item, components, seen);
    }
  } else {
    for (const item of Object.values(value)) {
      collect(item, components, seen);
    }
  }
}
// Tagged tuples distinguish trusted compiled HTML from arbitrary application data.
function encode(value: unknown): Encoded {
  if (value instanceof Html) {
    return ['html', value.value];
  }
  if (value === undefined) {
    return ['undefined'];
  }
  if (Array.isArray(value)) {
    return ['array', value.map(encode)];
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return ['object', Object.entries(value).map(([key, item]) => [key, encode(item)])];
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return ['scalar', value];
  }
  throw new Error(
    'Root view props must be serializable. Pass callbacks from a dynamic view parent.',
  );
}
let depth = 0;
export function component(
  id: string,
  props: unknown,
  initialize: Initialize,
  dynamic: boolean,
  styled = false,
): Html {
  const root = depth === 0;
  const rid = styled ? crypto.randomUUID() : '';
  if (dynamic) {
    depth++;
  }
  let html: string;
  const components = new Set<string>();
  try {
    const content = initialize(
      (value) => value,
      styled
        ? (_key, css) =>
            new Html(
              '<style>' + instanceStyles(css, rid).replace(/<\/style/gi, '<\\/style') + '</style>',
            )
        : undefined,
      rid,
    )();
    collect(content, components);
    if (dynamic) {
      components.add(id);
      collect(props, components);
    }
    html = render(content);
  } finally {
    if (dynamic) {
      depth--;
    }
  }
  return new Html(
    dynamic
      ? `<${id}${rid ? ` data-vv-rid-${rid} data-vv-cid-${rid}` : ''}${root ? ` data-vv-props="${escapeHtml(JSON.stringify(encode(props)))}"` : ''}>${html}</${id}>`
      : html,
    components,
  );
}
export function template(
  _id: string,
  html: string,
  bindings: Array<Binding>,
  instance?: string,
): Html {
  if (instance) {
    html = html.replaceAll(' data-vv-i', ' data-vv-cid-' + instance);
  }
  const children = new Map<number, unknown>();
  const components = new Set<string>();
  const attrs = new Map<number, Map<string, unknown>>();
  function set(key: number, name: string, value: unknown) {
    if (!attrs.has(key)) {
      attrs.set(key, new Map());
    }
    attrs.get(key)!.set(name, value);
  }
  for (const [kind, key, name, value] of bindings) {
    if (kind === 'child') {
      children.set(key, value);
      collect(value, components);
    } else if (kind === 'attr') {
      set(key, name, value);
    } else if (kind === 'spread') {
      for (const [name, item] of Object.entries((value as object) ?? {})) {
        if (!/^on/i.test(name)) {
          set(key, name, item);
        }
      }
    }
  }
  return new Html(
    html
      .replace(/ data-vv-a="(\d+)"/g, (_, key) =>
        [...(attrs.get(+key) ?? [])].map(([name, value]) => attribute(name, value)).join(''),
      )
      .replace(
        /<slot data-vv-slot="(\d+)"(?: name="[^"]*")?><\/slot>|<!--vv:(\d+)-->/g,
        (_, slot, comment) => render(children.get(Number(slot ?? comment))),
      ),
    components,
  );
}
export function register(_id: string, _factory: (props: unknown) => unknown): void {}
