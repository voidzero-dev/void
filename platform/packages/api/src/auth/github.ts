import { LoginFailure } from './login-failure.ts';
import type { LoginFailureCode } from './login-failure.ts';

/** GitHub token errors with a fix of their own; any other error is github_failed. */
const GITHUB_TOKEN_ERRORS = new Set([
  'incorrect_client_credentials',
  'redirect_uri_mismatch',
  'bad_verification_code',
  'unverified_user_email',
]);

export type GitHubUser = Readonly<{
  id: number;
  login: string;
  email: string | null;
  emailVerified: boolean;
}>;

export function getGitHubAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: 'read:user user:email',
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

export async function exchangeCodeForToken(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri?: string,
  verifier?: string,
): Promise<string> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      ...(verifier ? { code_verifier: verifier } : {}),
    }),
  });

  if (!res.ok) {
    throw new LoginFailure('github_failed', `GitHub token exchange failed: ${res.status}`);
  }

  const data = (await res.json()) as { access_token?: string; error?: string };
  if (data.error || !data.access_token) {
    throw new LoginFailure(
      data.error && GITHUB_TOKEN_ERRORS.has(data.error)
        ? (`github_${data.error}` as LoginFailureCode)
        : 'github_failed',
      `GitHub token exchange error: ${data.error ?? 'no access_token'}`,
    );
  }

  return data.access_token;
}

export async function getGitHubUser(accessToken: string): Promise<GitHubUser> {
  const [userRes, emailsRes] = await Promise.all([
    fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'void-api',
      },
    }),
    fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'void-api',
      },
    }),
  ]);

  if (!userRes.ok) {
    throw new LoginFailure('github_failed', `GitHub user fetch failed: ${userRes.status}`);
  }

  const user = (await userRes.json()) as { id: number; login: string; email: string | null };

  let email = user.email;
  let emailVerified = false;
  if (emailsRes.ok) {
    const emails = (await emailsRes.json()) as ReadonlyArray<{
      email: string;
      primary: boolean;
      verified: boolean;
    }>;
    const primary = emails.find((e) => e.primary);
    if (primary) {
      email = primary.email;
      emailVerified = primary.verified;
    }
  }

  return { id: user.id, login: user.login, email, emailVerified };
}
