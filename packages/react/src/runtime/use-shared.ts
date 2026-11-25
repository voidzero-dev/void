import { useContext } from 'react';
import type { CloudContextVariables } from 'void';
import { SharedContext } from './context.ts';

export function useShared<T = CloudContextVariables['shared']>(): T {
  const shared = useContext(SharedContext);
  if (!shared) {
    throw new Error('useShared(): must be used inside a Void page.');
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A caller can supply the app-specific shared context type.
  return shared as T;
}
