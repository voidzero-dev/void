import { Link, useShared } from '@void/react';

export default function Layout({ children }: { children: React.ReactNode }) {
  const shared = useShared();
  return (
    <div>
      <nav>
        <Link href="/" prefetch>
          Home
        </Link>{' '}
        |{' '}
        <Link href="/users" activeMatch="prefix" prefetch>
          Users
        </Link>{' '}
        |{' '}
        <Link href="/blog" prefetch>
          Blog
        </Link>{' '}
        |{' '}
        <Link href="/deferred" prefetch>
          Deferred
        </Link>{' '}
        |{' '}
        <Link href="/router-params" prefetch>
          Router Params
        </Link>{' '}
        |{' '}
        <Link href="/live" prefetch>
          Live
        </Link>{' '}
        |{' '}
        <Link href="/action-error" prefetch>
          Form Lab
        </Link>{' '}
        |{' '}
        <Link href="/client-only" prefetch>
          Client-only
        </Link>{' '}
        | <span>{shared.appName}</span>
      </nav>
      <hr />
      {children}
    </div>
  );
}
