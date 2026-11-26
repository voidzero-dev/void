import { and, eq, isNull, sql } from 'drizzle-orm';
import { oauthNonces, authCodes } from '../schema.ts';
import type { Db } from './client.ts';

// ---------------------------------------------------------------------------
// oauth nonces
// ---------------------------------------------------------------------------

export async function storeOAuthNonce(db: Db, nonce: string, ttlSeconds: number): Promise<void> {
  await db
    .insert(oauthNonces)
    .values({ nonce, expires_at: sql`now() + ${String(ttlSeconds)} * interval '1 second'` });
}

/** Atomically consume a nonce — returns true if it existed and was not expired. */
export async function consumeOAuthNonce(db: Db, nonce: string): Promise<boolean> {
  const rows = await db
    .delete(oauthNonces)
    .where(and(eq(oauthNonces.nonce, nonce), sql`expires_at > now()`))
    .returning({ nonce: oauthNonces.nonce });
  return rows.length > 0;
}

/** Delete expired nonces left behind by abandoned login flows. */
export async function purgeExpiredOAuthNonces(db: Db): Promise<void> {
  await db.delete(oauthNonces).where(sql`expires_at <= now()`);
}

// ---------------------------------------------------------------------------
// auth codes (dashboard login code exchange)
// ---------------------------------------------------------------------------

export async function storeAuthCode(
  db: Db,
  code: string,
  jwt: string,
  ttlSeconds: number,
  options?: {
    cliState?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
  },
): Promise<void> {
  await db.insert(authCodes).values({
    code,
    jwt,
    cli_state: options?.cliState,
    code_challenge: options?.codeChallenge,
    code_challenge_method: options?.codeChallengeMethod,
    expires_at: sql`now() + ${String(ttlSeconds)} * interval '1 second'`,
  });
}

/** Atomically consume an auth code — returns the JWT if valid, null otherwise. */
export async function consumeAuthCode(db: Db, code: string): Promise<string | null> {
  const rows = await db
    .delete(authCodes)
    .where(
      and(
        eq(authCodes.code, code),
        isNull(authCodes.cli_state),
        isNull(authCodes.code_challenge),
        isNull(authCodes.code_challenge_method),
        sql`expires_at > now()`,
      ),
    )
    .returning({ jwt: authCodes.jwt });
  return rows[0]?.jwt ?? null;
}

/** Atomically consume a CLI auth code after matching its PKCE challenge. */
export async function consumeCliAuthCode(
  db: Db,
  code: string,
  state: string,
  codeChallenge: string,
  codeChallengeMethod: string,
): Promise<string | null> {
  const rows = await db
    .delete(authCodes)
    .where(
      and(
        eq(authCodes.code, code),
        eq(authCodes.cli_state, state),
        eq(authCodes.code_challenge, codeChallenge),
        eq(authCodes.code_challenge_method, codeChallengeMethod),
        sql`expires_at > now()`,
      ),
    )
    .returning({ jwt: authCodes.jwt });
  return rows[0]?.jwt ?? null;
}

/** Delete expired auth codes left behind by abandoned login flows. */
export async function purgeExpiredAuthCodes(db: Db): Promise<void> {
  await db.delete(authCodes).where(sql`expires_at <= now()`);
}
