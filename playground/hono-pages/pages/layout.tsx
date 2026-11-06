import { Link, useShared } from '@void/hono';
import type { Child } from 'hono/jsx';

export default function Layout(props: { children?: Child }) {
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
