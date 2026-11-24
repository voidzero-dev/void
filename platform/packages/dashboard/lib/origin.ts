import type { Context } from 'hono';

export function isLocalDashboardHost(host: string): boolean {
  if (!/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/i.test(host)) {
    return false;
  }
  try {
    const port = new URL(`http://${host}`).port;
    return !port || Number(port) <= 65_535;
  } catch {
    return false;
  }
}

/** Only the configured public origin may replace an Assets-internal loopback URL. */
export function dashboardRequestOrigin(context: Context): string {
  const request = new URL(context.req.url);
  const configured = (context.env as { DASHBOARD_URL?: string }).DASHBOARD_URL;
  if (configured && ['localhost', '127.0.0.1', '[::1]'].includes(request.hostname)) {
    const publicUrl = new URL(configured);
    if (
      publicUrl.protocol !== 'https:' ||
      publicUrl.username ||
      publicUrl.password ||
      publicUrl.search ||
      publicUrl.hash ||
      publicUrl.pathname !== '/'
    ) {
      throw new Error('DASHBOARD_URL must be an HTTPS origin.');
    }
    if (context.req.header('host') === publicUrl.host) {
      return publicUrl.origin;
    }
  }
  return request.origin;
}
