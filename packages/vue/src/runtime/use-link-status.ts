import { getLinkStatus, linkStatusEquals } from 'void/pages-client';
import type { LinkStatus, LinkStatusOptions, NavigationState, VoidRouter } from 'void/pages-client';
import type { Href } from 'void/routes';
import { computed, inject, toValue } from 'vue';
import type { ComputedRef, MaybeRefOrGetter } from 'vue';

export function useLinkStatus(
  href: MaybeRefOrGetter<Href>,
  options?: MaybeRefOrGetter<LinkStatusOptions>,
): ComputedRef<LinkStatus> {
  const router = inject<VoidRouter | null>('__void_router', null);
  const navigation = inject<NavigationState | null>('__void_navigation', null);
  // Keep the previous object for an equal status so watchers skip unchanged updates.
  return computed((previous) => {
    const next = getLinkStatus(router, navigation, toValue(href), toValue(options));
    return previous && linkStatusEquals(previous, next) ? previous : next;
  });
}
