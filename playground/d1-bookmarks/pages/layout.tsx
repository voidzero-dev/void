import { Link } from '@void/react';
import type { ReactNode } from 'react';
import './styles.css';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="container">
      <header>
        <nav aria-label="Demo variants">
          <strong>
            <Link href="/">D1 Bookmark Example</Link>
          </strong>{' '}
          | <Link href="/without-bookmark">Without bookmark</Link> |{' '}
          <Link href="/with-bookmark">Manual bookmark</Link>
        </nav>
      </header>
      <hr />
      <main>{children}</main>
    </div>
  );
}
