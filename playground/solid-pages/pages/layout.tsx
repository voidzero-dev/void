import { Link, useShared } from '@void/solid';
import type { JSX } from 'solid-js';

export default function Layout(props: { children: JSX.Element }) {
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
        | <span>{shared.appName}</span>
      </nav>
      <hr />
      {props.children}
    </div>
  );
}
