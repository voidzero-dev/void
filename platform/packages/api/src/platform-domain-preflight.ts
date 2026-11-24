import { normalizeApplicationDomain } from '@void/platform';
import type { Context } from 'hono';
import type { ApiEnv } from './env.ts';

/** Verify the deployed credential without exporting it or changing any application cache entry. */
export async function platformDomainPreflight(context: Context<ApiEnv>): Promise<Response> {
  const token = context.env.PLATFORM_HEALTH_PROBE_TOKEN;
  if (
    !token ||
    context.req.header('X-Void-Platform-Probe') !== token ||
    !context.env.PLATFORM_APPLICATION ||
    !context.env.PLATFORM_INSTALLATION_ID
  ) {
    return context.json({ error: 'not found' }, 404);
  }
  let zoneId: string;
  let domain: string;
  try {
    const body = await context.req.json<{ zoneId: string; domain: string }>();
    if (!/^[a-f0-9]{32}$/.test(body.zoneId)) {
      throw new Error('invalid zone');
    }
    zoneId = body.zoneId;
    domain = normalizeApplicationDomain(body.domain);
  } catch {
    return context.json({ error: 'Invalid domain or zone ID.' }, 400);
  }
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${context.env.CF_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          files: [`https://${domain}/.well-known/void-domain-check/${crypto.randomUUID()}`],
        }),
      },
    );
    const body = await response.json<{ success?: boolean }>();
    if (!response.ok || body.success !== true) {
      throw new Error('permission check failed');
    }
    return context.json({ ok: true, installationId: context.env.PLATFORM_INSTALLATION_ID });
  } catch {
    return context.json(
      {
        error: `Grant the running platform token Cache Purge: Purge on ${domain}, then retry domain setup.`,
      },
      403,
    );
  }
}
