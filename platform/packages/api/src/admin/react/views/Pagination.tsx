/** @jsxImportSource react */

import { Button } from '@astryxdesign/core/Button';

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
        <Button href={`${baseUrl}?page=${page - 1}`} label="Previous" variant="secondary" />
      ) : (
        <Button label="Previous" variant="secondary" isDisabled />
      )}
      <span>
        {page} / {totalPages}
      </span>
      {page < totalPages ? (
        <Button href={`${baseUrl}?page=${page + 1}`} label="Next" variant="secondary" />
      ) : (
        <Button label="Next" variant="secondary" isDisabled />
      )}
    </nav>
  );
}
