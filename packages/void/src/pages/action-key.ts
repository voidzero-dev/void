// On a page with named actions, the first query key selects the action
// (`/books?delete&page=2`). It addresses the action, not the page, so the page
// URL, history and c.redirect() leave it out.
const actionKeyRequests = new WeakSet<Request>();

export function markActionKey(request: Request): void {
  actionKeyRequests.add(request);
}

export function hasActionKey(request: Request): boolean {
  return actionKeyRequests.has(request);
}

/** The first non-empty segment of `search` as sent: `delete` in `?delete&page=2`. */
export function actionKeySegment(search: string): string {
  let start = 1;
  while (search[start] === '&') {
    start++;
  }
  const end = search.indexOf('&', start);
  return search.slice(start, end === -1 ? search.length : end);
}

/** `search` without its first non-empty segment; the rest is kept as sent. */
export function searchWithoutActionKey(search: string): string {
  let start = 1;
  while (search[start] === '&') {
    start++;
  }
  let rest = search.indexOf('&', start);
  if (rest === -1) {
    return '';
  }
  while (search[rest] === '&') {
    rest++;
  }
  return rest < search.length ? '?' + search.slice(rest) : '';
}

/**
 * Names the page query that an action request carries only because it posts
 * to the page it runs on. Redirects leave that query out.
 */
export const PRESERVED_QUERY_HEADER = 'X-VoidPages-Preserved-Query';

export function queryKey(segment: string): string | undefined {
  return new URLSearchParams(segment).keys().next().value;
}

/**
 * For an action URL on the page's own path, `url` with the page's query
 * parameters after its own. A key the action URL names wins over the page's.
 * `preserved` is the query that was added, as sent.
 */
export function withPageQuery(
  url: string,
  page: { pathname: string; search: string },
): { url: string; preserved: string } {
  const hashIndex = url.indexOf('#');
  const base = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const q = base.indexOf('?');
  if (!page.search || base.slice(0, q === -1 ? base.length : q) !== page.pathname) {
    return { url, preserved: '' };
  }
  const own = new Set(new URLSearchParams(q === -1 ? '' : base.slice(q + 1)).keys());
  const preserved = page.search
    .slice(1)
    .split('&')
    .filter((segment) => segment !== '' && !own.has(queryKey(segment)!))
    .join('&');
  if (!preserved) {
    return { url, preserved };
  }
  const query = q === -1 || q === base.length - 1 ? '?' : base.slice(q) + '&';
  return {
    url: base.slice(0, q === -1 ? base.length : q) + query + preserved + url.slice(base.length),
    preserved,
  };
}

/** `search` without the page query that `withPageQuery()` added to its end. */
export function searchWithoutPreservedQuery(search: string, preserved: string | null): string {
  if (!preserved) {
    return search;
  }
  if (search === '?' + preserved) {
    return '';
  }
  return search.endsWith('&' + preserved) ? search.slice(0, -preserved.length - 1) : search;
}
