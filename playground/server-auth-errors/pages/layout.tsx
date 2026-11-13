import { Link, useNavigation, useRouter } from '@void/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { auth } from 'void/client/react';
import './styles.css';

export default function Layout({ children }: { children: ReactNode }) {
  const toastRef = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState('');
  const router = useRouter();
  const navigation = useNavigation();
  const { data: session, isPending } = auth.useSession();

  useEffect(() => {
    const toast = toastRef.current!;
    toast.showPopover();
    const timeout = window.setTimeout(() => toast.hidePopover(), 2500);
    return () => {
      window.clearTimeout(timeout);
      toast.hidePopover();
    };
  }, []);

  useEffect(() => {
    if (navigation.state !== 'idle') {
      toastRef.current?.hidePopover();
    }
  }, [navigation.state]);

  async function signOut() {
    try {
      const result = await auth.signOut();
      if (result.error) {
        throw new Error(result.error.message);
      }
      setMessage('');
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not sign out.');
    }
  }

  return (
    <div className="example-container">
      <div ref={toastRef} className="page-loaded-toast" popover="manual" role="status">
        Page loaded
      </div>
      <header>
        <nav aria-label="Example sections">
          <strong>
            <Link href="/">Server Auth Errors Example</Link>
          </strong>{' '}
          | <Link href="/#loaders">Loaders</Link> | <Link href="/#middleware">Middleware</Link> |{' '}
          <Link href="/#actions">Actions</Link> | <Link href="/#api">API route</Link>
          {!isPending && (
            <>
              {' | '}
              {session ? (
                <a
                  href="/"
                  onClick={(event) => {
                    event.preventDefault();
                    void signOut();
                  }}
                >
                  Sign out
                </a>
              ) : (
                <Link href="/login">Sign in</Link>
              )}
            </>
          )}
        </nav>
        <p role="status">{message}</p>
      </header>
      <hr />
      <main>{children}</main>
    </div>
  );
}
