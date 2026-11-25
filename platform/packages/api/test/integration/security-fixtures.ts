/**
 * Shared rows and bindings of the security integration suites: the policy, scan and
 * finding rows, a project with members, and the "security on" bindings.
 */
import {
  defaultSecurityPolicy,
  SECURITY_POLICY_SETTINGS_KEY,
} from '@void/platform/security-policy';
import type { SecurityPolicy } from '@void/platform/security-policy';
import { eq } from 'drizzle-orm';
import { getPlatformCapabilities } from '../../src/capabilities.ts';
import { getPlatformSetting, setPlatformSetting } from '../../src/platform-settings.ts';
import {
  deployments,
  platformSettings,
  projectMembers,
  projectZeroTrust,
  securityFindings,
  securityScans,
} from '../../src/schema.ts';
import { securityScanInputPrefix } from '../../src/security/enqueue.ts';
import { createTestDeployment, createTestProject, createTestUser } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

type Db = Pick<TestEnv, 'db'>;

/** The bindings with the security audits capability on (plus any other flags). */
export function securityOn(env: TestEnv, capabilities: Record<string, boolean> = {}): TestEnv {
  return {
    ...env,
    PLATFORM_CAPABILITIES: JSON.stringify({
      ...getPlatformCapabilities(env),
      securityAudits: true,
      ...capabilities,
    }),
  };
}

/** A scheduler namespace whose stub answers `fetch` with ok, plus the given methods. */
export function schedulerStub(
  methods: Record<string, unknown> = {},
): TestEnv['SECURITY_SCAN_SCHEDULER'] {
  return {
    idFromName: (name: string) => ({ toString: () => name }),
    get: () => ({ fetch: async () => Response.json({ ok: true }), ...methods }),
  } as unknown as TestEnv['SECURITY_SCAN_SCHEDULER'];
}

/** Security on, with a fake scan scheduler. */
export function securityBindings(
  env: TestEnv,
  options: { scheduler?: Record<string, unknown>; capabilities?: Record<string, boolean> } = {},
): TestEnv {
  return {
    ...securityOn(env, options.capabilities),
    SECURITY_SCAN_SCHEDULER: schedulerStub(options.scheduler),
  };
}

/** Saves the policy: the default, mode `all`, revision 1, then `overrides`. */
export async function saveSecurityPolicy(
  env: Db,
  overrides: Partial<SecurityPolicy> = {},
): Promise<SecurityPolicy> {
  const policy: SecurityPolicy = {
    ...defaultSecurityPolicy(),
    mode: 'all',
    revision: 1,
    ...overrides,
  };
  await setPlatformSetting(env.db, SECURITY_POLICY_SETTINGS_KEY, policy);
  return policy;
}

/** The stored policy row as it is, or undefined when none is saved. */
export async function storedSecurityPolicy(env: Db): Promise<Record<string, unknown> | undefined> {
  const value = await getPlatformSetting(env.db, SECURITY_POLICY_SETTINGS_KEY);
  return (value ?? undefined) as Record<string, unknown> | undefined;
}

/** A fresh passing entitlement probe, so the gate may be turned on. */
export const freshEntitlement = (hosts = { openai: true, anthropic: true }) => ({
  checkedAt: new Date().toISOString(),
  ok: true,
  missing: [] as Array<string>,
  hosts,
});

/** A user, a project and a live deployment. */
export async function liveProject(env: Db, slug = 'acme-web') {
  const owner = await createTestUser(env.db, `owner-${slug}`);
  const project = await createTestProject(env.db, owner.id, slug);
  const deployment = await createTestDeployment(env.db, project.id, 'live');
  return { owner, project, deployment };
}

/** Keeps a deployment's code for a scan: the stored bundle and a snapshot in R2. */
export async function storeDeploymentCode(
  env: TestEnv,
  projectId: string,
  deploymentId: string,
): Promise<void> {
  await env.db
    .update(deployments)
    .set({ bundle_stored: true })
    .where(eq(deployments.id, deploymentId));
  await env.STATIC_ASSETS_R2.put(
    `${securityScanInputPrefix(projectId, deploymentId)}modules.json`,
    '[]',
  );
}

/** A live project whose code is stored for a scan. */
export async function storedLiveProject(
  env: TestEnv,
  slug = `app-${crypto.randomUUID().slice(0, 8)}`,
) {
  const made = await liveProject(env, slug);
  await storeDeploymentCode(env, made.project.id, made.deployment.id);
  return made;
}

type ProjectRole = 'owner' | 'admin' | 'collaborator' | 'reader';

/** A project with one member per role, and an outsider. */
export async function projectWithRoles(env: Db, slug = 'acme-web') {
  const owner = await createTestUser(env.db, `owner-${slug}`);
  const project = await createTestProject(env.db, owner.id, slug);
  const people: Record<ProjectRole, { id: string; login: string; jwt: string }> = {
    owner,
    admin: await createTestUser(env.db, `admin-${slug}`),
    collaborator: await createTestUser(env.db, `collaborator-${slug}`),
    reader: await createTestUser(env.db, `reader-${slug}`),
  };
  await env.db.insert(projectMembers).values(
    (['admin', 'collaborator', 'reader'] as const).map((role) => ({
      project_id: project.id,
      user_id: people[role].id,
      role,
      added_by_user_id: owner.id,
    })),
  );
  const outsider = await createTestUser(env.db, `outsider-${slug}`);
  return { owner, project, people, outsider };
}

type ScanRow = Partial<typeof securityScans.$inferInsert>;

