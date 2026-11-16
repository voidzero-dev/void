import type { ErrorPageProps } from '@void/react';

export default function RootError({ error }: ErrorPageProps) {
  return (
    <section>
      <h1>Root error boundary</h1>
      <p>
        {error.status}: {error.message}
      </p>
      <p>
        Ordinary loader errors and thrown client action errors reach this boundary. On the server,
        requireAuth sends a plain-text 401 instead.
      </p>
    </section>
  );
}
