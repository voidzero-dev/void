import type { PagePath, PageQuery } from 'void/routes';
import { useRouter } from './use-router.ts';

/**
 * Read the query of the page being rendered. By default these are the
 * request's raw query strings, repeated keys as arrays. A page whose server
 * file sets `export const exposeQuery = true` gets the values its `query`
 * schema validated instead, with defaults and coercions applied.
 *
 * Pass the page's URL pattern as the type argument to type the result:
 * `usePageQuery<'/admin/payments'>()` returns `{ status: 'paid' | 'pending' }`.
 * This is a type-only check; the values are returned as they are.
 */
export function usePageQuery<T extends Record<string, unknown> = Record<string, unknown>>(): T;
export function usePageQuery<P extends PagePath>(): PageQuery<P>;
export function usePageQuery(): Record<string, unknown>;
export function usePageQuery(): Record<string, unknown> {
  return useRouter()._pageQuery;
}
