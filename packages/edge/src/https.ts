/** Upgrade public HTTP requests without involving assets or application code. */
export function redirectToHttps(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (
    url.protocol !== 'http:' ||
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.localhost') ||
    isIpv4Loopback(url.hostname) ||
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

/**
 * `URL` already rewrites every IPv4 form (`127.1`, `0x7f.0.0.1`) to four
 * decimal parts and rejects parts above 255, so only the shape is checked.
 */
function isIpv4Loopback(hostname: string): boolean {
  const parts = hostname.split('.');
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => part !== '' && [...part].every((char) => char >= '0' && char <= '9'))
  );
}
