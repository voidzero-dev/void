import { defineHandler, defineHead } from 'void';
import { fetchApi } from '../lib/api.ts';
import type { API } from '../lib/api.ts';
import { discoveryDisplayName, platformPageTitle } from '../lib/platform-title.ts';

export type Props = Readonly<{
  user: API<'me'>;
  platformName: string;
}>;

export const head = defineHead<Props>((_context, props) => ({
  title: platformPageTitle('Dashboard', props.platformName),
}));

export const loader = defineHandler<Props>(async (context) => {
  let platformName = 'Void Cloud';
  try {
    const response = await fetchApi(context, '/.well-known/void-platform');
    if (response.ok) {
      platformName = discoveryDisplayName((await response.json()) as { displayName?: unknown });
    }
  } catch {
    // The user's dashboard remains available when discovery is temporarily unavailable.
  }
  return { user: context.get('dashboardUser'), platformName };
});
