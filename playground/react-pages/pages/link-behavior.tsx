import { Link, useNavigation, useRouter } from '@void/react';
import { useEffect, useRef, useState } from 'react';
import type { Props } from './link-behavior.server.ts';

type LinkBehaviorWindow = Window & {
  __hashNavigationStarts?: number;
  __hashNavigationEnds?: number;
  __hashNavigationReady?: boolean;
  __linkOnClick?: boolean;
  __preventedClick?: boolean;
  __preventedNavigate?: boolean;
};

export default function LinkBehaviorPage({ title }: Props) {
  const [abortTestStatus, setAbortTestStatus] = useState('Not run');

  useEffect(() => {
    const linkWindow = window as LinkBehaviorWindow;
    linkWindow.__hashNavigationStarts = 0;
    linkWindow.__hashNavigationEnds = 0;
    linkWindow.__hashNavigationReady = true;
  }, []);

  const router = useRouter();
  const navigation = useNavigation();
  const previousNavigationState = useRef(navigation.state);
  const abortTestCleanupRef = useRef<() => void>(() => {});

  const runAbortNavigationTest = () => {
    const observedErrors: Array<string> = [];
    const recordError = (error: unknown) => {
      observedErrors.push(error instanceof Error ? error.message : String(error));
    };
    const onError = (event: ErrorEvent) => {
      recordError(event.error ?? event.message);
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      recordError(event.reason);
    };
    const cleanup = () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      abortTestCleanupRef.current = () => {};
    };

    abortTestCleanupRef.current();
    abortTestCleanupRef.current = cleanup;
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    setAbortTestStatus('Running...');

    void router.visit('/link-behavior?abort-slow=1');
    window.setTimeout(() => {
      void router.visit('#abort-test-complete');
    }, 50);
    window.setTimeout(() => {
      cleanup();
      setAbortTestStatus(
        observedErrors.some(
          (error) => error.includes('Navigation aborted') || error.includes('AbortError'),
        )
          ? `Failed: ${observedErrors.join(', ')}`
          : 'Passed: interrupted GET navigation did not surface an abort error.',
      );
    }, 800);
  };

  useEffect(() => {
    const linkWindow = window as LinkBehaviorWindow;
    if (previousNavigationState.current === 'idle' && navigation.state !== 'idle') {
      linkWindow.__hashNavigationStarts = (linkWindow.__hashNavigationStarts ?? 0) + 1;
    }
    if (previousNavigationState.current !== 'idle' && navigation.state === 'idle') {
      linkWindow.__hashNavigationEnds = (linkWindow.__hashNavigationEnds ?? 0) + 1;
    }
    previousNavigationState.current = navigation.state;
  }, [navigation.state]);

  return (
    <div>
      <h1>{title}</h1>
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
          data-testid="prevented-click-link"
          onClick={(event) => {
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

      <p>
        <Link href="#hash-target" data-testid="hash-link">
          Hash target
        </Link>
      </p>

      <p>
        <a href="#plain-hash-target" data-testid="plain-hash-link">
          Plain hash target
        </a>
      </p>

      <p data-testid="navigation-location">
        {router.url.pathname}
        {router.url.hash}
      </p>
      <p data-testid="navigation-state">{navigation.state}</p>

      <section>
        <h2>Aborted GET navigation check</h2>
        <button type="button" onClick={runAbortNavigationTest}>
          Run interrupted navigation check
        </button>
        <p data-testid="abort-navigation-status">{abortTestStatus}</p>
      </section>

      <section id="hash-target">
        <h2>Hash target</h2>
      </section>

      <section id="plain-hash-target">
        <h2>Plain hash target</h2>
      </section>

      <section id="abort-test-complete">
        <h2>Abort test complete</h2>
      </section>
    </div>
  );
}
