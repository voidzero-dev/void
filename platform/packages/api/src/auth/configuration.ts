import { parsePlatformLoginConfiguration } from '@void/platform';
import type { PlatformLoginConfiguration } from '@void/platform';
import { and, eq, sql } from 'drizzle-orm';
import { getPlatformCapabilities } from '../capabilities.ts';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { decryptPlatformCredential, encryptPlatformCredential } from '../project-secrets.ts';
import {
  oauthAccounts,
  platformAuthSettings,
  platformLoginConnections,
  platformLoginIdentities,
  platformLoginRevisions,
} from '../schema.ts';

export type LoginConnection = typeof platformLoginConnections.$inferSelect;
export type LoginRevision = typeof platformLoginRevisions.$inferSelect;
export type AuthSettings = typeof platformAuthSettings.$inferSelect;
type AuthEnvironment = Pick<
  ApiEnv['Bindings'],
  | 'PLATFORM_INSTALLATION_ID'
  | 'PLATFORM_CAPABILITIES'
  | 'GITHUB_CLIENT_ID'
  | 'GITHUB_CLIENT_SECRET'
  | 'GOOGLE_CLIENT_ID'
  | 'GOOGLE_CLIENT_SECRET'
  | 'PROJECT_SECRET_KEYS_JSON'
  | 'PROJECT_SECRET_ACTIVE_KEY_VERSION'
  | 'ROUTING'
>;

export class AuthenticationConfigurationError extends Error {
  constructor(
    message: string,
    readonly code = 'auth_configuration',
    readonly status = 409,
  ) {
    super(message);
    this.name = 'AuthenticationConfigurationError';
  }
}

export async function readAuthSettings(db: Db): Promise<AuthSettings | null> {
  const [settings] = await db
    .select()
    .from(platformAuthSettings)
    .where(eq(platformAuthSettings.singleton, true));
  return settings ?? null;
}

/** Acquire the installation lifecycle lock before any authentication state lock. */
export async function guardAuthenticationLifecycleMutation(db: Db): Promise<void> {
  const table = await db.execute<{ present: boolean }>(
    sql`SELECT to_regclass('public.__void_platform_installation') IS NOT NULL AS present`,
  );
  if (!table.rows[0]?.present) {
    return;
  }
  const lock = await db.execute<{ acquired: boolean }>(sql`
    SELECT pg_try_advisory_xact_lock(hashtextextended(
      'void-platform-lifecycle-v1:' || installation_id || ':' || ownership_nonce, 0
    )) AS acquired
    FROM __void_platform_installation
    WHERE singleton = true
  `);
  if (lock.rows[0] && lock.rows[0].acquired !== true) {
    throw new AuthenticationConfigurationError(
      'Another installation lifecycle operation is active. Finish it before changing authentication.',
      'lifecycle_busy',
      409,
    );
  }
}

/** Shared lock order for provider changes, identity linking, and administrator removal. */
export async function lockAuthSettings(db: Db): Promise<AuthSettings | null> {
  // Serialize first-time import too, when there is no singleton row to lock yet.
  await db.execute(sql`LOCK TABLE ${platformAuthSettings} IN SHARE ROW EXCLUSIVE MODE`);
  const [settings] = await db
    .select()
    .from(platformAuthSettings)
    .where(eq(platformAuthSettings.singleton, true))
    .for('update');
  return settings ?? null;
}

export function loginIdentityIssuer(config: PlatformLoginConfiguration): string {
  if (config.kind === 'github') {
    return 'https://github.com';
  }
  if (!config.issuer) {
    throw new AuthenticationConfigurationError(
      'The login provider has no issuer.',
      'invalid_argument',
      400,
    );
  }
  return config.issuer;
}

export async function readLoginRevision(
  db: Db,
  id: string,
  revision: number,
): Promise<LoginRevision | null> {
  const [row] = await db
    .select()
    .from(platformLoginRevisions)
    .where(
      and(
        eq(platformLoginRevisions.connection_id, id),
        eq(platformLoginRevisions.revision, revision),
      ),
    );
  return row ?? null;
}

export async function readLoginConnection(db: Db, id: string): Promise<LoginConnection | null> {
  const [connection] = await db
    .select()
    .from(platformLoginConnections)
    .where(eq(platformLoginConnections.id, id));
  return connection ?? null;
}

export async function readEnabledLoginConnections(
  db: Db,
): Promise<Array<{ connection: LoginConnection; configuration: PlatformLoginConfiguration }>> {
  const rows = await db
    .select({
      connection: platformLoginConnections,
      configuration: platformLoginRevisions.configuration,
    })
    .from(platformLoginConnections)
    .innerJoin(
      platformLoginRevisions,
      and(
        eq(platformLoginConnections.id, platformLoginRevisions.connection_id),
        eq(platformLoginConnections.active_revision, platformLoginRevisions.revision),
      ),
    )
    .where(eq(platformLoginConnections.enabled, true))
    .orderBy(platformLoginConnections.id);
  return rows.map((row) => ({
    ...row,
    configuration: parsePlatformLoginConfiguration(row.configuration),
  }));
}

export async function readLoginSecret(
  env: AuthEnvironment,
  revision: LoginRevision,
): Promise<string> {
  return decryptPlatformCredential(
    env,
    env.PLATFORM_INSTALLATION_ID ?? 'hosted',
    JSON.stringify([revision.connection_id, revision.revision]),
    revision.secret,
  );
}

