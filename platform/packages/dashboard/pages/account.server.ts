import { defineHandler, defineHead } from 'void';
import { fetchApi, getApiErrorMessage, readApiJson } from '../lib/api.ts';
import { dashboardRequestOrigin } from '../lib/origin.ts';
import { discoveryDisplayName, platformPageTitle } from '../lib/platform-title.ts';

export type Props = {
  methods: Array<{ id: string; label: string }>;
  platformName: string;
  error?: string;
};
export const head = defineHead<Props>((_context, props) => ({
  title: platformPageTitle('Login methods', props.platformName),
}));
export const loader = defineHandler<Props>(async (context) => {
  try {
    const response = await fetchApi(context, '/.well-known/void-platform');
    if (!response.ok) {
      throw new Error('Login methods unavailable');
    }
    const discovery = await response.json<{
      displayName?: unknown;
      authentication?: { methods?: Props['methods'] };
    }>();
    return {
      methods: discovery.authentication?.methods ?? [],
      platformName: discoveryDisplayName(discovery),
    };
  } catch {
    return {
      methods: [],
      platformName: 'Void Cloud',
      error: 'Login methods are unavailable. Try again shortly.',
    };
  }
});
export const action = defineHandler(async (context) => {
  // Cookie-authenticated mutations must originate in this dashboard.
  if (context.req.header('Origin') !== dashboardRequestOrigin(context)) {
    return context.text(
      'This request could not be verified. Refresh the account page and try again.',
      403,
    );
  }
  const body = await context.req.parseBody();
  if (typeof body.connectionId !== 'string') {
    return context.text('Choose a login method.', 400);
  }
  let response: Response;
  try {
    response = await fetchApi(context, '/auth/link', {
      method: 'POST',
      body: JSON.stringify({ connectionId: body.connectionId }),
    });
  } catch {
    return context.text('The service is temporarily unavailable. Try again shortly.', 503);
  }
  if (!response.ok) {
    return context.text(await getApiErrorMessage(response), response.status as 400);
  }
  const result = await readApiJson<{ url?: string }>(response);
  if (!result?.url) {
    return context.text('Unable to link. Sign in to your existing account again and retry.', 502);
  }
  return context.redirect(result.url, 303);
});
