import { Link } from '@void/react';
import type { ReactNode } from 'react';
import './styles.css';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="example-container">
      <header>
        <nav aria-label="Playground">
          <Link href="/">ImageResponse Playground</Link> |{' '}
          <a href="https://void.cloud/guide/image-generation">ImageResponse guide</a>
        </nav>
      </header>
      <hr />
      <main>{children}</main>
    </div>
  );
}
