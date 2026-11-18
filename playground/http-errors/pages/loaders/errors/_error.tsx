import type { ErrorPageProps } from '@void/react';

export default function NestedError({ error }: ErrorPageProps) {
  return (
    <section>
      <h1>Nested error boundary</h1>
      <p>
        {error.status}: {error.message}
      </p>
    </section>
  );
}
