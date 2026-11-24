import { platformProjectHostnames, readPlatformApplication } from '@void/platform';
import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db.ts';
import { getDomainsByProjectId } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { decryptPlatformCredential } from '../project-secrets.ts';
import { projectZeroTrust } from '../schema.ts';
import type { Project, ProjectZeroTrust } from '../types.ts';
import { resolveZeroTrustApplicationEnvironment } from './application.ts';
import { ZeroTrustCloudflareClient } from './cloudflare.ts';
import {
  ZERO_TRUST_CREDENTIAL_ID,
  zeroTrustConfigurationStatus,
  readZeroTrustConfigurationStrict,
} from './configuration.ts';
import type { ZeroTrustConfiguration } from './configuration.ts';
import { errorMessage, ZeroTrustUnavailableError } from './errors.ts';

export const MAX_ZERO_TRUST_CUSTOM_DOMAINS_PER_PROJECT = 100;

export function installationId(env: ApiEnv['Bindings']): string {
  return env.PLATFORM_INSTALLATION_ID ?? 'installation';
}

export async function applicationName(env: ApiEnv['Bindings'], suffix: string): Promise<string> {
  const installation = installationId(env);
  const identity = installation
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, '-')
    .slice(0, 32);
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(installation)),
  );
  const fingerprint = Array.from(digest.subarray(0, 8), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const nonce = crypto.randomUUID().replaceAll('-', '');
  return `void-${identity}-${fingerprint}-${nonce}-${suffix}`.slice(0, 120);
}

export async function clientForConfiguration(
  env: ApiEnv['Bindings'],
  configuration: ZeroTrustConfiguration,
): Promise<ZeroTrustCloudflareClient> {
  const token = await decryptPlatformCredential(
    env,
    installationId(env),
    ZERO_TRUST_CREDENTIAL_ID,
    configuration.credential,
  );
  return new ZeroTrustCloudflareClient(configuration.accountId, token);
}

/** Every configuration write increments the revision, so it alone identifies a snapshot. */
export function sameConfiguration(
  expected: ZeroTrustConfiguration,
  current: ZeroTrustConfiguration | null,
): current is ZeroTrustConfiguration {
  return current !== null && current.revision === expected.revision;
}

export function projectApplicationReference(row: ProjectZeroTrust, kind: 'bypass' | 'protected') {
  return kind === 'bypass'
    ? { id: row.bypass_application_id, name: row.bypass_application_name }
    : { id: row.protected_application_id, name: row.protected_application_name };
}

export async function putProjectState(
  db: DbOrTx,
  projectId: string,
  values: Partial<typeof projectZeroTrust.$inferInsert>,
): Promise<ProjectZeroTrust> {
  const [row] = await db
    .insert(projectZeroTrust)
    .values({
      project_id: projectId,
      desired_protected: values.desired_protected ?? values.effective_protected ?? false,
      effective_protected: false,
      status: 'reconciling',
      ...values,
    })
    .onConflictDoUpdate({
      target: projectZeroTrust.project_id,
      set: { ...values, updated_at: sql`now()` },
    })
    .returning();
  return row!;
}

export async function getProjectZeroTrustState(
  db: DbOrTx,
  projectId: string,
): Promise<ProjectZeroTrust | null> {
  const [row] = await db
    .select()
    .from(projectZeroTrust)
    .where(eq(projectZeroTrust.project_id, projectId))
    .limit(1);
  return row ?? null;
}

export type ProjectZeroTrustState = 'public' | 'protected' | 'reconciling' | 'error';

/** The one label shown to users: a settled row reports its protection. */
export function projectZeroTrustState(
  row: Pick<ProjectZeroTrust, 'status' | 'desired_protected'>,
): ProjectZeroTrustState {
  if (row.status !== 'ready') {
    return row.status;
  }
  return row.desired_protected ? 'protected' : 'public';
}

type PublicProjectZeroTrustState = Readonly<
  Pick<
    ProjectZeroTrust,
    'project_id' | 'desired_protected' | 'effective_protected' | 'last_error' | 'updated_at'
  > & { state: ProjectZeroTrustState }
>;

export function publicProjectZeroTrustState(
  row: ProjectZeroTrust | null,
): PublicProjectZeroTrustState | null {
  if (!row) {
    return null;
  }
  return {
    project_id: row.project_id,
    desired_protected: row.desired_protected,
    effective_protected: row.effective_protected,
    state: projectZeroTrustState(row),
    last_error: row.last_error,
    updated_at: row.updated_at,
  };
}

/** The user-facing project shape plus the handles only platform operators see. */
export function operatorProjectZeroTrustState(row: ProjectZeroTrust | null) {
  if (!row) {
    return null;
  }
  return {
    ...publicProjectZeroTrustState(row)!,
    bypass_application_id: row.bypass_application_id,
    bypass_application_name: row.bypass_application_name,
    protected_application_id: row.protected_application_id,
    protected_application_name: row.protected_application_name,
    protected_application_audience: row.protected_application_audience,
    routing_cursor: row.routing_cursor,
    reconciled_operation: row.reconciled_operation,
    created_at: row.created_at,
  };
}

/** Project protection can change only on a ready installation with no running operation. */
export function projectZeroTrustAvailable(configuration: ZeroTrustConfiguration | null): boolean {
  return (
    !!configuration?.enabled &&
    zeroTrustConfigurationStatus(configuration) === 'ready' &&
    !!configuration.wildcardApplication
  );
}

