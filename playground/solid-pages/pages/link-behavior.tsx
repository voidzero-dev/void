import { Link, useRouter } from '@void/solid';
import { ErrorBoundary, createSignal } from 'solid-js';
import type { Props } from './link-behavior.server.ts';

type LinkBehaviorWindow = Window & {
  __boundClickData?: string;
  __boundClickEventType?: string;
  __linkOnClick?: boolean;
  __preventedClick?: boolean;
  __preventedNavigate?: boolean;
};

export default function LinkBehaviorPage(props: Props) {
  const router = useRouter();
  const [prefetchMethod, setPrefetchMethod] = createSignal<'GET' | 'POST'>('GET');
  const [reloadMethod, setReloadMethod] = createSignal<'GET' | 'POST'>('GET');

  function setBoundClicked(label: string, event: MouseEvent) {
    event.preventDefault();
    const linkWindow = window as LinkBehaviorWindow;
    linkWindow.__boundClickData = label;
    linkWindow.__boundClickEventType = event.type;
  }

  return (
    <div>
      <h1>{props.title}</h1>
      <p>
        <button
          data-testid="typed-visit"
          onClick={() =>
            router.visit({ pathname: '/users/:id', params: { id: '2' }, query: { tab: 'visit' } })
          }
        >
          Typed visit
        </button>
      </p>

      <p>
        <Link
          href="/users"
          data-testid="onclick-link"
          onClick={() => {
            (window as LinkBehaviorWindow).__linkOnClick = true;
          }}
        >
          User handler then SPA
        </Link>
      </p>

      <p>
        <Link
          href="/users"
          data-testid="bound-click-link"
          onClick={[setBoundClicked, 'bound-data']}
        >
          Bound click handler
        </Link>
      </p>

      <p>
        <Link
          href="/users"
          data-testid="prevented-click-link"
          onClick={(event: MouseEvent) => {
            event.preventDefault();
            (window as LinkBehaviorWindow).__preventedClick = true;
          }}
        >
          Prevented click
        </Link>
      </p>

      <p>
        <Link
          href="/users"
          data-testid="prevented-navigate-link"
          onNavigate={(event) => {
            event.preventDefault();
            (window as LinkBehaviorWindow).__preventedNavigate = true;
          }}
        >
          Prevented navigate
        </Link>
      </p>

      <p>
        <Link href="/users" data-testid="replace-link" replace>
          Replace with users
        </Link>
      </p>

      <p>
        <Link href="/users" data-testid="reload-link" reloadDocument>
          Reload document
        </Link>
      </p>

      <p>
        <Link href="/users" data-testid="blank-link" target="_blank">
          Open users in a new tab
        </Link>
      </p>

      <p>
        <Link href="/users" data-testid="download-link" download="users.html">
          Download users
        </Link>
      </p>

      <p>
        <Link
          href="/link-behavior"
          data={{
            tag: ['a', 'b'],
            page: 2,
            active: true,
            skip: null,
            missing: undefined,
          }}
          data-testid="query-data-link"
        >
          Query data
        </Link>
      </p>

      <ErrorBoundary
        fallback={(error) => (
          <p data-testid="reactive-prefetch-error">
            {error instanceof Error ? error.message : String(error)}
          </p>
        )}
      >
        <p>
          <button
            type="button"
            data-testid="toggle-prefetch-method"
            onClick={() => setPrefetchMethod('POST')}
          >
            Make prefetch a mutation
          </button>
          <Link
            href="/users"
            method={prefetchMethod()}
            prefetch
            data-testid="reactive-prefetch-link"
          >
            Reactive prefetch link
          </Link>
        </p>
      </ErrorBoundary>

      <ErrorBoundary
        fallback={(error) => (
          <p data-testid="reactive-reload-error">
            {error instanceof Error ? error.message : String(error)}
          </p>
        )}
      >
        <p>
          <button
            type="button"
            data-testid="toggle-reload-method"
            onClick={() => setReloadMethod('POST')}
          >
            Make reload a mutation
          </button>
          <Link
            href="/users"
            method={reloadMethod()}
            reloadDocument
            data-testid="reactive-reload-link"
          >
            Reactive reload link
          </Link>
        </p>
      </ErrorBoundary>
    </div>
  );
}
