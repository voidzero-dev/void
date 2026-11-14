import type { ViewResult } from './index.ts';
import {
  attribute,
  booleanAttributes,
  type Binding,
  type Initialize,
  type Encoded,
} from './shared.ts';
interface Host extends HTMLElement {
  mount?: () => void;
  refresh?: () => void;
}
let hydrating: Host | undefined;
class Fragment implements ViewResult {
  readonly __view = true;
  constructor(readonly create: () => DocumentFragment) {}
}
class SerializedHtml {
  constructor(readonly html: string) {}
}
function decode(encoded: Encoded): unknown {
  const [kind, value] = encoded;
  if (kind === 'html') {
    return new SerializedHtml(value);
  }
  if (kind === 'array') {
    return value.map(decode);
  }
  if (kind === 'object') {
    return Object.fromEntries(value.map(([key, item]) => [key, decode(item)]));
  }
  return kind === 'undefined' ? undefined : value;
}
function append(parent: Node, value: unknown): void {
  if (value == null || typeof value === 'boolean') {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      append(parent, item);
    }
    return;
  }
  if (value instanceof SerializedHtml) {
    const template = document.createElement('template');
    template.innerHTML = value.html;
    parent.appendChild(template.content);
    return;
  }
  if (value instanceof Fragment) {
    parent.appendChild(value.create());
    return;
  }
  if (value instanceof Node) {
    parent.appendChild(value);
    return;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error('Invalid view child');
  }
  parent.appendChild(document.createTextNode(String(value)));
}
export function component(
  id: string,
  _props: unknown,
  initialize: Initialize,
  dynamic: boolean,
): ViewResult {
  if (!dynamic) {
    return initialize((value) => value)() as ViewResult;
  }
  const host = hydrating?.localName === id ? hydrating : (document.createElement(id) as Host);
  if (host === hydrating) {
    hydrating = undefined;
  }
  let queued = false;
  const draw = initialize((value) => {
    try {
      return value;
    } finally {
      if (!queued) {
        queued = true;
        queueMicrotask(() => {
          queued = false;
          if (host.isConnected) {
            host.refresh?.();
          }
        });
      }
    }
  });
  host.refresh = () => {
    const content = document.createDocumentFragment();
    append(content, draw());
    host.replaceChildren(content);
  };
  host.mount = () => {
    host.refresh!();
    host.setAttribute('data-vv-ready', '');
  };
  host.mount();
  return host as unknown as ViewResult;
}
export function register(id: string, factory: (props: unknown) => unknown): void {
  if (customElements.get(id)) {
    return;
  }
  customElements.define(
    id,
    class extends HTMLElement {
      connectedCallback() {
        const host = this as Host;
        if (host.mount || !this.hasAttribute('data-vv-props')) {
          return;
        }
        const previous = hydrating;
        hydrating = host;
        try {
          factory(decode(JSON.parse(this.getAttribute('data-vv-props')!)));
        } finally {
          hydrating = previous;
        }
      }
    },
  );
}
export function template(id: string, _html: string | null, bindings: Array<Binding>): ViewResult {
  return new Fragment(() => {
    const source = document.getElementById(id);
    if (!(source instanceof HTMLTemplateElement)) {
      throw new Error(`Missing view template: ${id}`);
    }
    const fragment = source.content.cloneNode(true) as DocumentFragment;
    const slots = new Map<number, ChildNode>(
      Array.from(fragment.querySelectorAll('[data-vv-slot]'), (el) => [
        Number(el.getAttribute('data-vv-slot')),
        el,
      ]),
    );
    const comments = document.createTreeWalker(fragment, NodeFilter.SHOW_COMMENT);
    while (comments.nextNode()) {
      const comment = comments.currentNode as Comment;
      if (/^vv:\d+$/.test(comment.data)) {
        slots.set(Number(comment.data.slice(3)), comment);
      }
    }
    const elements = new Map(
      Array.from(fragment.querySelectorAll('[data-vv-a]'), (el) => [
        Number(el.getAttribute('data-vv-a')),
        el,
      ]),
    );
    function set(el: Element, name: string, value: unknown) {
      // Share validation and boolean semantics with SSR.
      attribute(name, value);
      if (value == null || (booleanAttributes.has(name) && !value)) {
        el.removeAttribute(name);
      } else {
        el.setAttribute(name, booleanAttributes.has(name) ? '' : String(value));
      }
      if (name === 'value' && 'value' in el) {
        (el as HTMLInputElement).value = String(value ?? '');
      }
      if (name === 'checked' && 'checked' in el) {
        (el as HTMLInputElement).checked = !!value;
      }
    }
    const events = new Map<Element, Map<string, unknown>>();
    function event(el: Element, name: string, value: unknown) {
      if (!events.has(el)) {
        events.set(el, new Map());
      }
      events.get(el)!.set(name, value);
    }
    for (const [kind, key, name, value] of bindings) {
      if (kind === 'child') {
        const content = document.createDocumentFragment();
        append(content, value);
        slots.get(key)!.replaceWith(content);
      } else {
        const el = elements.get(key)!;
        if (kind === 'event') {
          event(el, name, value);
        } else if (kind === 'attr') {
          set(el, name, value);
        } else {
          for (const [name, item] of Object.entries((value as object) ?? {})) {
            if (/^on/i.test(name)) {
              event(el, name.slice(2).toLowerCase(), item);
            } else {
              set(el, name, item);
            }
          }
        }
      }
    }
    for (const [element, handlers] of events) {
      for (const [name, handler] of handlers) {
        if (handler != null) {
          element.addEventListener(name, handler as EventListener);
        }
      }
    }
    for (const el of elements.values()) {
      el.removeAttribute('data-vv-a');
    }
    return fragment;
  });
}
