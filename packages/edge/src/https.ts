/** Upgrade public HTTP requests without involving assets or application code. */
export function redirectToHttps(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (
    url.protocol !== 'http:' ||
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.localhost') ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname) ||
    url.hostname === '[::1]' ||
    url.pathname.startsWith('/.well-known/acme-challenge/') ||
    url.pathname.startsWith('/.well-known/pki-validation/')
  ) {
    return undefined;
  }
  url.protocol = 'https:';
  // Cloudflare's HTTP ports do not accept TLS. Upgrade to the default HTTPS port.
  url.port = '';
  return Response.redirect(url.href, 308);
}
