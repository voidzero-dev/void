import { Link, useRouter } from '@void/react';
import { lazy, Suspense, useEffect, useRef } from 'react';
import type { Props } from './[slug].server.ts';

function Note() {
  return <p data-testid="lazy-note">Lazy note</p>;
}

// Loads late in the browser, so its boundary is still dehydrated after the page hydrates.
const LazyNote = lazy(async () => {
  if (typeof window !== 'undefined') {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { default: Note };
});

export default function RouterUrlPage({ title }: Props) {
  const router = useRouter();
  const { pathname, search, hash } = router.url;
  const href = pathname + search + hash;
  // The server never sees the hash, so write the whole URL only after hydration.
  const urlRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    urlRef.current!.textContent = href;
  }, [href]);
  const mountRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    mountRef.current!.textContent = router.url.search;
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- reads the router once, on mount
  }, []);

  return (
    <div>
      <h1 data-testid="router-url-title">{title}</h1>
      <p data-testid="router-path">{pathname + search}</p>
      <p data-testid="router-url" ref={urlRef} />
      <p data-testid="router-mount-search" ref={mountRef} />
      <Link href="#details">Details</Link> | <Link href={pathname + '?foo=two'}>Query two</Link>
      <Suspense fallback={<p data-testid="lazy-fallback">Loading</p>}>
        <LazyNote />
      </Suspense>
    </div>
  );
}
