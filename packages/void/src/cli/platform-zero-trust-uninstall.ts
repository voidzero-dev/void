import { isRecord } from '@void/deploy-core';
/**
 * Uninstall turns off the platform API, and only that API can remove the
 * Cloudflare Access applications project Zero Trust created. The shared
 * project application covers every hostname under the application domain, so
 * a left-over one keeps asking for sign-in on hosts Void no longer serves.
 * Uninstall therefore reads the saved Zero Trust state straight from
 * PostgreSQL, which works whether or not the API still answers, and refuses
 * while anything remains to clean up or the state cannot be read.
 */

// Mirrors the platform setting key in platform/packages/api/src/zero-trust/configuration.ts.
const ZERO_TRUST_SETTING = 'zeroTrust.configuration';
// Mirrors lockZeroTrustConfiguration in platform/packages/api/src/zero-trust/lock.ts.
const ZERO_TRUST_LOCK = "hashtext('zero-trust:configuration')";
// Mirrors PLATFORM_UNINSTALL_SETTING in platform/packages/api/src/zero-trust/lock.ts.
const UNINSTALL_SETTING = 'platform.uninstall';
const LISTED_APPLICATIONS = 20;

export type QueryConnection = Readonly<{
  query: <Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: ReadonlyArray<unknown>,
  ) => Promise<{ rows: ReadonlyArray<Row> }>;
}>;

/** Runs an uninstall precheck read; any failure becomes the refusal `refuse` builds. */
export async function readPlatformDatabase<T>(
  read: (() => Promise<T>) | undefined,
  refuse: (reason: string) => string,
): Promise<T> {
  try {
    if (!read) {
      throw new Error('no platform database connection is available');
    }
    return await read();
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replace(
      /^platform: /,
      '',
    );
    // oxlint-disable-next-line preserve-caught-error -- Preserve the refusal message without recording provider details.
    throw new Error(refuse(reason));
  }
}

export type PlatformZeroTrustApplication = Readonly<{
  role: string;
  id: string | null;
  name: string | null;
  /** The owning project stopped partway through deletion. */
  deleting?: boolean;
}>;

export type PlatformProjectZeroTrustState = Readonly<{
  /** Zero Trust is enabled, or a configure, reconcile, or disable operation is unfinished. */
  active: boolean;
  /** Hostname patterns of the shared project application, when it is recorded. */
  destinations: ReadonlyArray<string>;
  /** Void-managed Access applications that may still exist in Cloudflare. */
  applications: ReadonlyArray<PlatformZeroTrustApplication>;
  /** Projects whose deletion stopped before it removed their applications. */
  unfinishedDeletions: ReadonlyArray<string>;
  /** Whether any platform user exists; read only while Zero Trust is active. */
  usersExist?: boolean;
}>;

type ProjectApplicationRow = Readonly<{
  project_id: string;
  project_slug?: string | null;
  project_status?: string | null;
  bypass_application_id: string | null;
  bypass_application_name: string | null;
  protected_application_id: string | null;
  protected_application_name: string | null;
}>;

function optionalText(value: unknown, label: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`the saved ${label} is malformed`);
  }
  return value;
}

function savedApplication(
  value: unknown,
  label: string,
): Readonly<{ id: string; name: string; destinations: ReadonlyArray<string> }> | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') {
    throw new Error(`the saved ${label} is malformed`);
  }
  const destinations = Array.isArray(value.destinations)
    ? value.destinations.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return { id: value.id, name: value.name, destinations };
}

/**
 * Interpret the saved configuration and project rows. Anything that does not
 * have the expected shape throws, so the caller refuses instead of guessing.
 */
