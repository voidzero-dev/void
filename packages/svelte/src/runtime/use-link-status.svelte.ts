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
  // getLinkStatus() returns a fresh object, so derive each field to notify
  // readers only when that boolean changes.
  const current = $derived(status.current);
  const active = $derived(status.active);
  const pending = $derived(status.pending);
  return {
    get current() {
      return current;
    },
    get active() {
      return active;
    },
    get pending() {
      return pending;
    },
  };
}
