import { useContext } from 'hono/jsx';
import { ssrProxy } from 'void/pages-client';
import type { VoidRouter } from 'void/pages-client';
import { RouterContext } from './context.ts';

export function useRouter(): VoidRouter {
  return useContext(RouterContext) ?? ssrProxy;
}
