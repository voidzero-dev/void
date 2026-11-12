import { Suspense, use } from 'react';
import type { Props } from './deferred.server.ts';

function Details({ details }: Props) {
  return <p>{use(details)}</p>;
}

export default function DeferredPage(props: Props) {
  return (
    <section>
      <h1>Status set before deferred streaming</h1>
      <p>Expected HTTP 429 for both the HTML document and the client navigation stream.</p>
      <Suspense fallback={<p>Waiting one second for deferred props…</p>}>
        <Details {...props} />
      </Suspense>
    </section>
  );
}
