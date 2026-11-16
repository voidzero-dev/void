/** @jsxImportSource react */

import { AuthPage } from './AuthPage.tsx';

export function LoginErrorPage({
  message,
  details = [],
  platformName,
}: {
  message: string;
  details?: ReadonlyArray<string>;
  platformName: string;
}) {
  return (
    <AuthPage platformName={platformName}>
      <div className="void-auth-status void-auth-status-error" aria-label="Error">
        !
      </div>
      <div className="void-auth-lead">
        <h1 id="void-auth-title">Login failed</h1>
        <p>{message}</p>
      </div>
      {details.map((detail) => (
        <p key={detail} className="void-auth-note">
          {detail}
        </p>
      ))}
      <a className="void-auth-button void-auth-button-primary" href="/admin/logout">
        Start a new sign-in
      </a>
    </AuthPage>
  );
}
