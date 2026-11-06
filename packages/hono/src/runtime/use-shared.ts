import { useContext } from 'hono/jsx';
import type { CloudContextVariables } from 'void';
import { SharedContext } from './context.ts';

export function useShared<T = CloudContextVariables['shared']>(): T {
  const shared = useContext(SharedContext);
  if (shared === null) {
    throw new Error('useShared(): must be used inside a Void page.');
  }
  return shared as T;
}
