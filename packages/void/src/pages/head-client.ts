/// <reference lib="dom" />
import type { HeadDescriptor } from './head.ts';

const ATTR = 'data-void-head';

type HeadElementDescriptor = {
  tag: 'link' | 'meta';
  attrs: Record<string, string>;
};

function elementDescriptorSignature(descriptor: HeadElementDescriptor): string {
  const attrs = Object.entries(descriptor.attrs).sort(([a], [b]) => a.localeCompare(b));
  return `${encodeURIComponent(descriptor.tag)}:${attrs
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')}`;
}

function elementSignature(el: Element): string {
  const attrs: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    if (attr.name !== ATTR) {
      attrs[attr.name] = attr.value;
    }
  }
  return elementDescriptorSignature({
    tag: el.tagName.toLowerCase() as HeadElementDescriptor['tag'],
    attrs,
  });
}

function createHeadElement(descriptor: HeadElementDescriptor): Element {
  const el = document.createElement(descriptor.tag);
  for (const [key, value] of Object.entries(descriptor.attrs)) {
    el.setAttribute(key, value);
  }
  el.setAttribute(ATTR, '');
  return el;
}

function collectDesiredHeadElements(head: HeadDescriptor): Array<HeadElementDescriptor> {
  const desired: Array<HeadElementDescriptor> = [];

  if (head.meta) {
    for (const entry of head.meta) {
      const attrs: Record<string, string> = {};
      if (entry.charset) {
        attrs.charset = entry.charset;
      }
      if (entry.name) {
        attrs.name = entry.name;
      }
      if (entry.property) {
        attrs.property = entry.property;
      }
      if (entry.content !== undefined) {
        attrs.content = entry.content;
      }
      desired.push({ tag: 'meta', attrs });
    }
  }

  if (head.link) {
    for (const entry of head.link) {
      const attrs: Record<string, string> = {};
      for (const [key, value] of Object.entries(entry)) {
        if (value != null) {
          attrs[key] = value;
        }
      }
      desired.push({ tag: 'link', attrs });
    }
  }

  return desired;
}

/**
 * Mark SSR-rendered head tags so they are cleaned up on the first SPA navigation.
 * Call once after hydration with the initial page's head descriptor.
 */
export function initClientHead(head: HeadDescriptor | undefined): void {
  if (!head) {
    return;
  }

  if (head.meta) {
    for (const entry of head.meta) {
      const selector = entry.charset
        ? 'meta[charset]'
        : entry.property
          ? `meta[property="${entry.property}"]`
          : entry.name
            ? `meta[name="${entry.name}"]`
            : null;
      if (!selector) {
        continue;
      }
      const el = document.head.querySelector(selector);
      if (el) {
        el.setAttribute(ATTR, '');
      }
    }
  }

  if (head.link) {
    for (const entry of head.link) {
      const el = document.head.querySelector(`link[rel="${entry.rel}"][href="${entry.href}"]`);
      if (el) {
        el.setAttribute(ATTR, '');
      }
    }
  }
}

/**
 * Apply head changes on SPA navigation.
 * Preserves existing managed tags when their final attributes are unchanged.
 */
export function applyClientHead(head: HeadDescriptor | undefined): void {
  const existing = new Map<string, Array<Element>>();
  for (const el of document.head.querySelectorAll(`[${ATTR}]`)) {
    const signature = elementSignature(el);
    const elements = existing.get(signature);
    if (elements) {
      elements.push(el);
    } else {
      existing.set(signature, [el]);
    }
  }

  const desiredElements: Array<Element> = [];
  for (const descriptor of head ? collectDesiredHeadElements(head) : []) {
    const signature = elementDescriptorSignature(descriptor);
    const elements = existing.get(signature);
    const preserved = elements?.shift();
    if (elements && elements.length === 0) {
      existing.delete(signature);
    }
    desiredElements.push(preserved ?? createHeadElement(descriptor));
  }

  for (const elements of existing.values()) {
    for (const el of elements) {
      el.remove();
    }
  }

  let cursor = document.head.querySelector(`[${ATTR}]`) as Node | null;
  for (const el of desiredElements) {
    if (el !== cursor) {
      document.head.insertBefore(el, cursor);
    }
    cursor = el.nextSibling as Node | null;
  }

  document.title = head?.title ?? '';
}
