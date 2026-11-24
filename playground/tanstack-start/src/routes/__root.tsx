import { HeadContent, Link, Scripts, createRootRoute } from '@tanstack/react-router';
import * as React from 'react';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- HTML declares the canonical UTF-8 encoding label.
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <nav style={{ padding: '8px', display: 'flex', gap: '16px' }}>
          <Link to="/" activeProps={{ style: { fontWeight: 'bold' } }}>
            Home
          </Link>
          <Link to="/users" activeProps={{ style: { fontWeight: 'bold' } }}>
            Users
          </Link>
        </nav>
        <hr />
        {children}
        <Scripts />
      </body>
    </html>
  );
}
