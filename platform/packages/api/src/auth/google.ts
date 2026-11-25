export type GoogleUser = Readonly<{
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}>;

export function getGoogleAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: 'openid email profile',
    response_type: 'code',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCodeForToken(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) {
    throw new Error(`Google token exchange failed: ${res.status}`);
  }

  const data = await res.json<{ access_token?: string; error?: string }>();
  if (data.error || !data.access_token) {
    throw new Error(`Google token exchange error: ${data.error ?? 'no access_token'}`);
  }

  return data.access_token;
}

export async function getGoogleUser(accessToken: string): Promise<GoogleUser> {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Google user fetch failed: ${res.status}`);
  }

  const data = await res.json<{
    id: string;
    email: string;
    name: string;
    verified_email: boolean;
  }>();
  return { id: data.id, email: data.email, name: data.name, emailVerified: data.verified_email };
}
