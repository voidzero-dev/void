import { getContext } from 'svelte';
import { getLinkStatus } from 'void/pages-client';
import type { LinkStatus, LinkStatusOptions, NavigationState, VoidRouter } from 'void/pages-client';
import type { Href } from 'void/routes';

export function useLinkStatus(
  href: Href | (() => Href),
  options?: LinkStatusOptions | (() => LinkStatusOptions),
): LinkStatus {
  const router = getContext<VoidRouter | undefined>('__void_router');
  const navigation = getContext<{ value: NavigationState } | undefined>('__void_navigation');
  const status = $derived(
    getLinkStatus(
      router,
      navigation?.value,
      typeof href === 'function' ? href() : href,
      typeof options === 'function' ? options() : options,
    ),
  );
  return {
    get current() {
      return status.current;
    },
    get active() {
      return status.active;
    },
    get pending() {
      return status.pending;
    },
  };
}
