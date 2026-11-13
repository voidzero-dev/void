import type { ErrorPageProps } from '@void/react';

export default function RootError({ error }: ErrorPageProps) {
  return (
    <section>
      <h1>Root error boundary</h1>
      <p>
        {error.status}: {error.message}
      </p>
    </section>
  );
}