/** A scan row: `succeeded`, trigger `deploy`, finished now, unless overridden. */
export async function insertSecurityScan(
  env: Db,
  projectId: string,
  deploymentId: string | null,
  overrides: ScanRow = {},
): Promise<string> {
  const id = overrides.id ?? `ss_${crypto.randomUUID().slice(0, 8)}`;
  await env.db.insert(securityScans).values({
    status: 'succeeded',
    trigger: 'deploy',
    finished_at: new Date().toISOString(),
    ...overrides,
    id,
    project_id: projectId,
    deployment_id: deploymentId,
  });
  return id;
}

/** A finished scan with its model, tier, coverage and cost filled in. */
export function insertCompletedScan(
  env: Db,
  projectId: string,
  deploymentId: string,
  overrides: ScanRow = {},
): Promise<string> {
  return insertSecurityScan(env, projectId, deploymentId, {
    model_used: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    engine: 'void_loop',
    tier: 'built_diff',
    coverage: 'complete',
    files_scanned: 12,
    metered_nano_usd: 2_500_000_000,
    ...overrides,
  });
}

/** A scan the scheduler claimed: running attempt 1 with a lease of an hour. */
export async function insertRunningScan(
  env: Db,
  id: string,
  projectId: string,
  deploymentId: string,
  overrides: ScanRow = {},
): Promise<void> {
  await env.db.insert(securityScans).values({
    id,
    project_id: projectId,
    deployment_id: deploymentId,
    status: 'running',
    trigger: 'deploy',
    attempt: 1,
    lease_until: new Date(Date.now() + 60 * 60_000).toISOString(),
    model_requested: '@cf/test/model',
    model_used: '@cf/test/model',
    engine: 'void_loop',
    first_queued_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    ...overrides,
  });
}

type FindingRow = Partial<typeof securityFindings.$inferInsert>;
let findingNumber = 0;

/** A confirmed high finding row, numbered in order unless `number` is given. */
function findingRow(
  projectId: string,
  overrides: FindingRow,
): typeof securityFindings.$inferInsert & { id: string } {
  const n = overrides.number ?? ++findingNumber;
  return {
    id: `sf_test${projectId}${n}`,
    project_id: projectId,
    number: n,
    fingerprint_key: `key-${projectId}-${n}`,
    verdict: 'confirmed',
    severity: 'high',
    title: `SECRET TITLE ${n}`,
    category: 'sqli',
    file: `src/routes/secret-${n}.ts`,
    line_start: 41,
    detail: { trace: ['a', 'b'], evidence: 'EVIDENCE', conditions: 'c', fix: 'FIX' },
    sink_path: `src/routes/secret-${n}.ts`,
    sink_content_hash: 'hash-1',
    first_scan_id: 'scan_x',
    last_seen_scan_id: 'scan_x',
    first_deployment_id: 'dpl_first',
    ...overrides,
  };
}

export async function insertSecurityFinding(
  env: Db,
  projectId: string,
  overrides: FindingRow = {},
): Promise<string> {
  const row = findingRow(projectId, overrides);
  await env.db.insert(securityFindings).values(row);
  return row.id;
}

/** A finding record as the runner writes it: a confirmed SQL injection in /users. */
export function findingRecord(overrides: Record<string, unknown> = {}) {
  return {
    fingerprint: 'sqli-users',
    verdict: 'confirmed',
    severity: 'high',
    confidence: 'high',
    title: 'SQL injection in /users',
    category: 'sql-injection',
    cwe: 'CWE-89',
    file: 'src/routes/users.ts',
    line_start: 2,
    line_end: 2,
    sink_path: 'src/routes/users.ts',
    outside_diff: false,
    trace: [{ file: 'src/routes/users.ts', line: 2, note: 'id from the query' }],
    evidence: 'db.prepare(`SELECT * FROM users WHERE id = ${id}`)',
    conditions: '',
    fix: 'bind the id',
    reason: '',
    ...overrides,
  };
}

/** The runner's result: its status object and the findings file. */
export function scanResult(
  scanId: string,
  records: Array<Record<string, unknown>>,
  status: Record<string, unknown> = {},
) {
  return {
    status: {
      schema_version: 1,
      scan_id: scanId,
      attempt: 1,
      engine: 'void_loop',
      engine_version: 'runner/1 void-loop/1',
      model: '@cf/zai-org/glm-5.3',
      status: 'succeeded',
      reason: null,
      error_class: null,
      refusal_category: null,
      ...status,
    },
    findings: JSON.stringify({
      schema_version: 1,
      run_status: 'complete',
      findings: records,
      notes: '',
    }),
  };
}

/** Installation Zero Trust on (not public-only), as the installer stores it. */
async function seedZeroTrustConfiguration(env: TestEnv): Promise<void> {
  await env.db
    .insert(platformSettings)
    .values({
      key: 'zeroTrust.configuration',
      value: {
        version: 1,
        revision: 1,
        enabled: true,
        protectNewProjects: true,
        accountId: env.CF_ACCOUNT_ID,
        teamDomain: 'https://company.cloudflareaccess.com',
        identityProviderIds: ['idp-1'],
        policyIds: ['policy-1'],
        credential: { ciphertext: 'unused', iv: 'unused', keyVersion: 'v1' },
        wildcardApplicationName: 'void-test-projects',
        wildcardApplication: {
          id: 'access-wildcard',
          name: 'void-test-projects',
          audience: 'access-audience',
          destinations: ['*.void.app'],
        },
        operation: null,
        lastError: null,
        updatedAt: new Date().toISOString(),
      },
    })
    .onConflictDoNothing();
}

/** Installation Zero Trust on, and the project settled protected. */
export async function seedProtectedProject(env: TestEnv, projectId: string): Promise<void> {
  await seedZeroTrustConfiguration(env);
  await env.db.insert(projectZeroTrust).values({
    project_id: projectId,
    desired_protected: true,
    effective_protected: true,
    status: 'ready',
  });
}