export function projectZeroTrustUninstallState(
  setting: unknown,
  projectRows: ReadonlyArray<ProjectApplicationRow>,
): PlatformProjectZeroTrustState {
  const applications: Array<PlatformZeroTrustApplication> = [];
  let active = false;
  let destinations: ReadonlyArray<string> = [];
  if (setting !== null && setting !== undefined) {
    if (!isRecord(setting) || typeof setting.enabled !== 'boolean') {
      throw new Error('the saved Zero Trust configuration is malformed');
    }
    const operation = setting.operation ?? null;
    if (operation !== null && !isRecord(operation)) {
      throw new Error('the saved Zero Trust operation is malformed');
    }
    active = setting.enabled || operation !== null;
    const wildcard = savedApplication(setting.wildcardApplication, 'shared project application');
    const health = savedApplication(setting.healthApplication, 'health check exception');
    // Names are saved before the application is created, so an unfinished
    // operation may own an application whose id was never recorded.
    const wildcardName = optionalText(setting.wildcardApplicationName, 'application name');
    const healthName = optionalText(setting.healthApplicationName, 'application name');
    if (wildcard || (active && wildcardName)) {
      applications.push({
        role: 'shared project application',
        id: wildcard?.id ?? null,
        name: wildcard?.name ?? wildcardName,
      });
    }
    if (health || (active && healthName)) {
      applications.push({
        role: 'health check exception',
        id: health?.id ?? null,
        name: health?.name ?? healthName,
      });
    }
    destinations = wildcard?.destinations ?? [];
  }
  const unfinishedDeletions: Array<string> = [];
  for (const row of projectRows) {
    const deleting = row.project_status === 'deleting';
    const owned = applications.length;
    if (row.bypass_application_id || row.bypass_application_name) {
      applications.push({
        role: `public exception for ${row.project_id}`,
        id: row.bypass_application_id,
        name: row.bypass_application_name,
        ...(deleting ? { deleting } : {}),
      });
    }
    if (row.protected_application_id || row.protected_application_name) {
      applications.push({
        role: `custom domain application for ${row.project_id}`,
        id: row.protected_application_id,
        name: row.protected_application_name,
        ...(deleting ? { deleting } : {}),
      });
    }
    if (deleting && applications.length > owned) {
      unfinishedDeletions.push(row.project_slug ?? row.project_id);
    }
  }
  return { active, destinations, applications, unfinishedDeletions };
}

/** Read the project Zero Trust state from the platform database. */
export async function readPlatformProjectZeroTrustStateConnection(
  client: QueryConnection,
): Promise<PlatformProjectZeroTrustState> {
  const tables = await client.query<{ settings: boolean; projects: boolean; users?: boolean }>(
    `SELECT to_regclass('public.platform_settings') IS NOT NULL AS "settings",
            to_regclass('public.project_zero_trust') IS NOT NULL AS "projects",
            to_regclass('public.users') IS NOT NULL AS "users"`,
  );
  const present = tables.rows[0];
  if (!present) {
    throw new Error('the database did not report its Zero Trust tables');
  }
  const setting = present.settings
    ? (
        await client.query<{ value: unknown }>(
          'SELECT "value" FROM "platform_settings" WHERE "key" = $1',
          [ZERO_TRUST_SETTING],
        )
      ).rows[0]?.value
    : undefined;
  const projectRows = present.projects
    ? (
        await client.query<ProjectApplicationRow>(
          `SELECT z."project_id", p."slug" AS "project_slug", p."status" AS "project_status",
                  z."bypass_application_id", z."bypass_application_name",
                  z."protected_application_id", z."protected_application_name"
           FROM "project_zero_trust" z
           LEFT JOIN "projects" p ON p."id" = z."project_id"
           WHERE z."bypass_application_id" IS NOT NULL
              OR z."bypass_application_name" IS NOT NULL
              OR z."protected_application_id" IS NOT NULL
              OR z."protected_application_name" IS NOT NULL
           ORDER BY z."project_id"`,
        )
      ).rows
    : [];
  const state = projectZeroTrustUninstallState(setting, projectRows);
  if (!state.active) {
    return state;
  }
  const usersExist = present.users
    ? (
        await client.query<{ present: boolean }>(
          'SELECT EXISTS(SELECT 1 FROM "users") AS "present"',
        )
      ).rows[0]?.present === true
    : false;
  return { ...state, usersExist };
}

/**
 * Take the Zero Trust configuration lock exclusively on this session. Every
 * API path that records or creates a Void-managed Access application or
 * creates a project holds the same lock, so none can commit until the
 * returned release runs.
 */
export async function lockPlatformProjectZeroTrustConnection(
  client: QueryConnection,
): Promise<() => Promise<void>> {
  await client.query(`SELECT pg_advisory_lock(${ZERO_TRUST_LOCK})`);
  let released = false;
  return async () => {
    if (released) {
      return;
    }
    released = true;
    await client.query(`SELECT pg_advisory_unlock(${ZERO_TRUST_LOCK})`);
  };
}

async function hasSettingsTable(client: QueryConnection): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public.platform_settings') IS NOT NULL AS "present"`,
  );
  return result.rows[0]?.present === true;
}

/**
 * Record that uninstall passed its final check. Runs while the configuration
 * lock is held. An API request admitted before traffic was disabled may be
 * waiting on that lock; once it gets the lock it reads this record and
 * refuses. Without the settings table the API has no Zero Trust writers.
 */
export async function fencePlatformProjectZeroTrustConnection(
  client: QueryConnection,
): Promise<void> {
  if (!(await hasSettingsTable(client))) {
    return;
  }
  await client.query(
    `INSERT INTO "platform_settings" ("key", "value") VALUES ($1, $2::jsonb)
     ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updated_at" = now()`,
    [UNINSTALL_SETTING, JSON.stringify({ startedAt: new Date().toISOString() })],
  );
}

/**
 * Remove the uninstall record. Uninstall does this when it stops before
 * disabling traffic; installing or enabling does it before traffic opens.
 */
