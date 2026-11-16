/** @jsxImportSource react */

import { Link } from '@void/react';
import { AuthPage } from './AuthPage.tsx';
export function AdminErrorPage({
  message,
  status,
  platformName,
}: {
  message: string;
  status: number;
  platformName: string;
}) {
  return (
    <AuthPage platformName={platformName}>
      <div className="void-auth-status void-auth-status-error" aria-label="Error">
        !
      </div>
      <div className="void-auth-lead">
        <h1 id="void-auth-title">{status === 401 ? 'Sign in again' : 'Unable to continue'}</h1>
        <p>{message}</p>
      </div>
      <Link
        reloadDocument={status === 401}
        className="void-auth-button void-auth-button-primary"
        href={status === 401 ? '/admin/logout' : '/admin/'}
      >
        {status === 401 ? 'Sign in again' : 'Refresh dashboard'}
      </Link>
    </AuthPage>
  );
}
