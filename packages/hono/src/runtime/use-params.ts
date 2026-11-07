import { useContext } from 'hono/jsx';
import type { PagePath, PageParams } from 'void/routes';
import { ParamsContext } from './context.ts';

/**
 * Read the dynamic route params of the page being rendered.
 *
 * Pass the page's URL pattern as the type argument to type the result:
 * `useParams<'/users/:id'>()` returns `{ id: string }`. This is a type-only
 * check; the params are returned as they are.
 */
export function useParams<T extends Record<string, string> = Record<string, string>>(): T;
export function useParams<P extends PagePath>(): PageParams<P>;
export function useParams(): Record<string, string>;
export function useParams(): Record<string, string> {
  const params = useContext(ParamsContext);
  if (params === null) {
    throw new Error('useParams(): must be used inside a Void page.');
  }
  return params;
}
