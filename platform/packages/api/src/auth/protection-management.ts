import {
  parsePlatformAccessProtection,
  parsePlatformAdmissionPolicy,
  platformProtectionProofMessage,
  validatePlatformAdmissionPolicy,
  type PlatformAccessProtection,
} from '@void/platform';
import { eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db.ts';
import {
  operatorSessions,
  platformAuthSettings,
  platformHumanSessions,
  platformLoginTests,
  users,
} from '../schema.ts';
import { isAdminSuspended } from '../suspension.ts';
import {
  AuthenticationConfigurationError,
  guardAuthenticationLifecycleMutation,
  lockAuthSettings,
  readEnabledLoginConnections,
} from './configuration.ts';
import { hmacVerifyState } from './hmac.ts';
import type { AuthenticationActor } from './management.ts';
import { validateHumanSession, type CompanyIdentity } from './sessions.ts';

/** The CLI verifies Cloudflare coverage using installation authority; no management token enters runtime. */
export async function verifyProtectionAuthority(input: {
  installationId?: string;
  secret?: string;
  origin: string;
  actor: AuthenticationActor;
  revision: number;
  lifecycleVersion: string;
  protection: PlatformAccessProtection | null;
  expiresAt: unknown;
  signature: unknown;
}): Promise<void> {
  const expiry = typeof input.expiresAt === 'string' ? Date.parse(input.expiresAt) : Number.NaN;
  if (
    !input.installationId ||
    !input.secret ||
    typeof input.signature !== 'string' ||
    input.signature.length > 256 ||
    !Number.isFinite(expiry) ||
    expiry <= Date.now() ||
    expiry > Date.now() + 600_000 ||
    !(await hmacVerifyState(
      platformProtectionProofMessage({
        installationId: input.installationId,
        origin: input.origin,
        userId: input.actor.userId,
        sessionId: input.actor.sessionId,
        revision: input.revision,
        lifecycleVersion: input.lifecycleVersion,
        protection: input.protection,
        expiresAt: input.expiresAt as string,
      }),
      input.signature,
      input.secret,
    ))
  ) {
    throw new AuthenticationConfigurationError(
      'Verify platform protection from the installing CLI with its recovery credentials.',
      'protection_verification_required',
      403,
    );
  }
}

export async function updatePlatformProtection(
  db: Db,
  actor: AuthenticationActor,
  input: {
    revision: number;
    installationId?: string;
    proofExpiresAt?: string;
    lifecycleVersion?: string;
    protection: PlatformAccessProtection | null;
    origins: ReadonlyArray<string>;
    verifiedIdentity?: CompanyIdentity;
  },
  dryRun = false,
): Promise<void> {
  await db.transaction(async (transaction) => {
    if (input.installationId) {
      await guardAuthenticationLifecycleMutation(transaction);
      // Read a new statement snapshot after acquiring the lock: maintenance may have committed
      // between the advisory-lock statement's snapshot and its successful acquisition.
      const lifecycle = await transaction.execute<{ lifecycle_version: string }>(sql`
        SELECT md5(COALESCE((to_jsonb(installation)->'lifecycle_manifest')::text, 'null')) AS lifecycle_version
        FROM __void_platform_installation AS installation
        WHERE singleton = true AND installation_id = ${input.installationId}
      `);
      if (lifecycle.rows[0]?.lifecycle_version !== input.lifecycleVersion) {
        throw new AuthenticationConfigurationError(
          'The installation changed after protection verification. Verify coverage again.',
          'revision_conflict',
          409,
        );
      }
    }
    const settings = await lockAuthSettings(transaction);
    if (input.proofExpiresAt && Date.parse(input.proofExpiresAt) <= Date.now()) {
      throw new AuthenticationConfigurationError(
        'Protection verification expired. Verify it again.',
        'protection_verification_required',
        403,
      );
    }
    if (!settings || settings.revision !== input.revision) {
      throw new AuthenticationConfigurationError(
        'Authentication settings changed. Verify protection again.',
        'revision_conflict',
      );
    }
    if (
      !(await validateHumanSession(
        transaction,
        {
          sub: actor.userId,
          sid: actor.sessionId,
          aud: actor.audience,
        },
        actor.companyIdentity,
      ))
    ) {
      throw new AuthenticationConfigurationError(
        'Sign in again before changing protection.',
        'reauthentication_required',
        401,
      );
    }
    const [user] = await transaction.select().from(users).where(eq(users.id, actor.userId));
    if (!user || user.role !== 'admin' || isAdminSuspended(user.suspended_reason)) {
      throw new AuthenticationConfigurationError(
        'An active administrator is required.',
        'forbidden',
        403,
      );
    }
    const protection = parsePlatformAccessProtection(input.protection);
    if (protection) {
      if (
        input.origins.length === 0 ||
        input.origins.some(
          (origin) => !protection.applications.some((application) => application.origin === origin),
        )
      ) {
        throw new AuthenticationConfigurationError(
          'Protect every API, proxy, and dashboard origin before enabling Access.',
          'invalid_protection',
          400,
        );
      }
      if (!input.verifiedIdentity || input.verifiedIdentity.issuer !== protection.teamDomain) {
        throw new AuthenticationConfigurationError(
          'Verify a company user identity through the proposed Access application.',
          'access_human_identity_required',
          403,
        );
      }
      if (
        settings.protection &&
        (actor.companyIdentity?.issuer !== input.verifiedIdentity.issuer ||
          actor.companyIdentity.subject !== input.verifiedIdentity.subject)
      ) {
        throw new AuthenticationConfigurationError(
          'The company identity changed. Reauthenticate before changing protection.',
          'company_identity_changed',
          403,
        );
      }
    }
    try {
      validatePlatformAdmissionPolicy(
        parsePlatformAdmissionPolicy(settings.admission),
        (await readEnabledLoginConnections(transaction)).map((entry) => entry.configuration),
        protection,
      );
    } catch {
      throw new AuthenticationConfigurationError(
        'Change company signup to another verified company login or restricted admission before removing Access protection.',
        'company_admission_requires_protection',
        409,
      );
    }
    if (dryRun) {
      return;
    }
    // Revoke rather than silently rebinding older sessions to a new company perimeter.
    await transaction
      .update(platformHumanSessions)
      .set({ revoked_at: new Date().toISOString() })
      .where(isNull(platformHumanSessions.revoked_at));
    await transaction.delete(operatorSessions);
    await transaction.delete(platformLoginTests);
    await transaction
      .update(platformAuthSettings)
      .set({
        protection,
        sessions_required: true,
        revision: sql`${platformAuthSettings.revision} + 1`,
      })
      .where(eq(platformAuthSettings.singleton, true));
  });
}