/** Called explicitly by configuration/upgrade, never reseeds a previously initialized installation. */
export async function importLegacyAuthentication(
  db: Db,
  env: AuthEnvironment,
): Promise<AuthSettings> {
  return db.transaction(async (transaction) => {
    await guardAuthenticationLifecycleMutation(transaction);
    await lockAuthSettings(transaction);
    const signupFlag = await env.ROUTING.get('signup:enabled');
    const signupOpen =
      signupFlag === 'false' || (!env.PLATFORM_INSTALLATION_ID && signupFlag !== 'true');
    // The insert serializes concurrent first imports; its winner owns the snapshot.
    const inserted = await transaction
      .insert(platformAuthSettings)
      .values({
        singleton: true,
        admission: { mode: signupOpen ? 'public' : 'restricted' },
      })
      .onConflictDoNothing()
      .returning();
    const settings = await lockAuthSettings(transaction);
    if (!settings) {
      throw new AuthenticationConfigurationError('Platform authentication initialization failed.');
    }
    if (inserted.length === 0) {
      return settings;
    }
    const capabilities = getPlatformCapabilities(env);
    const sources = [
      {
        id: 'github' as const,
        label: 'GitHub',
        enabled: capabilities.githubOAuth,
        clientId: env.GITHUB_CLIENT_ID,
        secret: env.GITHUB_CLIENT_SECRET,
      },
      {
        id: 'google' as const,
        label: 'Google',
        enabled: capabilities.googleOAuth,
        clientId: env.GOOGLE_CLIENT_ID,
        secret: env.GOOGLE_CLIENT_SECRET,
      },
    ];
    for (const source of sources) {
      if (!source.enabled) {
        continue;
      }
      if (!source.clientId || !source.secret) {
        throw new AuthenticationConfigurationError(
          `Configure the existing ${source.label} credentials before migrating login settings.`,
        );
      }
      const configuration = parsePlatformLoginConfiguration({
        id: source.id,
        kind: source.id,
        label: source.label,
        clientId: source.clientId,
      });
      const secret = await encryptPlatformCredential(
        env,
        env.PLATFORM_INSTALLATION_ID ?? 'hosted',
        JSON.stringify([source.id, 1]),
        source.secret,
      );
      await transaction
        .insert(platformLoginConnections)
        .values({ id: source.id, kind: source.id, active_revision: 1, enabled: true });
      await transaction
        .insert(platformLoginRevisions)
        .values({ connection_id: source.id, revision: 1, configuration, secret });
      const identities = await transaction
        .select()
        .from(oauthAccounts)
        .where(eq(oauthAccounts.provider, source.id));
      for (const identity of identities) {
        await transaction.insert(platformLoginIdentities).values({
          id: crypto.randomUUID(),
          user_id: identity.user_id,
          connection_id: source.id,
          issuer: loginIdentityIssuer(configuration),
          subject: identity.provider_id,
          last_authenticated_at: new Date(0).toISOString(),
        });
      }
    }
    return settings;
  });
}

/** Persist an untested revision; current login and sessions remain unchanged. */
export async function stageLoginConfiguration(
  db: Db,
  env: AuthEnvironment,
  input: unknown,
  clientSecret: string,
  expectedRevision: number | null,
  dryRun = false,
): Promise<LoginConnection> {
  const configuration = parsePlatformLoginConfiguration(input);
  if (typeof clientSecret !== 'string' || !clientSecret.trim() || clientSecret.length > 8192) {
    throw new AuthenticationConfigurationError(
      'A client secret of at most 8192 characters is required.',
      'invalid_argument',
      400,
    );
  }
  return db.transaction(async (transaction) => {
    await guardAuthenticationLifecycleMutation(transaction);
    if (!(await lockAuthSettings(transaction))) {
      throw new AuthenticationConfigurationError(
        'Initialize platform authentication before configuring a connection.',
      );
    }
    const existing = await readLoginConnection(transaction, configuration.id);
    if ((existing?.revision ?? null) !== expectedRevision) {
      throw new AuthenticationConfigurationError(
        'Login settings changed. Reload them before retrying.',
        'revision_conflict',
      );
    }
    if (existing) {
      const current = await readLoginRevision(transaction, existing.id, existing.revision);
      if (
        !current ||
        current.configuration.kind !== configuration.kind ||
        current.configuration.issuer !== configuration.issuer ||
        ((configuration.kind === 'oidc' || configuration.kind === 'cloudflare-access') &&
          current.configuration.clientId !== configuration.clientId)
      ) {
        throw new AuthenticationConfigurationError(
          'Changing the identity namespace requires a new connection ID.',
        );
      }
    }
    const revision = (existing?.revision ?? 0) + 1;
    if (dryRun) {
      return existing
        ? { ...existing, revision }
        : {
            id: configuration.id,
            kind: configuration.kind,
            revision,
            generation: 1,
            active_revision: null,
            enabled: false,
            created_at: new Date().toISOString(),
          };
    }
    const secret = await encryptPlatformCredential(
      env,
      env.PLATFORM_INSTALLATION_ID ?? 'hosted',
      JSON.stringify([configuration.id, revision]),
      clientSecret,
    );
    const [connection] = existing
      ? await transaction
          .update(platformLoginConnections)
          .set({ revision })
          .where(eq(platformLoginConnections.id, configuration.id))
          .returning()
      : await transaction
          .insert(platformLoginConnections)
          .values({ id: configuration.id, kind: configuration.kind })
          .returning();
    await transaction
      .insert(platformLoginRevisions)
      .values({ connection_id: configuration.id, revision, configuration, secret });
    await transaction
      .update(platformAuthSettings)
      .set({ revision: sql`${platformAuthSettings.revision} + 1` })
      .where(eq(platformAuthSettings.singleton, true));
    return connection;
  });
}
