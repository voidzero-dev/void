import { useContext } from 'hono/jsx';
import type { NavigationState } from 'void/pages-client';
import { NavigationContext } from './context.ts';

export function useNavigation(): NavigationState {
  return useContext(NavigationContext);
}