export async function liftPlatformProjectZeroTrustFenceConnection(
  client: QueryConnection,
): Promise<void> {
  if (!(await hasSettingsTable(client))) {
    return;
  }
  await client.query('DELETE FROM "platform_settings" WHERE "key" = $1', [UNINSTALL_SETTING]);
}

export function formatZeroTrustApplications(
  applications: ReadonlyArray<PlatformZeroTrustApplication>,
): string {
  const lines = applications
    .slice(0, LISTED_APPLICATIONS)
    .map(
      (application) =>
        `  ${application.role}: ${application.name ?? '(name not recorded)'}${application.id ? ` (${application.id})` : ''}`,
    );
  if (applications.length > LISTED_APPLICATIONS) {
    lines.push(`  …and ${applications.length - LISTED_APPLICATIONS} more`);
  }
  return lines.join('\n');
}

const DASHBOARD_HINT =
  'To lift sign-in right away, delete these applications in the Cloudflare dashboard under Zero Trust → Access → Applications.';

// Hourly maintenance skips projects being deleted, so only finishing the
// deletion removes their applications and records.
function unfinishedDeletionLines(state: PlatformProjectZeroTrustState): ReadonlyArray<string> {
  if (!state.unfinishedDeletions.length) {
    return [];
  }
  return [
    `Deletion of ${state.unfinishedDeletions.length === 1 ? 'project' : 'projects'} ${state.unfinishedDeletions.join(', ')} stopped before it removed their Access applications. Rerun \`void project delete <name>\` for each, or delete it again from the admin dashboard. This removes their applications, including ones already deleted in the Cloudflare dashboard, and Void's records of them.`,
  ];
}

/**
 * Refuse to uninstall while project Zero Trust still owns Access applications,
 * or while its state cannot be read. Runs before uninstall changes anything.
 * With `canTurnOff`, enabled Zero Trust on a platform no user has signed in to
 * is not refused: the applications uninstall must turn off are returned.
 */
export async function assertProjectZeroTrustAllowsUninstall(
  read: (() => Promise<PlatformProjectZeroTrustState>) | undefined,
  options: Readonly<{ canTurnOff?: boolean }> = {},
): Promise<{ turnOff: ReadonlyArray<PlatformZeroTrustApplication> } | undefined> {
  const state = await readPlatformDatabase(read, (reason) =>
    [
      `platform: Refusing to uninstall because the project Zero Trust state could not be read from the platform database: ${reason}`,
      'Uninstall turns off the platform API, which Void needs to remove the Cloudflare Access applications that project Zero Trust created.',
      'Make the installation database reachable (export VOID_PLATFORM_DATABASE_URL if this machine has not recorded it), then retry. If project Zero Trust was ever enabled, run `void platform zero-trust disable` first.',
    ].join('\n'),
  );
  if (state.active && state.usersExist === false && options.canTurnOff) {
    return { turnOff: state.applications };
  }
  if (state.active) {
    const covered = state.destinations.length
      ? ` on ${state.destinations.join(' and ')}`
      : ' on every hostname under the application domain';
    throw new Error(
      [
        'platform: Refusing to uninstall while project Zero Trust is enabled or still changing.',
        `Uninstall turns off the platform API, so Void could no longer remove its Cloudflare Access applications, and Access would keep asking for sign-in${covered}, including hostnames Void does not serve.`,
        // Without a user there is no administrator to run zero-trust disable.
        state.usersExist === false
          ? 'No platform user exists yet. Run this command on the computer that installed the platform; it keeps the authority to turn off project Zero Trust.'
          : 'Run `void platform zero-trust disable`, rerun it until `void platform zero-trust status` reports Zero Trust disabled with no operation running, then retry the uninstall.',
        'If the platform API does not answer, bring it back with `void platform enable` or `void platform repair` first.',
        ...(state.applications.length
          ? ['Void-managed Access applications:', formatZeroTrustApplications(state.applications)]
          : []),
        ...unfinishedDeletionLines(state),
        DASHBOARD_HINT,
      ].join('\n'),
    );
  }
  if (state.applications.length) {
    throw new Error(
      [
        'platform: Refusing to uninstall while Void-managed Access applications from project Zero Trust remain.',
        'Zero Trust is disabled, but it could not remove the applications of some projects. Retry the uninstall once they are gone.',
        'Void-managed Access applications:',
        formatZeroTrustApplications(state.applications),
        ...(state.applications.some((application) => !application.deleting)
          ? [
              `Hourly maintenance retries ${state.unfinishedDeletions.length ? 'the other applications' : 'them'} while the platform is enabled, and clears Void's records of any you delete in the dashboard.`,
            ]
          : []),
        ...unfinishedDeletionLines(state),
        DASHBOARD_HINT,
      ].join('\n'),
    );
  }
  return undefined;
}
