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
