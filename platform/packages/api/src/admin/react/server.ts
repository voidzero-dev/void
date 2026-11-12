import { renderReactPage } from '@void/react/pages-server';
import type { Context } from 'hono';
import type { PageObject } from 'void/pages-protocol';
import type { ApiEnv } from '../../env.ts';
import { formatPlatformPageTitle } from '../../platform-identity.ts';
import type { createAdminFateClient } from '../fate/client.ts';
import { adminComponents, adminLayoutTree, type AdminPageId } from './pages.ts';

export async function renderAdminPage(
  context: Context<ApiEnv>,
  component: AdminPageId,
  title: string,
  props: Record<string, unknown>,
  options: {
    status?: number;
    fateSnapshot?: Parameters<ReturnType<typeof createAdminFateClient>['hydrate']>[0];
  } = {},
): Promise<Response> {
  const platformName = String(props.platformName ?? 'Void');
  const { pathname, search } = new URL(context.req.url);
  const pageObj: PageObject = {
    component,
    props,
    params: {},
    shared: {
      platformName,
      adminPageUrl: pathname + search,
      adminFateSession: `${context.get('user')?.id ?? 'guest'}:${context.get('humanSession')?.id ?? 'none'}`,
      ...(options.fateSnapshot ? { adminFateSnapshot: options.fateSnapshot } : {}),
    },
    url: pathname + search,
    errors: null,
    head: {
      title: formatPlatformPageTitle(title, platformName),
      htmlAttrs: { lang: 'en', 'data-astryx-theme': 'neutral' },
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ],
    },
  };
  const headers = {
    'Cache-Control': 'private, no-store',
    Vary: 'X-VoidPages',
    'X-VoidPages': 'true',
  };
  if (context.req.header('X-VoidPages') === 'true') {
    return Response.json(pageObj, { headers, status: options.status ?? 200 });
  }
  const stream = await renderReactPage({
    pageObj,
    components: adminComponents,
    layoutTree: adminLayoutTree,
    assetTags: {
      css: '<link rel="stylesheet" href="/admin/style.css">',
      preloads: '',
      body: '<script src="/admin/client.js" defer></script>',
    },
  });
  return new Response(stream, {
    status: options.status ?? 200,
    headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
  });
}
