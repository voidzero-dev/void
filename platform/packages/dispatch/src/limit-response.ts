import { usageLimitResponse } from '@void/edge';
import type { UsageLimitData } from '@void/edge';
import { createErrorResponse, shouldServeHtmlErrorPage } from './error-page.ts';

/** Runs entirely in dispatch: app execution and app resources are never needed. */
export async function createLimitResponse(
  request: Request,
  limit: UsageLimitData,
  loadPage?: () => Promise<Response | null>,
): Promise<Response> {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    Vary: 'Accept, Sec-Fetch-Dest, X-VoidPages',
  });
  const json = usageLimitResponse(limit);
  const retry = json.headers.get('retry-after');
  if (retry) {
    headers.set('Retry-After', retry);
  }
  if (request.headers.get('X-VoidPages') === 'true' || !shouldServeHtmlErrorPage(request)) {
    headers.set('Content-Type', 'application/json');
    return new Response(request.method === 'HEAD' ? null : json.body, { status: 429, headers });
  }
  try {
    const custom = await loadPage?.();
    if (custom?.ok && custom.headers.get('content-type')?.includes('text/html')) {
      headers.set('Content-Type', 'text/html; charset=utf-8');
      headers.set('X-Content-Type-Options', 'nosniff');
      // The fallback is standalone and remains usable while its app is blocked.
      headers.set(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
      );
      if (request.method === 'HEAD') {
        await custom.body?.cancel();
      }
      return new Response(request.method === 'HEAD' ? null : custom.body, { status: 429, headers });
    }
    await custom?.body?.cancel();
  } catch {
    // The platform's built-in page is available even if custom assets cannot be read.
  }
  return createErrorResponse(request, 429, limit.message, headers);
}
