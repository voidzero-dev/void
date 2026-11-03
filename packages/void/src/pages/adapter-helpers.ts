/// <reference lib="dom" />
import type { Href } from 'void/routes';

export function getValidationErrors(body: unknown): Record<string, string> | null {
  if (
    body &&
    typeof body === 'object' &&
    'errors' in body &&
    body.errors &&
    typeof body.errors === 'object' &&
    !Array.isArray(body.errors)
  ) {
    return body.errors as Record<string, string>;
  }
  return null;
}

function appendQueryValue(params: URLSearchParams, key: string, value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (value instanceof Date) {
    params.append(key, value.toISOString());
    return true;
  }
  if (Array.isArray(value)) {
    let appended = false;
    for (const item of value) {
      appended = appendQueryValue(params, key, item) || appended;
    }
    return appended;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    params.append(key, String(value));
    return true;
  }
  throw new Error(
    `Link: GET data only supports primitive values and arrays. Remove nested data for '${key}'.`,
  );
}

export function mergeDataIntoHref(href: Href, data?: Record<string, unknown>): Href {
  if (!data) {
    return href;
  }

  const hashIndex = href.indexOf('#');
  const beforeHash = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : href.slice(hashIndex);
  const searchIndex = beforeHash.indexOf('?');
  const path = searchIndex === -1 ? beforeHash : beforeHash.slice(0, searchIndex);
  const search = searchIndex === -1 ? '' : beforeHash.slice(searchIndex + 1);
  const params = new URLSearchParams(search);
  let appended = false;

  for (const [key, value] of Object.entries(data)) {
    appended = appendQueryValue(params, key, value) || appended;
  }

  if (!appended) {
    return href;
  }

  const query = params.toString();
  // Adding query parameters keeps a route, same-page or external URL valid.
  return `${path}${query ? `?${query}` : ''}${hash}` as Href;
}

export function isModifiedEvent(
  e: Pick<MouseEvent, 'currentTarget' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'button'>,
): boolean {
  const target = (e.currentTarget as HTMLElement).getAttribute('target');
  return (
    (target !== null && target !== '_self') ||
    e.ctrlKey ||
    e.metaKey ||
    e.shiftKey ||
    e.altKey ||
    e.button !== 0
  );
}
