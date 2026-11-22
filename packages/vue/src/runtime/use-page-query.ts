import type { PagePath, PageQuery } from 'void/routes';
import { useRouter } from './use-router.ts';

/**
 * Read the query of the page being rendered, as the page loader's `query`
 * schema validated it: defaults are applied and coercions are done. A page
 * without a query schema returns the request's raw query values.
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