export async function updateProjectState(
  db: DbOrTx,
  projectId: string,
  values: Partial<typeof projectZeroTrust.$inferInsert>,
): Promise<ProjectZeroTrust> {
  const [row] = await db
    .update(projectZeroTrust)
    .set({ ...values, updated_at: sql`now()` })
    .where(eq(projectZeroTrust.project_id, projectId))
    .returning();
  if (!row) {
    throw new ZeroTrustUnavailableError('Project is unavailable.');
  }
  return row;
}

export async function projectDestinations(
  env: ApiEnv['Bindings'],
  db: Db,
  project: Pick<Project, 'id' | 'slug'>,
  protectedProject: boolean,
  verifiedDomainId?: string,
): Promise<{ platform: ReadonlyArray<string>; custom: ReadonlyArray<string> }> {
  const application = readPlatformApplication(
    await resolveZeroTrustApplicationEnvironment(env, db),
  );
  const platform = [...new Set(platformProjectHostnames(project, application))];
  const reserved = new Set(
    [env.AUTH_REDIRECT_URI, env.PROXY_URL, env.EMAIL_GATEWAY_ORIGIN].flatMap((value) =>
      !!value && URL.canParse(value) ? [new URL(value).hostname.toLowerCase()] : [],
    ),
  );
  const checkHostnames = (values: ReadonlyArray<string>) => {
    if (values.some((hostname) => reserved.has(hostname.toLowerCase()))) {
      throw new ZeroTrustUnavailableError(
        'The project hostname overlaps a platform API, proxy, or email endpoint. Choose another hostname.',
      );
    }
  };
  checkHostnames(platform);
  if (
    !protectedProject &&
    !(await readZeroTrustConfigurationStrict(db))?.managePublicCustomDomains
  ) {
    return { platform, custom: [] };
  }
  const custom = [
    ...new Set(
      (await getDomainsByProjectId(db, project.id))
        // Public rules must never authorize an unverified hostname. Activation passes
        // its freshly verified domain while the durable row is still pending.
        .filter(
          (domain) =>
            protectedProject || domain.status === 'active' || domain.id === verifiedDomainId,
        )
        .map((domain) => domain.hostname),
    ),
  ];
  if (custom.length > MAX_ZERO_TRUST_CUSTOM_DOMAINS_PER_PROJECT) {
    throw new ZeroTrustUnavailableError(
      `Project Zero Trust supports at most ${MAX_ZERO_TRUST_CUSTOM_DOMAINS_PER_PROJECT} custom domains per project.`,
    );
  }
  checkHostnames(custom);
  return { platform, custom };
}

/**
 * A removed custom domain stays in the project's custom domain application
 * until reconciliation rewrites it. Call this in the transaction that deletes
 * the domain: a settled row then reads as pending, so hourly maintenance
 * repairs the application even if the follow-up reconciliation never runs.
 */
export async function markProjectCustomDomainsChanged(
  db: DbOrTx,
  projectId: string,
): Promise<void> {
  await db
    .update(projectZeroTrust)
    .set({ status: 'reconciling', updated_at: sql`now()` })
    .where(
      and(
        eq(projectZeroTrust.project_id, projectId),
        eq(projectZeroTrust.status, 'ready'),
        or(
          isNotNull(projectZeroTrust.protected_application_id),
          isNotNull(projectZeroTrust.protected_application_name),
        ),
      ),
    );
}

export async function markProjectError(
  db: DbOrTx,
  projectId: string,
  error: unknown,
): Promise<void> {
  await db
    .update(projectZeroTrust)
    .set({ status: 'error', last_error: errorMessage(error), updated_at: sql`now()` })
    .where(eq(projectZeroTrust.project_id, projectId));
}

/**
 * Like markProjectError, but leaves rows that settled since the failure alone.
 * A project whose first checkpoint failed has no row yet. Record the failure
 * with its initial protection so its next retry waits behind other pending
 * projects instead of being picked first again.
 */
export async function markPendingProjectError(
  db: Db,
  projectId: string,
  error: unknown,
  initialProtection: boolean,
): Promise<void> {
  const lastError = errorMessage(error);
  await db
    .insert(projectZeroTrust)
    .values({
      project_id: projectId,
      desired_protected: initialProtection,
      effective_protected: false,
      status: 'error',
      last_error: lastError,
    })
    .onConflictDoUpdate({
      target: projectZeroTrust.project_id,
      set: { status: 'error', last_error: lastError, updated_at: sql`now()` },
      setWhere: sql`${projectZeroTrust.status} <> 'ready'`,
    });
}

/**
 * Initial protection for a project that has no row yet. Projects that existed
 * when an enabling configure operation started follow its existing-project
 * choice; every later project follows the default for new projects.
 */
export function initialProjectProtection(
  configuration: ZeroTrustConfiguration,
  project: Pick<Project, 'created_at'> & Partial<Pick<Project, 'preview_client_id'>>,
): boolean {
  // These origins have their own live OAuth grant gate at dispatch. The client
  // preview permission authorizes this exception, not public application data.
  if (project.preview_client_id) {
    return false;
  }
  const operation = configuration.operation;
  return operation?.kind === 'configure' &&
    operation.existingProjects !== null &&
    Date.parse(project.created_at) <= Date.parse(operation.startedAt)
    ? operation.existingProjects === 'protected'
    : configuration.protectNewProjects;
}
