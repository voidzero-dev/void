/** @jsxImportSource @voidcloud/api/admin-jsx */

import { LayerProvider } from '@astryxdesign/core/Layer';
import { LinkProvider } from '@astryxdesign/core/Link';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { Link, useShared } from '@void/react';
import { useMemo, type ReactNode } from 'react';
import { FateClient } from 'react-fate';
import { createAdminFateClient } from '../fate/client.ts';
import { AdminFateErrorBoundary } from './AdminFateErrorBoundary.tsx';

type AdminShared = {
  platformName?: string;
  adminFateSession?: string;
  adminFateSnapshot?: Parameters<ReturnType<typeof createAdminFateClient>['hydrate']>[0];
  adminPageUrl?: string;
};

/** Appearance and navigation work in both a page and its Suspense fallback. */
export function AdminUiProviders({ children }: { children: ReactNode }) {
  return (
    <Theme theme={neutralTheme}>
      <div className="void-admin-toast-provider">
        <LayerProvider toast={{ position: 'topEnd', maxVisible: 3 }}>
          <LinkProvider component={Link}>{children}</LinkProvider>
        </LayerProvider>
      </div>
    </Theme>
  );
}

export function AdminProviders({ children }: { children: ReactNode }) {
  const shared = useShared<AdminShared>();
  const session = shared.adminFateSession ?? 'guest';
  const fate = useMemo(() => {
    const client = createAdminFateClient({
      url: typeof window === 'undefined' ? 'http://localhost/admin/fate' : '/admin/fate',
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          credentials: 'same-origin',
        }).then((response) => {
          if (response.redirected && new URL(response.url).pathname === '/admin/login') {
            window.location.assign('/admin/login');
            throw new Error('Administrator session expired.');
          }
          return response;
        }),
    });
    if (shared.adminFateSnapshot) {
      client.hydrate(shared.adminFateSnapshot);
    }
    return client;
    // The snapshot bootstraps SSR once; a client survives navigations until the session changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);
  return (
    <AdminUiProviders>
      <FateClient client={fate} key={session}>
        <AdminFateErrorBoundary
          key={shared.adminPageUrl}
          platformName={shared.platformName ?? 'Void Platform'}
        >
          {children}
        </AdminFateErrorBoundary>
      </FateClient>
    </AdminUiProviders>
  );
}
