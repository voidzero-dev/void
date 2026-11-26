import { getLinkStatus } from 'void/pages-client';
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
  return computed(() => getLinkStatus(router, navigation, toValue(href), toValue(options)));
}
