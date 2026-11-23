import { Link } from '@void/react';
import type { ReactNode } from 'react';
import './styles.css';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="example-container">
      <header>
        <nav aria-label="Playground">
          <Link href="/">Image Optimization Playground</Link>
        </nav>
      </header>
      <hr />
      <main>{children}</main>
    </div>
  );
}
