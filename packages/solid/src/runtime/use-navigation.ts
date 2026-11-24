import { useContext } from 'solid-js';
import { idleNavigationState } from 'void/pages-client';
import type { NavigationState } from 'void/pages-client';
import { NavigationContext } from './context.ts';

export function useNavigation(): NavigationState {
  const navigation = useContext(NavigationContext);
  if (!navigation) {
    return idleNavigationState();
  }
  return {
    get state() {
      return navigation().state;
    },
    get location() {
      return navigation().location;
    },
    get method() {
      return navigation().method;
    },
  };
}
