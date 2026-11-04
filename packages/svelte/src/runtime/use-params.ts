import { getContext } from 'svelte';
import type { PagePath, PageParams } from 'void/routes';

/**
 * Read the dynamic route params of the page being rendered.
 *
 * Pass the page's URL pattern as the type argument to type the result:
 * `useParams<'/users/:id'>()` returns `{ id: string }`. This is a type-only
 * check; the params are returned as they are.
 */
export function useParams<
  T extends PagePath | Record<string, string> = Record<string, string>,
>(): T extends PagePath ? PageParams<T> : T {
  const ctx = getContext<{ value: Record<string, string> }>('__void_params');
  if (!ctx) {
    throw new Error('useParams(): must be used inside a Void page.');
  }
  return ctx.value as T extends PagePath ? PageParams<T> : T;
}
