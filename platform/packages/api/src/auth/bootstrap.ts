import { parsePlatformAuthenticationSetup, PLATFORM_AUTH_SETUP_PROOF_PREFIX } from '@void/platform';
import type { PlatformAuthenticationSetup } from '@void/platform';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { createOAuthAccount, createUser } from '../db.ts';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { getDefaultPlan, lockPlanCatalog } from '../plans.ts';
import { encryptPlatformCredential } from '../project-secrets.ts';
import {
  platformAuthAttempts,
  platformAuthBootstrap,
  platformAuthSettings,
  platformLoginConnections,
  platformLoginIdentities,
  platformLoginRevisions,
  operatorEvents,
  users,
} from '../schema.ts';
import {
  AuthenticationConfigurationError,
  lockAuthSettings,
  loginIdentityIssuer,
  readLoginConnection,
  readLoginRevision,
} from './configuration.ts';
import { bindCompanyIdentity } from './identities.ts';
import type { PlatformOidcIdentity } from './oidc.ts';
import { hashLoginProof, randomLoginProof } from './proofs.ts';
import { createHumanSession } from './sessions.ts';
import type { CompanyIdentity } from './sessions.ts';

export const AUTH_SETUP_PROOF_PREFIX = PLATFORM_AUTH_SETUP_PROOF_PREFIX;
const SETUP_SECONDS = 30 * 60;

export function requireUncachedAuthenticationDatabase(
  env: Pick<ApiEnv['Bindings'], 'PLATFORM_AUTH_DATABASE_UNCACHED'>,
): void {
  if (env.PLATFORM_AUTH_DATABASE_UNCACHED !== 'true') {
    throw new AuthenticationConfigurationError(
      'Platform authentication requires an uncached database connection. Upgrade the installed platform or configure cache-disabled Hyperdrive for this source runtime.',
      'auth_database_cache_enabled',
      503,
    );
  }
}

export async function pendingAuthenticationSetup(db: Db) {
  const [pending] = await db
    .select()
    .from(platformAuthBootstrap)
    .where(
      and(eq(platformAuthBootstrap.singleton, true), isNull(platformAuthBootstrap.consumed_at)),
    );
  return pending ?? null;
}

/** Completed idempotent replays are governed by current perimeter protection. */
export async function isCompletedAuthenticationSetupReplay(
  db: Db,
  setup: PlatformAuthenticationSetup,
): Promise<boolean> {
  const { resetPending: _, ...configuration } = setup;
  const requestHash = await hashLoginProof(JSON.stringify(configuration));
  const [completed] = await db
    .select({ singleton: platformAuthBootstrap.singleton })
    .from(platformAuthBootstrap)
    .where(
      and(
        eq(platformAuthBootstrap.singleton, true),
        eq(platformAuthBootstrap.request_hash, requestHash),
        isNotNull(platformAuthBootstrap.consumed_at),
      ),
    );
  return !!completed;
}

