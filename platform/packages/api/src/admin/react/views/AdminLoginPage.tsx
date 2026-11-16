/** @jsxImportSource react */

import { AuthPage } from './AuthPage.tsx';

export function AdminLoginPage({
  providers,
  platformName,
}: {
  providers: Array<{ id: string; label: string }>;
  platformName: string;
}) {
  return (
    <AuthPage platformName={platformName}>
      <div className="void-auth-lead">
        <h1 id="void-auth-title">Sign in to administer {platformName}</h1>
        <p>Sign in with your administrator account.</p>
      </div>
      <div className="void-auth-actions">
        {providers.map(({ id, label }, index) => (
          <a
            key={id}
            className={
              index === 0 ? 'void-auth-button void-auth-button-primary' : 'void-auth-button'
            }
            href={`/admin/login/${encodeURIComponent(id)}`}
          >
            Sign in with {label}
          </a>
        ))}
      </div>
      {providers.length === 0 && (
        <p>No administrator login methods are available. Resume setup from the installing CLI.</p>
      )}
    </AuthPage>
  );
}
