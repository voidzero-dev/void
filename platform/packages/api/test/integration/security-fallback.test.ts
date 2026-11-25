import type { SecurityPolicy } from '@void/platform/security-policy';
import { eq } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import { securityScans } from '../../src/schema.ts';
import { queueSecurityFallbackScans } from '../../src/security/fallback.ts';
import { ingestSecurityScanResult } from '../../src/security/ingest.ts';
import { clearTables, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import {
  insertSecurityScan,
  saveSecurityPolicy,
  securityBindings,
  storedLiveProject,
} from './security-fixtures.ts';

const CF = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
const CF_2 = '@cf/zai-org/glm-5.3';
const OPUS = 'anthropic/claude-opus-5.5';
const NOTICE = {
  acceptedByUserId: 'usr_admin',
  acceptedAt: '2026-11-01T00:00:00.000Z',
  version: 1,
};

let env: TestEnv;
let onEnv: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  onEnv = securityBindings(env, { scheduler: { forgetModelCalls: async () => 0 } });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Fallback on, with the provider notice accepted. */
function savePolicy(overrides: Partial<SecurityPolicy> = {}) {
  return saveSecurityPolicy(env, { fallbackToCf: true, thirdPartyNotice: NOTICE, ...overrides });
}

async function fallbackScans(projectId?: string) {
  const rows = await env.db
    .select()
    .from(securityScans)
    .where(eq(securityScans.trigger, 'fallback'));
  return projectId ? rows.filter((row) => row.project_id === projectId) : rows;
}

describe('fallback scans (I8)', () => {
  it('ingest queues one fallback once a third-party scan is refused, and only one', async () => {
    const policy = await savePolicy();
    const { project, deployment } = await storedLiveProject(env);
    await env.db.insert(securityScans).values({
      id: 'scan_refused',
      project_id: project.id,
      deployment_id: deployment.id,
      status: 'running',
      trigger: 'deploy',
      attempt: 1,
      lease_until: new Date(Date.now() + 60 * 60_000).toISOString(),
      model_requested: OPUS,
      model_used: OPUS,
      engine: 'agent_sdk',
      model_calls: 2,
      first_queued_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
    });
    const stored = await ingestSecurityScanResult(onEnv, env.db, 'scan_refused', 1, {
      status: {
        scan_id: 'scan_refused',
        attempt: 1,
        status: 'refused',
        reason: null,
        refusal_category: 'cyber',
      },
      findings: null,
    });
    expect(stored).toMatchObject({ ok: true, status: 'refused' });
    expect(await fallbackScans(project.id)).toMatchObject([
      { status: 'queued', deployment_id: deployment.id },
    ]);
    // The fallback is now the newest scan: no second one.
    expect(await queueSecurityFallbackScans(onEnv, env.db, policy, { now: Date.now() })).toEqual(
      [],
    );
  });

  it('never falls back from a @cf scan, nor with fallback off or no @cf model left', async () => {
    const { project, deployment } = await storedLiveProject(env);
    const ended = (model: string) =>
      insertSecurityScan(env, project.id, deployment.id, {
        status: 'refused',
        failure_cause: 'project',
        tier: 'built_diff',
        model_requested: model,
        model_used: model,
      });
    await ended(CF);
    let policy = await savePolicy();
    expect(await queueSecurityFallbackScans(onEnv, env.db, policy, { now: Date.now() })).toEqual(
      [],
    );
    await ended(OPUS);
    const settings: Array<Partial<SecurityPolicy>> = [
      { fallbackToCf: false },
      { defaultModel: OPUS, blockedModels: [CF, CF_2] },
    ];
    for (const overrides of settings) {
      policy = await savePolicy(overrides);
      expect(await queueSecurityFallbackScans(onEnv, env.db, policy, { now: Date.now() })).toEqual(
        [],
      );
    }
    expect(await fallbackScans()).toHaveLength(0);
  });
});
