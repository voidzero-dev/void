/** @jsxImportSource react */

import { Button } from '@astryxdesign/core/Button';

/** `baseUrl` may carry a query (list filters); only `page` changes. */
function pageHref(baseUrl: string, page: number): string {
  const url = new URL(baseUrl, 'https://admin.invalid');
  url.searchParams.set('page', String(page));
  return url.pathname + url.search;
}

export function Pagination({
  page,
  totalPages,
  baseUrl,
}: {
  page: number;
  totalPages: number;
  baseUrl: string;
}) {
  if (totalPages <= 1) {
    return <></>;
  }
  return (
    <nav aria-label="Pagination" className="void-admin-pagination">
      {page > 1 ? (
        <Button href={pageHref(baseUrl, page - 1)} label="Previous" variant="secondary" />
      ) : (
        <Button label="Previous" variant="secondary" isDisabled />
      )}
      <span>
        {page} / {totalPages}
      </span>
      {page < totalPages ? (
        <Button href={pageHref(baseUrl, page + 1)} label="Next" variant="secondary" />
      ) : (
        <Button label="Next" variant="secondary" isDisabled />
      )}
    </nav>
  );
}
