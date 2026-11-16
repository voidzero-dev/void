import type { ErrorPageProps } from '@void/react';

export default function NotFound({ error }: ErrorPageProps) {
  return (
    <section>
      <h1>Not-found boundary</h1>
      <p>
        {error.status}: {error.message}
      </p>
    </section>
  );
}
