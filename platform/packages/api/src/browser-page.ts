import {
  escapeBrowserHtml,
  browserPageLead,
  browserPageStatus,
  renderBrowserPage,
} from '@void/platform/browser-page';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiEnv } from './env.ts';

type BrowserRequestContext = Pick<Context<ApiEnv>, 'env' | 'html' | 'header'> & {
  req: Pick<Context<ApiEnv>['req'], 'url' | 'path'>;
};
import { getPlatformDisplayName } from './platform-identity.ts';

export function platformBrowserPage(
  context: BrowserRequestContext,
  title: string,
  content: string,
  status: ContentfulStatusCode = 200,
): Response {
  return context.html(
    renderBrowserPage({
      title,
      platformName: getPlatformDisplayName(context.env, context.req.url),
      content,
    }),
    status,
  );
}

export function platformBrowserError(
  context: BrowserRequestContext,
  title: string,
  message: string,
  status: ContentfulStatusCode,
  extra: Readonly<{
    /** Plain-text lines shown below the message. */
    details?: ReadonlyArray<string>;
    /** A command the reader runs to fix the problem. */
    command?: string;
    /** Where "Start a new sign-in" leads instead of the usual page. */
    returnUrl?: string;
  }> = {},
): Response {
  context.header('Cache-Control', 'no-store');
  context.header('Referrer-Policy', 'no-referrer');
  let returnUrl: string | undefined;
  if (extra.returnUrl) {
    returnUrl = extra.returnUrl;
  } else if (context.req.path.startsWith('/auth/bootstrap') || context.req.path === '/setup') {
    returnUrl = '/setup';
  } else if (context.env.DASHBOARD_URL) {
    try {
      const url = new URL('/login', context.env.DASHBOARD_URL);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
        returnUrl = url.href;
      }
    } catch {
      /* No navigation link for an invalid configured dashboard URL. */
    }
  }
  const action = returnUrl
    ? '<a class="void-auth-button void-auth-button-primary" href="' +
      escapeBrowserHtml(returnUrl) +
      '">Start a new sign-in</a>'
    : '';
  const details = (extra.details ?? [])
    .map((detail) => '<p class="void-auth-note">' + escapeBrowserHtml(detail) + '</p>')
    .join('');
  const command = extra.command
    ? '<pre><code>' + escapeBrowserHtml(extra.command) + '</code></pre>'
    : '';
  return platformBrowserPage(
    context,
    title,
    browserPageStatus('error') + browserPageLead(title, message) + details + command + action,
    status,
  );
}

export function acceptsBrowserHtml(context: {
  req: Pick<Context<ApiEnv>['req'], 'header'>;
}): boolean {
  return (context.req.header('Accept') ?? '').split(',').some((type) => {
    const [media, ...parameters] = type.trim().toLowerCase().split(';');
    return (
      media === 'text/html' &&
      !parameters.some((parameter) => /^q=0(?:\.0*)?$/.test(parameter.trim()))
    );
  });
}
