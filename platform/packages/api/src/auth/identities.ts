import { parsePlatformAdmissionPolicy } from '@void/platform';
import { and, eq } from 'drizzle-orm';
import { createOAuthAccount, createUser, getUserByEmail } from '../db.ts';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { getDefaultPlan, lockPlanCatalog } from '../plans.ts';
import {
  platformCompanyIdentities,
  platformLoginIdentities,
  platformLoginTests,
  users,
} from '../schema.ts';
import { getAllowlist, isSignupAllowed } from '../signup-allowlist.ts';
import { isAdminSuspended } from '../suspension.ts';
import type { User } from '../types.ts';
import {
  AuthenticationConfigurationError,
  lockAuthSettings,
  loginIdentityIssuer,
  readLoginConnection,
  readLoginRevision,
} from './configuration.ts';
import type { PlatformOidcIdentity } from './oidc.ts';
import { updateUserRevokingInheritedDestinations } from './profile.ts';
import type { CompanyIdentity } from './sessions.ts';

/** Link the independently verified company identity, never infer it from a GitHub email. */
export async function bindCompanyIdentity(
  db: Db,
  userId: string,
  identity: CompanyIdentity,
): Promise<void> {
  const [subjectOwner] = await db
    .select()
    .from(platformCompanyIdentities)
    .where(
      and(
        eq(platformCompanyIdentities.issuer, identity.issuer),
        eq(platformCompanyIdentities.subject, identity.subject),
      ),
    );
  const [userIdentity] = await db
    .select()
    .from(platformCompanyIdentities)
    .where(
      and(
        eq(platformCompanyIdentities.issuer, identity.issuer),
        eq(platformCompanyIdentities.user_id, userId),
      ),
    );
  if (
    (subjectOwner && subjectOwner.user_id !== userId) ||
    (userIdentity && userIdentity.subject !== identity.subject)
  ) {
    throw new AuthenticationConfigurationError(
      'This company identity is already bound to another account. Use account recovery to change it.',
      'identity_conflict',
    );
  }
  if (!subjectOwner) {
    await db
      .insert(platformCompanyIdentities)
      .values({ user_id: userId, issuer: identity.issuer, subject: identity.subject });
  }
}

/** Only invoke with a freshly verified external identity and browser-bound login attempt. */
export async function resolvePlatformLogin(
  db: Db,
  env: Pick<ApiEnv['Bindings'], 'PLATFORM_INSTALLATION_ID' | 'ROUTING'>,
  attempt: { connectionId: string; revision: number; generation: number },
  identity: PlatformOidcIdentity,
  companyIdentity?: CompanyIdentity,
): Promise<{ user: User; created: boolean }> {
  const result = await db.transaction(async (transaction) => {
    await lockPlanCatalog(transaction);
    const settings = await lockAuthSettings(transaction);
    const connection = await readLoginConnection(transaction, attempt.connectionId);
    if (
      !settings ||
      !connection?.enabled ||
      connection.active_revision !== attempt.revision ||
      connection.generation !== attempt.generation
    ) {
      throw new AuthenticationConfigurationError(
        'The login method changed. Start a new login.',
        'login_changed',
        401,
      );
    }
    const revision = await readLoginRevision(transaction, connection.id, attempt.revision);
    if (
      !revision ||
      identity.issuer !== loginIdentityIssuer(revision.configuration) ||
      !identity.subject
    ) {
      throw new AuthenticationConfigurationError(
        'The login identity does not match this connection.',
        'invalid_identity',
        401,
      );
    }
    if (
      settings.protection &&
      (!companyIdentity || companyIdentity.issuer !== settings.protection.teamDomain)
    ) {
      throw new AuthenticationConfigurationError(
        'A verified company identity is required.',
        'company_identity_required',
        403,
      );
    }
    const [existing] = await transaction
      .select({ user: users })
      .from(platformLoginIdentities)
      .innerJoin(users, eq(users.id, platformLoginIdentities.user_id))
      .where(
        and(
          eq(platformLoginIdentities.connection_id, connection.id),
          eq(platformLoginIdentities.issuer, identity.issuer),
          eq(platformLoginIdentities.subject, identity.subject),
        ),
      );
    let user = existing?.user;
    let created = false;
    const primaryProvider =
      connection.kind === 'github' || connection.kind === 'google'
        ? connection.kind
        : `oidc:${connection.id}`;
    if (!user) {
      // Matching email is not proof of control of an existing platform account.
      if (
        identity.emailVerified &&
        identity.email &&
        (await getUserByEmail(transaction, identity.email))
      ) {
        throw new AuthenticationConfigurationError(
          'Sign in with your existing method to link this login.',
          'identity_link_required',
        );
      }
      const admission = parsePlatformAdmissionPolicy(settings.admission);
      const allowed =
        admission.mode === 'public' ||
        (admission.mode === 'company' &&
          (admission.connections.includes(connection.id) ||
            (admission.access && !!settings.protection && !!companyIdentity))) ||
        ((admission.mode === 'restricted' || admission.mode === 'company') &&
          isSignupAllowed(
            connection.kind,
            identity.login,
            identity.emailVerified ? identity.email : null,
            await getAllowlist(env.ROUTING),
            connection.id,
            identity.subject,
          ));
      if (!allowed) {
        throw new AuthenticationConfigurationError(
          'This identity is not approved to join the platform.',
          'signup_restricted',
          403,
        );
      }
      user = await createUser(
        transaction,
        primaryProvider,
        identity.subject,
        identity.login,
        identity.emailVerified ? identity.email : null,
        'user',
        (await getDefaultPlan(transaction, env.PLATFORM_INSTALLATION_ID ? 'custom' : 'free')).id,
      );
      await transaction.insert(platformLoginIdentities).values({
        id: crypto.randomUUID(),
        user_id: user.id,
        connection_id: connection.id,
        issuer: identity.issuer,
        subject: identity.subject,
      });
      if (connection.kind === 'github' || connection.kind === 'google') {
        await createOAuthAccount(transaction, user.id, connection.kind, identity.subject);
      }
      created = true;
    }
    if (isAdminSuspended(user.suspended_reason)) {
      throw new AuthenticationConfigurationError(
        'This account is suspended.',
        'account_suspended',
        403,
      );
    }
    if (settings.protection && companyIdentity) {
      await bindCompanyIdentity(transaction, user.id, companyIdentity);
    }
    await transaction
      .update(platformLoginIdentities)
      .set({ last_authenticated_at: new Date().toISOString() })
      .where(
        and(
          eq(platformLoginIdentities.user_id, user.id),
          eq(platformLoginIdentities.connection_id, connection.id),
        ),
      );
    await transaction.insert(platformLoginTests).values({
      id: crypto.randomUUID(),
      user_id: user.id,
      connection_id: connection.id,
      revision: attempt.revision,
      issuer: identity.issuer,
      subject: identity.subject,
      login: identity.login,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    return { user, created, primaryProvider };
  });
  if (
    !result.created &&
    identity.emailVerified &&
    result.user.provider === result.primaryProvider
  ) {
    await updateUserRevokingInheritedDestinations(
      db,
      result.user.id,
      identity.login,
      result.user.email,
      identity.email,
    );
  }
  return { user: result.user, created: result.created };
}
