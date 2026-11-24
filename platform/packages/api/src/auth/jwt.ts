import { hmacSignState, hmacVerifyState } from './hmac.ts';

export type JwtPayload = Readonly<{
  sub: string;
  login: string;
  aud: string;
  iat: number;
  exp: number;
  /**
   * Optional project scope. Present on `aud:'deploy'` tokens minted for
   * remote builds — pins the token to a single project so the deploy
   * endpoint can reject cross-project use. Absent on `aud:'api'` tokens.
   */
  project?: string;
  /**
   * Optional build binding. Present on `aud:'deploy'` tokens minted for a
   * specific remote build (CF Container or GitHub Actions) — ties the token
   * to that build's row so the deploy endpoint can reject a stale runner once
   * its build is no longer active (e.g. superseded/cancelled by a newer push
   * or run). Absent on full `aud:'api'` tokens and CI credential tokens. A
   * deploy token must carry either this or `credential`.
   */
  build?: string;
  /** Revocable project automation credential record. */
  credential?: string;
  /** Dedicated, revocable operator session; never accepted by application APIs. */
  jti?: string;
  operatorOrigin?: string;
  /** Revocable human session; never used for project-scoped build credentials. */
  sid?: string;
  /** Delegated application deployment, accepted only by the OAuth-aware runtime. */
  oauthApproval?: string;
  /** Private preview view, tied to a live connected-app grant. */
  oauthGrant?: string;
}>;

const EXPIRY_SECONDS = 30 * 24 * 60 * 60; // 30 days

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url(buffer: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(buffer));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp'>,
  secret: string,
  opts?: { ttlSeconds?: number },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const ttlSeconds = opts?.ttlSeconds ?? EXPIRY_SECONDS;
  const fullPayload: JwtPayload = {
    ...payload,
    iat: now,
    exp: now + ttlSeconds,
  };

  const header = base64url(
    encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).buffer as ArrayBuffer,
  );
  const body = base64url(encoder.encode(JSON.stringify(fullPayload)).buffer as ArrayBuffer);
  const signature = await hmacSignState(`${header}.${body}`, secret);

  return `${header}.${body}.${signature}`;
}

export async function verifyJwt(
  token: string,
  secret: string,
  expectedAud?: string,
): Promise<JwtPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const [header, body, signature] = parts;

  try {
    const valid = await hmacVerifyState(`${header}.${body}`, signature, secret);
    if (!valid) {
      return null;
    }

    const payload = JSON.parse(decoder.decode(base64urlDecode(body))) as JwtPayload;

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) {
      return null;
    }

    if (expectedAud && payload.aud !== expectedAud) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
