import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db.ts';
import {
  platformHumanSessions,
  platformLoginConnections,
  platformLoginIdentities,
  platformLoginTests,
  users,
} from '../schema.ts';
import { isAdminSuspended } from '../suspension.ts';
import {
  AuthenticationConfigurationError,
  lockAuthSettings,
  readAuthSettings,
  readLoginConnection,
} from './configuration.ts';
import type { AuthSettings } from './configuration.ts';
import type { CompanyIdentity } from './identity-types.ts';
import { signJwt } from './jwt.ts';
import type { JwtPayload } from './jwt.ts';
export type { CompanyIdentity } from './identity-types.ts';
export type PlatformHumanSession = typeof platformHumanSessions.$inferSelect;

/** Called only after authenticating and linking the external identity. */
export async function createHumanSession(
  db: Db,
  signingSecret: string,
  input: {
    userId: string;
    connectionId: string;
    revision: number;
    generation: number;
    audience: 'api' | 'admin';
    companyIdentity?: CompanyIdentity;
  },
): Promise<{ token: string; session: PlatformHumanSession }> {
  return db.transaction(async (transaction) => {
    const settings = await lockAuthSettings(transaction);
    const connection = await readLoginConnection(transaction, input.connectionId);
    if (
      !settings ||
      !connection?.enabled ||
      connection.active_revision !== input.revision ||
      connection.generation !== input.generation
    ) {
      throw new AuthenticationConfigurationError(
        'The login method changed. Start a new login.',
        'login_changed',
        401,
      );
    }
    const [user] = await transaction.select().from(users).where(eq(users.id, input.userId));
    const [identity] = await transaction
      .select()
      .from(platformLoginIdentities)
      .where(
        and(
          eq(platformLoginIdentities.user_id, input.userId),
          eq(platformLoginIdentities.connection_id, connection.id),
        ),
      );
    if (
      !user ||
      !identity ||
      isAdminSuspended(user.suspended_reason) ||
      (input.audience === 'admin' && user.role !== 'admin')
    ) {
      throw new AuthenticationConfigurationError(
        'This identity cannot start a platform session.',
        'forbidden',
        403,
      );
    }
    if (
      settings.protection &&
      (!input.companyIdentity || input.companyIdentity.issuer !== settings.protection.teamDomain)
    ) {
      throw new AuthenticationConfigurationError(
        'A verified company identity is required.',
        'company_identity_required',
        403,
      );
    }
    const now = Math.floor(Date.now() / 1000);
    const id = crypto.randomUUID();
    const [session] = await transaction
      .insert(platformHumanSessions)
      .values({
        id,
        user_id: user.id,
        connection_id: connection.id,
        generation: connection.generation,
        audience: input.audience,
        expires_at: new Date((now + settings.session_seconds) * 1000).toISOString(),
        access_issuer: input.companyIdentity?.issuer ?? null,
        access_subject: input.companyIdentity?.subject ?? null,
      })
      .returning();
    const token = await signJwt(
      { sub: user.id, login: user.login, aud: input.audience, sid: id },
      signingSecret,
      { ttlSeconds: settings.session_seconds },
    );
    return { token, session: session! };
  });
}

/** The caller must first verify the JWT signature, expiry, and permitted audience. */
export async function validateHumanSession(
  db: Db,
  payload: Pick<JwtPayload, 'sub' | 'aud' | 'sid'>,
  companyIdentity?: CompanyIdentity,
): Promise<boolean> {
  if (payload.aud !== 'api' && payload.aud !== 'admin') {
    return false;
  }
  if (!payload.sid) {
    // Preserve legacy installations until the coordinated session migration is activated.
    const settings = await readAuthSettings(db);
    return !settings?.sessions_required && !settings?.protection;
  }
  const sessionQuery = db
    .select({ session: platformHumanSessions, user: users, connection: platformLoginConnections })
    .from(platformHumanSessions)
    .innerJoin(
      platformLoginConnections,
      eq(platformLoginConnections.id, platformHumanSessions.connection_id),
    )
    .innerJoin(users, eq(users.id, platformHumanSessions.user_id))
    .where(
      and(
        eq(platformHumanSessions.id, payload.sid),
        eq(platformHumanSessions.user_id, payload.sub),
        eq(platformHumanSessions.audience, payload.aud),
        eq(platformLoginConnections.enabled, true),
        eq(platformHumanSessions.generation, platformLoginConnections.generation),
        isNull(platformHumanSessions.revoked_at),
        gt(platformHumanSessions.expires_at, new Date().toISOString()),
      ),
    );
  const [settings, [row]] = await Promise.all([readAuthSettings(db), sessionQuery]);
  return validHumanSessionSnapshot(payload, settings, row ?? null, companyIdentity);
}

/** Validate an uncached database snapshot; shared by session and OAuth reads. */
export function validHumanSessionSnapshot(
  payload: Pick<JwtPayload, 'sub' | 'aud' | 'sid'>,
  settings: AuthSettings | null,
  row: {
    session: PlatformHumanSession;
    user: typeof users.$inferSelect;
    connection: typeof platformLoginConnections.$inferSelect;
  } | null,
  companyIdentity?: CompanyIdentity,
): boolean {
  if (payload.aud !== 'api' && payload.aud !== 'admin') {
    return false;
  }
  if (!payload.sid) {
    return !settings?.sessions_required && !settings?.protection;
  }
  if (
    !row ||
    row.session.id !== payload.sid ||
    row.session.user_id !== payload.sub ||
    row.user.id !== payload.sub ||
    row.session.audience !== payload.aud ||
    !row.connection.enabled ||
    row.connection.id !== row.session.connection_id ||
    row.session.generation !== row.connection.generation ||
    row.session.revoked_at !== null ||
    Date.parse(row.session.expires_at) <= Date.now() ||
    isAdminSuspended(row.user.suspended_reason) ||
    (payload.aud === 'admin' && row.user.role !== 'admin')
  ) {
    return false;
  }
  if (settings?.protection) {
    return (
      !!companyIdentity &&
      companyIdentity.issuer === settings.protection.teamDomain &&
      row.session.access_issuer === companyIdentity.issuer &&
      row.session.access_subject === companyIdentity.subject
    );
  }
  return true;
}

/** Call within the settings mutation transaction, after its lockout checks. */
export async function revokeConnectionSessions(db: Db, connectionId: string): Promise<void> {
  await db.delete(platformLoginTests).where(eq(platformLoginTests.connection_id, connectionId));
  await db
    .update(platformLoginConnections)
    .set({ generation: sql`${platformLoginConnections.generation} + 1` })
    .where(eq(platformLoginConnections.id, connectionId));
  await db
    .update(platformHumanSessions)
    .set({ revoked_at: new Date().toISOString() })
    .where(
      and(
        eq(platformHumanSessions.connection_id, connectionId),
        isNull(platformHumanSessions.revoked_at),
      ),
    );
}
