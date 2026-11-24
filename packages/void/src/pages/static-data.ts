import { join } from 'pathslash';
import { parseRedirectsFile } from '../cli/headers.ts';
import { readConfig } from '../config.ts';

export type StaticPageDataBuildOptions = {
  enabled: boolean;
  fastPath: boolean;
};

type ResolveStaticPageDataBuildOptionsInput = {
  publicDir?: string | false;
};

export function resolveStaticPageDataBuildOptions(
  root: string,
  options: ResolveStaticPageDataBuildOptionsInput = {},
): StaticPageDataBuildOptions {
  const config = readConfig(root);
  const enabled = config.output === 'static';
  // Any config-level routing rule that mutates the response body — redirects
  // (3xx), rewrites (200), or fallbacks (post-asset 200) — must disable the
  // client-side static page-data fast path. The fast path fetches
  // `/_void/pages/<requested>.json` directly using the original pathname; the
  // dispatch worker's pre-asset/post-asset rewrite phase only runs against the
  // request URL, so when the URL is `/_void/pages/old.json` the rewrite
  // source `/old` never matches and the client commits unrewritten page data.
  // Header rules don't change body shape, so they don't need to gate the fast
  // path.
  const r = config.routing;
  const hasConfigRouting =
    (r?.redirects !== undefined && Object.keys(r.redirects).length > 0) ||
    (r?.rewrites !== undefined && Object.keys(r.rewrites).length > 0) ||
    (r?.fallbacks !== undefined && Object.keys(r.fallbacks).length > 0);

  const redirectDirs = [root];
  if (options.publicDir !== false) {
    redirectDirs.push(options.publicDir ?? join(root, 'public'));
  }

  const hasRedirectsFile = redirectDirs.some((dir) => {
    const parsed = parseRedirectsFile(dir);
    return parsed !== null && parsed !== undefined && parsed.rules.length > 0;
  });

  return {
    enabled,
    fastPath: enabled && !hasConfigRouting && !hasRedirectsFile,
  };
}
