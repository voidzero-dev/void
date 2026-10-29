import type { AssetConfig, HeaderRule, RedirectRule } from '@void/deploy-core';
import { applyHeaderRules } from './headers.ts';
import { redirectToHttps } from './https.ts';
import { applyRoutingRules, mergeQueryIntoLocation } from './routing-rules.ts';

export type EdgeAssetFetcher = Readonly<{
  fetch(request: Request): Promise<Response>;
}>;

export type StaticEdgeEnv = Readonly<{
  ASSETS: EdgeAssetFetcher;
}>;

export type StaticEdgeConfig = Readonly<{
  alwaysUseHttps?: boolean;
  /** Optional native Worker self-metadata used to identify the served version. */
  versionMetadataBinding?: string;
  /**
   * @deprecated Ignored. Cloudflare applies asset handling from the Worker's
   * `assets` config (`not_found_handling`, `html_handling`), which `void deploy`
   * writes. Removed in the next major version.
   */
  assetConfig?: AssetConfig;
  headerRules?: ReadonlyArray<HeaderRule>;
  redirectRules?: ReadonlyArray<RedirectRule>;
  fallbackRules?: ReadonlyArray<RedirectRule>;
}>;

export type StaticEdgeHandler = Readonly<{
  fetch(request: Request, env: StaticEdgeEnv): Promise<Response>;
}>;

/**
 * Create the thin Worker used by direct static, SPA, and SSG deployments.
 * Routing semantics intentionally match the hosted dispatch Worker: redirects
 * and rewrites run before assets, fallback rewrites run only after an asset
 * miss, and response-header rules apply to the effective pathname.
 */
export function createStaticEdgeHandler(config: StaticEdgeConfig): StaticEdgeHandler {
  return {
    async fetch(request, env): Promise<Response> {
      const originalUrl = new URL(request.url);
      if (request.method === 'GET' && originalUrl.pathname === '/__void/ready') {
        if (!config.versionMetadataBinding) {
          return Response.json({ ready: true });
        }
        const metadata = (env as unknown as Record<string, { id?: unknown } | undefined>)[
          config.versionMetadataBinding
        ];
        return Response.json(
          { ready: true, versionId: metadata?.id },
          { headers: { 'cache-control': 'no-store' } },
        );
      }
      if (config.alwaysUseHttps) {
        const redirect = redirectToHttps(request);
        if (redirect) {
          return redirect;
        }
      }
      let effectiveUrl = new URL(originalUrl);
      let effectiveRequest = request;

      const route = applyRoutingRules(
        effectiveUrl.pathname,
        config.redirectRules,
        effectiveUrl.hostname,
      );
      if (route?.type === 'redirect') {
        return applyHeaderRules(
          new Response(null, {
            status: route.status,
            headers: {
              location: mergeQueryIntoLocation(route.destination, effectiveUrl.search),
            },
          }),
          effectiveUrl.pathname,
          config.headerRules,
          { cookieIsolation: 'origin' },
        );
      }
      if (route?.type === 'rewrite') {
        effectiveUrl = rewriteUrl(effectiveUrl, route.destination);
        effectiveRequest = rewriteRequest(request, effectiveUrl, originalUrl.toString());
      }

      let response = await env.ASSETS.fetch(effectiveRequest);
      if (response.status === 404) {
        const fallback = applyRoutingRules(
          effectiveUrl.pathname,
          config.fallbackRules,
          effectiveUrl.hostname,
        );
        if (fallback?.type === 'rewrite') {
          effectiveUrl = rewriteUrl(effectiveUrl, fallback.destination);
          effectiveRequest = rewriteRequest(request, effectiveUrl, originalUrl.toString());
          response = await env.ASSETS.fetch(effectiveRequest);
        }
      }

      return applyHeaderRules(response, effectiveUrl.pathname, config.headerRules, {
        cookieIsolation: 'origin',
      });
    },
  };
}

function rewriteUrl(url: URL, destination: string): URL {
  const rewritten = new URL(url);
  const destinationUrl = new URL(destination, url);
  rewritten.pathname = destinationUrl.pathname;
  rewritten.search = destinationUrl.search || url.search;
  return rewritten;
}

function rewriteRequest(request: Request, url: URL, originalUrl: string): Request {
  const rewritten = new Request(url.toString(), request);
  rewritten.headers.set('X-Void-Original-URL', originalUrl);
  return rewritten;
}
