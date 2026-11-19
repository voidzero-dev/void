/**
 * The signed link to the project security page (spec §13.2, §13.5): 15 minutes, one
 * user, one project. The HMAC covers a purpose label, so a token for another feature
 * (or a login JWT) never verifies here, and this token never verifies there.
 *
 * Wire form: base64url(JSON(payload)) + '.' + base64url(HMAC-SHA256(label + body)).
 * M14 mints the link (`POST /projects/:id/security/page-link`); the page route
 * that redeems it (M19) calls `verifySecurityPageToken`.
 */
import { constantTimeEqual, hmacSignState } from '../auth/hmac.ts';

export const SECURITY_PAGE_TOKEN_TTL_SECONDS = 15 * 60;

const PURPOSE = 'void:security-page:v1';

export type SecurityPageTokenPayload = Readonly<{
  v: 1;
  /** User the link was minted for. */
  uid: string;
  /** Project the link opens. */
  pid: string;
  iat: number;
  exp: number;
}>;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string | null {
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

export async function mintSecurityPageToken(
  input: Readonly<{ userId: string; projectId: string }>,
  secret: string,
  now = Date.now(),
): Promise<Readonly<{ token: string; expiresAt: string }>> {
  if (!secret) {
    throw new Error('The signing secret is not configured.');
  }
  const iat = Math.floor(now / 1000);
  const payload: SecurityPageTokenPayload = {
    v: 1,
    uid: input.userId,
    pid: input.projectId,
    iat,
    exp: iat + SECURITY_PAGE_TOKEN_TTL_SECONDS,
  };
  const body = toBase64Url(JSON.stringify(payload));
  const signature = await hmacSignState(`${PURPOSE}.${body}`, secret);
  return { token: `${body}.${signature}`, expiresAt: new Date(payload.exp * 1000).toISOString() };
}

/** The payload of a valid, unexpired token; `null` for anything else (never throws). */
export async function verifySecurityPageToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<SecurityPageTokenPayload | null> {
  if (!secret || typeof token !== 'string') {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  const [body, signature] = parts as [string, string];
  const expected = await hmacSignState(`${PURPOSE}.${body}`, secret);
  if (!constantTimeEqual(expected, signature)) {
    return null;
  }
  const json = fromBase64Url(body);
  if (json === null) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const seconds = Math.floor(now / 1000);
  if (
    record.v !== 1 ||
    typeof record.uid !== 'string' ||
    typeof record.pid !== 'string' ||
    typeof record.iat !== 'number' ||
    typeof record.exp !== 'number' ||
    record.exp <= seconds ||
    record.iat > seconds + 60
  ) {
    return null;
  }
  return record as SecurityPageTokenPayload;
}