export async function initializeAuthentication(
  db: Db,
  env: ApiEnv['Bindings'],
  input: unknown,
  apiOrigin: string,
): Promise<{ setupPending: boolean; expiresAt: string | null }> {
  requireUncachedAuthenticationDatabase(env);
  if (!env.PLATFORM_INSTALLATION_ID) {
    throw new AuthenticationConfigurationError(
      'Authentication setup requires an installation identity.',
      'invalid_installation',
      403,
    );
  }
  let setup: PlatformAuthenticationSetup;
  try {
    setup = parsePlatformAuthenticationSetup(input);
  } catch (error) {
    throw new AuthenticationConfigurationError(
      error instanceof Error ? error.message : 'Invalid authentication setup.',
      'invalid_argument',
      400,
    );
  }
  if (setup.protection) {
    if (!env.PROXY_URL) {
      throw new AuthenticationConfigurationError(
        'Access protection requires the platform proxy origin.',
        'invalid_protection',
        400,
      );
    }
    const requiredOrigins = [apiOrigin, new URL(env.PROXY_URL).origin];
    if (
      requiredOrigins.some(
        (origin) =>
          !setup.protection!.applications.some((application) => application.origin === origin),
      )
    ) {
      throw new AuthenticationConfigurationError(
        'Access protection must include the platform API and proxy origins.',
        'invalid_protection',
        400,
      );
    }
  }
  const { resetPending: _, ...configuration } = setup;
  const requestHash = await hashLoginProof(JSON.stringify(configuration));
  return db.transaction(async (transaction) => {
    await lockPlanCatalog(transaction);
    const claim = await transaction.execute<{ installation_id: string }>(
      sql`SELECT installation_id FROM __void_platform_installation WHERE singleton = true`,
    );
    if (claim.rows[0]?.installation_id !== env.PLATFORM_INSTALLATION_ID) {
      throw new AuthenticationConfigurationError(
        'The database belongs to another installation.',
        'invalid_installation',
        403,
      );
    }
    const settings = await lockAuthSettings(transaction);
    await transaction.execute(sql`LOCK TABLE ${users} IN SHARE ROW EXCLUSIVE MODE`);
    const [existingUser] = await transaction.select({ id: users.id }).from(users).limit(1);
    const [previous] = await transaction
      .select()
      .from(platformAuthBootstrap)
      .where(eq(platformAuthBootstrap.singleton, true));
    if (previous?.installation_id && previous.installation_id !== env.PLATFORM_INSTALLATION_ID) {
      throw new AuthenticationConfigurationError(
        'The setup belongs to another installation.',
        'invalid_installation',
        403,
      );
    }
    if (previous?.request_hash === requestHash) {
      return {
        setupPending: !previous.consumed_at,
        expiresAt: previous.consumed_at ? null : previous.expires_at,
      };
    }
    if (existingUser || previous?.consumed_at || (settings && !setup.resetPending)) {
      throw new AuthenticationConfigurationError(
        'Authentication is already initialized. Use authenticated configuration commands to change it.',
        'already_initialized',
      );
    }
    if (settings) {
      // Explicit owner-authorized reset is only possible before the first user exists.
      await transaction.delete(platformAuthAttempts);
      await transaction.delete(platformAuthBootstrap);
      await transaction.delete(platformLoginRevisions);
      await transaction.delete(platformLoginConnections);
      await transaction.delete(platformAuthSettings);
    }
    await transaction.insert(platformAuthSettings).values({
      admission: setup.admission,
      protection: setup.protection,
      sessions_required: true,
    });
    for (const entry of setup.connections) {
      const id = entry.configuration.id;
      const secret = await encryptPlatformCredential(
        env,
        env.PLATFORM_INSTALLATION_ID,
        JSON.stringify([id, 1]),
        entry.clientSecret,
      );
      await transaction
        .insert(platformLoginConnections)
        .values({ id, kind: entry.configuration.kind });
      await transaction
        .insert(platformLoginRevisions)
        .values({ connection_id: id, revision: 1, configuration: entry.configuration, secret });
    }
    const expiresAt = new Date(Date.now() + SETUP_SECONDS * 1000).toISOString();
    await transaction.insert(platformAuthBootstrap).values({
      installation_id: env.PLATFORM_INSTALLATION_ID,
      request_hash: requestHash,
      credential_hash: setup.bootstrapCredentialHash,
      connection_id: setup.administratorConnectionId,
      expires_at: expiresAt,
    });
    await transaction.insert(operatorEvents).values({
      id: crypto.randomUUID(),
      user_id: `installation:${env.PLATFORM_INSTALLATION_ID}`,
      login: 'Installer',
      action: 'auth.bootstrap.initialize',
      target: JSON.stringify({ connectionId: setup.administratorConnectionId }),
      status: 'success',
      http_status: 200,
    });
    return { setupPending: true, expiresAt };
  });
}

export async function verifyBootstrapCode(
  db: Db,
  installationId: string | undefined,
  code: string,
) {
  const pending = await pendingAuthenticationSetup(db);
  if (
    !pending ||
    !installationId ||
    pending.installation_id !== installationId ||
    Date.parse(pending.expires_at) <= Date.now() ||
    !/^[a-f0-9]{64}$/.test(code) ||
    (await hashLoginProof(code)) !== pending.credential_hash
  ) {
    throw new AuthenticationConfigurationError(
      'The setup code is invalid or expired. Resume setup from the installing CLI.',
      'invalid_setup_code',
      403,
    );
  }
  return pending;
}

