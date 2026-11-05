import { useRouter } from '@void/react';
import type { Props } from './visit-await.server.ts';

declare global {
  interface Window {
    __visitAwaitObserved?: string | null;
  }
}

export default function VisitAwaitPage({ title }: Props) {
  const router = useRouter();

  return (
    <div>
      <h1>{title}</h1>
      <button
        type="button"
        onClick={async () => {
          window.__visitAwaitObserved = null;
          await router.visit('/users', {
            resolveOn: router.query.get('resolveOn') === 'commit' ? 'commit' : undefined,
          });
          window.__visitAwaitObserved = document.querySelector('h1')?.textContent ?? '';
        }}
      >
        Visit users
      </button>
    </div>
  );
}
