import { Link } from '@void/react';
import { useEffect, useRef, type ReactNode } from 'react';
import './styles.css';

export default function Layout({ children }: { children: ReactNode }) {
  const toastRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const toast = toastRef.current!;
    toast.showPopover();
    const timeout = window.setTimeout(() => toast.hidePopover(), 2500);
    return () => {
      window.clearTimeout(timeout);
      toast.hidePopover();
    };
  }, []);

  return (
    <div className="example-container">
      <div ref={toastRef} className="example-page-loaded-toast" popover="manual" role="status">
        Page loaded
      </div>
      <header>
        <nav aria-label="Example sections">
          <strong>
            <Link href="/">HTTP Errors Example</Link>
          </strong>{' '}
          | <Link href="/#loaders">Loaders</Link> | <Link href="/#middleware">Middleware</Link>
        </nav>
      </header>
      <hr />
      <main>{children}</main>
    </div>
  );
}
