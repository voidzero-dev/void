import { expectTypeOf } from 'vite-plus/test';
import { type PageQuery, type PageQueryInput, type RouteQuery } from 'void/routes';
import type { VoidRouter } from '../../src/pages/client.ts';

// What .void/routes.d.ts generates for a page whose loader validates its query,
// and for one whose loader has no query schema.
declare module 'void/routes' {
  interface RoutePathMap {
    '/typed-query-payments': never;
    '/typed-query-search': never;
  }
  interface PagePathMap {
    '/typed-query-payments': never;
    '/typed-query-search': never;
  }
  interface PageQueryMap {
    '/typed-query-payments': {
      input: { status: 'paid' | 'pending'; page?: number };
      output: { status: 'paid' | 'pending'; page: number };
    };
    '/typed-query-search': { input: never; output: never };
  }
}

export function checkPageQueryTypes(): void {
  expectTypeOf<PageQueryInput<'/typed-query-payments'>>().toEqualTypeOf<{
    status: 'paid' | 'pending';
    page?: number;
  }>();
  // Reading the page gives the parsed values, so the defaulted key is present.
  expectTypeOf<PageQuery<'/typed-query-payments'>>().toEqualTypeOf<{
    status: 'paid' | 'pending';
    page: number;
  }>();
  expectTypeOf<PageQueryInput<'/typed-query-search'>>().toEqualTypeOf<RouteQuery>();
  expectTypeOf<PageQuery<'/typed-query-search'>>().toEqualTypeOf<
    Record<string, string | Array<string>>
  >();
}

export function checkDestinationQuery(router: VoidRouter): void {
  void router.visit({ pathname: '/typed-query-payments', query: { status: 'paid' } });
  // @ts-expect-error a key outside the loader's schema
  void router.visit({ pathname: '/typed-query-payments', query: { statsu: 'paid' } });
  // @ts-expect-error a value outside the loader's schema
  void router.visit({ pathname: '/typed-query-payments', query: { status: 'impossible' } });
  // @ts-expect-error the schema has a required key
  void router.visit({ pathname: '/typed-query-payments' });
  // A page without a query schema keeps accepting any query.
  void router.visit({ pathname: '/typed-query-search', query: { anything: 'goes' } });
}
