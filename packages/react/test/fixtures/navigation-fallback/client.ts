import React from 'react';
import type { NavigationState, VoidRouter } from 'void/pages-client';
import { startReactPages } from '../../../src/runtime/pages-client.ts';
import { useNavigation } from '../../../src/runtime/use-navigation.ts';

declare global {
  interface Window {
    __navigationSnapshots: Array<
      Pick<NavigationState, 'state' | 'method'> & { location: string | null }
    >;
    __navigateInAction(destination: string, method: string): void;
    __finishAction?: () => void;
  }
}

window.__navigationSnapshots = [];

let router: VoidRouter;
let nextLayoutInstance = 0;

const scrollReady = new Promise<void>((resolve) => {
  (window as Window & { __resolveScrollPage?: () => void }).__resolveScrollPage = resolve;
});

function ScrollPage() {
  React.use(scrollReady);
  return React.createElement(
    'main',
    null,
    React.createElement('h1', null, 'Delayed scroll page'),
    Array.from({ length: 80 }, (_, row) =>
      React.createElement(
        'section',
        { key: row, 'data-row': row, style: { height: 120 } },
        React.createElement('a', { href: '/' }, `Leave row ${row}`),
      ),
    ),
  );
}

function useRecordNavigation() {
  const navigation = useNavigation();
  React.useLayoutEffect(() => {
    window.__navigationSnapshots.push({
      state: navigation.state,
      location: navigation.location?.href ?? null,
      method: navigation.method,
    });
  }, [navigation]);
}

function ShellLayout({ children }: { children: React.ReactNode }) {
  const [instance] = React.useState(() => ++nextLayoutInstance);
  useRecordNavigation();
  return React.createElement('div', { 'data-layout-instance': instance }, children);
}

function Home() {
  return React.createElement(
    'main',
    null,
    React.createElement('h1', null, 'Home'),
    React.createElement(
      'button',
      { onClick: () => void router.visit('/dashboard').catch(() => {}) },
      'Dashboard',
    ),
  );
}

function Dashboard() {
  return React.createElement(
    'main',
    null,
    React.createElement('h1', null, 'Dashboard loaded'),
    React.createElement(
      'button',
      { onClick: () => void router.visit('/').catch(() => {}) },
      'Home',
    ),
  );
}

function NavigationFallback() {
  useRecordNavigation();
  React.useLayoutEffect(() => {
    const state = window as Window & { __navigationFallbackMounts?: number };
    state.__navigationFallbackMounts = (state.__navigationFallbackMounts ?? 0) + 1;
  }, []);
  return React.createElement('main', null, React.createElement('h1', null, 'Loading dashboard'));
}

void startReactPages({
  components: {
    layout: async () => ({ default: ShellLayout }),
    home: async () => ({ default: Home }),
    dashboard: async () => ({ default: Dashboard }),
    scroll: async () => ({ default: ScrollPage }),
  },
  layoutTree: { home: ['layout'], dashboard: ['layout'] },
  routeMeta: {},
  matchRoute: (url) => {
    const path = new URL(url, location.origin).pathname;
    return path === '/dashboard' ? 'dashboard' : path === '/scroll.html' ? 'scroll' : 'home';
  },
  staticPageData: false,
  staticPageDataFastPath: false,
  viewTransitions: false,
  prefetchHoverDelay: 75,
  prefetchDefaultCacheFor: { stale: 0, expires: 5 * 60_000 },
  cacheVisitedPageData: true,
  navigationFallback: location.search.includes('fallback=off') ? undefined : NavigationFallback,
}).then((client) => {
  router = client.router;
  window.__navigateInAction = (destination, method) => {
    React.startTransition(async () => {
      await router.visit(destination, { method, _resolveOnShell: true });
      await new Promise<void>((resolve) => {
        window.__finishAction = resolve;
      });
    });
  };
});
