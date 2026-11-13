import { isSameOrigin } from './url.ts';

const REDIRECT_HEADER = 'X-VoidPages-Redirect';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Opt-in transport: fetch hides redirect Location headers and drops fragments from response.url. */
export function pagesRedirectResponse(request: Request, response: Response): Response {
  if (!REDIRECT_STATUSES.has(response.status) || !response.headers.has('Location')) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.append('Vary', REDIRECT_HEADER);
  if (request.headers.get(REDIRECT_HEADER) !== 'manual') {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  headers.set(REDIRECT_HEADER, String(response.status));
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: 200, headers });
}

export type PagesFetchResult = { response: Response; redirectedTo?: string };
export type PagesFetchOptions = Omit<RequestInit, 'headers'> & { headers: Record<string, string> };

/** Follow negotiated redirects with HTTP method rules and origin checks. */
export async function fetchPages(
  url: string,
  options: PagesFetchOptions,
  followGetRedirects = true,
): Promise<PagesFetchResult> {
  const headers: Record<string, string> = { ...options.headers, [REDIRECT_HEADER]: 'manual' };
  const init = { ...options, headers };
  let redirectedTo: string | undefined;
  for (let redirects = 0; redirects <= 20; redirects++) {
    const response = await fetch(url.split('#')[0], init);
    const status = Number(response.headers.get(REDIRECT_HEADER));
    const location = response.headers.get('Location');
    if (response.status !== 200 || !REDIRECT_STATUSES.has(status) || location === null) {
      if (response.redirected) {
        // Older servers still use HTTP redirects. Preserve a fragment already known to us.
        const destination = new URL(response.url);
        const hash = url.indexOf('#');
        if (hash !== -1) {
          destination.hash = url.slice(hash);
        }
        redirectedTo = destination.href;
      }
      return { response, redirectedTo };
    }
    await response.body?.cancel();
    const base = new URL(
      url,
      window.location.origin + window.location.pathname + window.location.search,
    );
    const destination = new URL(location, response.url || base.href);
    if (!['http:', 'https:', 'capacitor:'].includes(destination.protocol)) {
      throw new Error(`Void Pages: refusing to redirect to a ${destination.protocol} URL.`);
    }
    if (!location.includes('#')) {
      destination.hash = base.hash;
    }
    redirectedTo = destination.href;
    const method = (init.method ?? 'GET').toUpperCase();
    const get =
      (status === 303 && method !== 'GET' && method !== 'HEAD') ||
      ((status === 301 || status === 302) && method === 'POST');
    if (
      !isSameOrigin(destination, window.location.origin) ||
      (!followGetRedirects && (get || method === 'GET' || method === 'HEAD'))
    ) {
      return { response, redirectedTo };
    }
    if (get) {
      for (const name of Object.keys(headers)) {
        if (/^content-(?:type|length|encoding|language|location)$/i.test(name)) {
          delete headers[name];
        }
      }
      init.method = 'GET';
      init.body = undefined;
    }
    url = destination.href;
  }
  throw new TypeError('Too many Pages redirects.');
}
