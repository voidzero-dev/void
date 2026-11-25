import { getContext } from 'svelte';
import { idleNavigationState } from 'void/pages-client';
import type { NavigationState } from 'void/pages-client';

export function useNavigation(): NavigationState {
  const ctx = getContext<{ value: NavigationState }>('__void_navigation');
  if (!ctx) {
    return idleNavigationState();
  }
  return {
    get state() {
      return ctx.value.state;
    },
    get location() {
      return ctx.value.location;
    },
    get method() {
      return ctx.value.method;
    },
  };
}
