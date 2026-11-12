import type { ReactNode } from 'react';

export default function LoaderErrorLayout({ children }: { children: ReactNode }) {
  return (
    <section>
      <p>Nested layout for HTTP exception examples.</p>
      {children}
    </section>
  );
}
