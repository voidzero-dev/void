import { Link } from '@void/react';
import { useState } from 'react';
import type { ReactNode } from 'react';

export default function Layout({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);

  return (
    <div>
      <nav>
        <Link href="/" prefetch>
          Home
        </Link>{' '}
        |{' '}
        <Link href="/about" prefetch>
          About
        </Link>{' '}
        | <Link href="/legacy">Legacy</Link> | <Link href="/external-legacy">External Legacy</Link>{' '}
        |{' '}
        <button type="button" onClick={() => setCount((value) => value + 1)}>
          Layout count: {count}
        </button>
      </nav>
      <hr />
      {children}
    </div>
  );
}
