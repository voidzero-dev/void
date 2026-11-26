/**
 * Per-project scan rule (design doc 0095, M34), set by installation admins only:
 *
 *   inherit  the installation policy decides (the default; no settings row = inherit)
 *   always   scanned under `public` too, even while Zero Trust protects it
 *   never    not scanned: deploys get `skipped:project_policy`, and rescans, sweeps,
 *            backfill, exposure catch-up and local checks leave it out. A gate scan
 *            (and its fallback) still runs: the rule never lets a project skip the
 *            scan before it goes public (D46).
 *
 * Policy Off still scans nothing: the rule only narrows or widens an on mode.
 */
import { eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db.ts';
import { projects, projectZeroTrust } from '../schema.ts';
import { SecurityApiError } from './errors.ts';
import { projectSecuritySettings } from './schema.ts';

export const SECURITY_PROJECT_POLICY_OVERRIDES = ['inherit', 'always', 'never'] as const;

export type SecurityProjectPolicyOverride = (typeof SECURITY_PROJECT_POLICY_OVERRIDES)[number];

/** `status_reason` of a deploy scan skipped (or a queued scan ended) by `never`. */
export const SECURITY_PROJECT_POLICY_SKIP_REASON = 'project_policy';

export function isSecurityProjectPolicyOverride(
  value: unknown,
): value is SecurityProjectPolicyOverride {
  return (
    typeof value === 'string' &&
    (SECURITY_PROJECT_POLICY_OVERRIDES as ReadonlyArray<string>).includes(value)
  );
}

/** `{override: 'inherit' | 'always' | 'never'}`. */
export function parseSecurityProjectPolicyRequest(
  body: Record<string, unknown>,
): SecurityProjectPolicyOverride {
  if (!isSecurityProjectPolicyOverride(body.override)) {
    throw SecurityApiError.invalid(
      'Send {"override":"inherit"}, {"override":"always"} or {"override":"never"}.',
    );
  }
  return body.override;
}

/** The project's rule; a project with no settings row inherits. */
export async function readSecurityProjectPolicyOverride(
  db: DbOrTx,
  projectId: string,
): Promise<SecurityProjectPolicyOverride> {
  const [row] = await db
    .select({ override: projectSecuritySettings.policy_override })
    .from(projectSecuritySettings)
    .where(eq(projectSecuritySettings.project_id, projectId))
    .limit(1);
  return isSecurityProjectPolicyOverride(row?.override) ? row.override : 'inherit';
}

/** SQL: the project (`projectIdColumn`) has the given rule. No row reads as `inherit`. */
export function securityProjectHasOverrideSql(
  projectIdColumn: SQL | { getSQL(): SQL },
  override: Exclude<SecurityProjectPolicyOverride, 'inherit'>,
): SQL {
  return sql`EXISTS (SELECT 1 FROM project_security_settings pso WHERE pso.project_id = ${projectIdColumn} AND pso.policy_override = ${override})`;
}

const protectedRow = sql`(${projectZeroTrust.status} = 'ready' AND ${projectZeroTrust.desired_protected} AND ${projectZeroTrust.effective_protected})`;

/**
 * SQL: `projects` (left-joined to `project_zero_trust`) is scanned at deploy under `mode`.
 * `protects` is `installationZeroTrustProtects`. Public requests are left out: a gate
 * scan runs whatever this says.
 */
export function securityProjectInScopeSql(mode: 'public' | 'all', protects: boolean): SQL {
  const never = securityProjectHasOverrideSql(projects.id, 'never');
  if (mode === 'public' && protects) {
    const always = securityProjectHasOverrideSql(projects.id, 'always');
    return sql`(NOT ${never} AND (${always} OR NOT COALESCE(${protectedRow}, false)))`;
  }
  return sql`NOT ${never}`;
}

/** Human copy for the rule, as the admin panel and the CLI preview print it. */
export const SECURITY_PROJECT_POLICY_COPY: Readonly<Record<SecurityProjectPolicyOverride, string>> =
  {
    inherit: 'follows the platform scan mode',
    always: 'always scanned, also while Zero Trust protects it',
    never: 'never scanned; a scan before it goes public still runs',
  };
