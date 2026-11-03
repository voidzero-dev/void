import { Link } from '@void/react';
import type { ElementType, JSX as ReactJSX, ReactElement } from 'react';
import { Fragment, jsx as reactJsx, jsxs as reactJsxs } from 'react/jsx-runtime';

export { Fragment };

export namespace JSX {
  export type ElementType = ReactJSX.ElementType;
  export type Element = ReactElement;
  export interface ElementChildrenAttribute {
    children: unknown;
  }
  export interface IntrinsicAttributes {
    key?: string | number;
  }
  export interface IntrinsicElements {
    [name: string]: Record<string, unknown>;
  }
}

function normalizeStyle(value: string): Record<string, string> {
  const style: Record<string, string> = {};
  for (const declaration of value.split(';')) {
    const separator = declaration.indexOf(':');
    if (separator === -1) {
      continue;
    }
    const name = declaration
      .slice(0, separator)
      .trim()
      .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    if (name) {
      style[name] = declaration.slice(separator + 1).trim();
    }
  }
  return style;
}

function normalizeProps(type: unknown, input: Record<string, unknown>): Record<string, unknown> {
  if (typeof type !== 'string') {
    return input;
  }
  const props = { ...input };
  if (typeof props.style === 'string') {
    props.style = normalizeStyle(props.style);
  }
  if ('class' in props) {
    props.className = props.class;
    delete props.class;
  }
  for (const [source, target] of [
    ['readonly', 'readOnly'],
    ['colspan', 'colSpan'],
    ['rowspan', 'rowSpan'],
    ['maxlength', 'maxLength'],
    ['autocomplete', 'autoComplete'],
  ]) {
    if (source in props) {
      props[target] = props[source];
      delete props[source];
    }
  }
  if (type === 'input' || type === 'textarea' || type === 'select') {
    if ('value' in props && !('onChange' in props)) {
      props.defaultValue = props.value;
      delete props.value;
    }
    if ('checked' in props && !('onChange' in props)) {
      props.defaultChecked = props.checked;
      delete props.checked;
    }
  }
  return props;
}

export function prepare(type: unknown, props: Record<string, unknown>) {
  const normalized = normalizeProps(type, props);
  if (
    type === 'a' &&
    typeof normalized.href === 'string' &&
    normalized.href.startsWith('/admin/')
  ) {
    if (normalized.href !== '/admin/logout' && !normalized.href.startsWith('/admin/login')) {
      return { type: Link, props: normalized };
    }
  }
  return { type, props: normalized };
}

export function jsx(type: unknown, props: Record<string, unknown>, key?: string): ReactElement {
  const prepared = prepare(type, props);
  return reactJsx(prepared.type as ElementType, prepared.props, key);
}

export function jsxs(type: unknown, props: Record<string, unknown>, key?: string): ReactElement {
  const prepared = prepare(type, props);
  return reactJsxs(prepared.type as ElementType, prepared.props, key);
}
