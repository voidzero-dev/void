import { useContext } from 'react';
import type { PagePath, PageParams } from 'void/routes';
import { ParamsContext } from './context.ts';

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
  const params = useContext(ParamsContext);
  if (params === null) {
    throw new Error('useParams(): must be used inside a Void page.');
  }
  return params as T extends PagePath ? PageParams<T> : T;
}