export async function stageBootstrapIdentity(
  db: Db,
  input: {
    installationId: string;
    credentialHash: string;
    connectionId: string;
    revision: number;
    generation: number;
    identity: PlatformOidcIdentity;
    companyIdentity?: CompanyIdentity;
  },
): Promise<string> {
  return db.transaction(async (transaction) => {
    const settings = await lockAuthSettings(transaction);
    const pending = await pendingAuthenticationSetup(transaction);
    const connection = pending
      ? await readLoginConnection(transaction, pending.connection_id)
      : null;
    const revision = connection
      ? await readLoginRevision(transaction, connection.id, input.revision)
      : null;
    if (
      !settings ||
      !pending ||
      pending.installation_id !== input.installationId ||
      pending.credential_hash !== input.credentialHash ||
      pending.connection_id !== input.connectionId ||
      !revision ||
      loginIdentityIssuer(revision.configuration) !== input.identity.issuer ||
      !input.identity.subject ||
      Date.parse(pending.expires_at) <= Date.now() ||
      !connection ||
      connection.revision !== input.revision ||
      connection.generation !== input.generation ||
      (settings.protection &&
        (!input.companyIdentity || input.companyIdentity.issuer !== settings.protection.teamDomain))
    ) {
      throw new AuthenticationConfigurationError(
        'Setup changed or expired. Start again with the installing CLI.',
        'setup_changed',
        409,
      );
    }
    const proof = randomLoginProof();
    await transaction
      .update(platformAuthBootstrap)
      .set({
        claim_hash: await hashLoginProof(proof),
        pending_identity: {
          revision: input.revision,
          generation: input.generation,
          identity: input.identity,
          companyIdentity: input.companyIdentity,
          expiresAt: new Date(
            Math.min(Date.parse(pending.expires_at), Date.now() + 5 * 60 * 1000),
          ).toISOString(),
        },
      })
      .where(eq(platformAuthBootstrap.singleton, true));
    return proof;
  });
}

export async function confirmBootstrapIdentity(
  db: Db,
  env: ApiEnv['Bindings'],
  proof: string,
  companyIdentity?: CompanyIdentity,
) {
  requireUncachedAuthenticationDatabase(env);
  return db.transaction(async (transaction) => {
    await lockPlanCatalog(transaction);
    const settings = await lockAuthSettings(transaction);
    await transaction.execute(sql`LOCK TABLE ${users} IN SHARE ROW EXCLUSIVE MODE`);
    const pending = await pendingAuthenticationSetup(transaction);
    const claim = pending?.pending_identity;
    const connection = pending
      ? await readLoginConnection(transaction, pending.connection_id)
      : null;
    const [existing] = await transaction.select({ id: users.id }).from(users).limit(1);
    if (
      !settings ||
      !pending ||
      !claim ||
      !connection ||
      existing ||
      pending.installation_id !== env.PLATFORM_INSTALLATION_ID ||
      !/^[a-f0-9]{64}$/.test(proof) ||
      pending.claim_hash !== (await hashLoginProof(proof)) ||
      Date.parse(claim.expiresAt) <= Date.now() ||
      Date.parse(pending.expires_at) <= Date.now() ||
      connection.revision !== claim.revision ||
      connection.generation !== claim.generation ||
      claim.companyIdentity?.issuer !== companyIdentity?.issuer ||
      claim.companyIdentity?.subject !== companyIdentity?.subject ||
      (settings.protection && companyIdentity?.issuer !== settings.protection.teamDomain)
    ) {
      throw new AuthenticationConfigurationError(
        'The administrator setup claim is invalid, expired, or already used.',
        'invalid_setup_claim',
        403,
      );
    }
    const identity = claim.identity;
    const provider =
      connection.kind === 'github' || connection.kind === 'google'
        ? connection.kind
        : `oidc:${connection.id}`;
    const user = await createUser(
      transaction,
      provider,
      identity.subject,
      identity.login,
      identity.emailVerified ? identity.email : null,
      'admin',
      (await getDefaultPlan(transaction, 'custom')).id,
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
    if (companyIdentity) {
      await bindCompanyIdentity(transaction, user.id, companyIdentity);
    }
    await transaction
      .update(platformLoginConnections)
      .set({ enabled: true, active_revision: claim.revision })
      .where(eq(platformLoginConnections.id, connection.id));
    await transaction
      .update(platformAuthBootstrap)
      .set({ consumed_at: new Date().toISOString(), claim_hash: null, pending_identity: null })
      .where(eq(platformAuthBootstrap.singleton, true));
    await transaction.insert(operatorEvents).values({
      id: crypto.randomUUID(),
      user_id: user.id,
      login: user.login,
      action: 'auth.bootstrap.confirm',
      target: JSON.stringify({ connectionId: connection.id, userId: user.id }),
      status: 'success',
      http_status: 200,
    });
    return createHumanSession(transaction, env.JWT_SECRET, {
      userId: user.id,
      connectionId: connection.id,
      revision: claim.revision,
      generation: claim.generation,
      audience: 'admin',
      companyIdentity,
    });
  });
}
