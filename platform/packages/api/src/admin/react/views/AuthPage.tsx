/** @jsxImportSource react */

import { browserPageLogo, browserPageStyles } from '@void/platform/browser-page';
import type { ReactNode } from 'react';

export function AuthPage({
  platformName,
  children,
}: {
  platformName: string;
  children: ReactNode;
}) {
  return (
    <main className="void-auth-page">
      <style>{browserPageStyles}</style>
      <div className="void-auth-container">
        <div className="void-auth-brand">
          <span className="void-auth-logo" dangerouslySetInnerHTML={{ __html: browserPageLogo }} />
          <span className="void-auth-divider" aria-hidden="true" />
          <span>{platformName}</span>
        </div>
        <section className="void-auth-card" aria-labelledby="void-auth-title">
          {children}
        </section>
      </div>
    </main>
  );
}
