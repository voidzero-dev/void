import {
  defaultSecurityPolicy,
  readSecurityPolicy,
  SECURITY_POLICY_SETTINGS_KEY,
} from '@void/platform/security-policy';
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
import { getPlatformCapabilities } from '../../src/capabilities.ts';
import { app } from '../../src/index.ts';
import { getPlatformSetting, setPlatformSetting } from '../../src/platform-settings.ts';
import { deployments, operatorEvents, securityScans, users } from '../../src/schema.ts';
import { securityScanInputPrefix } from '../../src/security/enqueue.ts';
import { chooseSecurityTier, securityCoverageLabel } from '../../src/security/input/tier.ts';
import { runSecurityMaintenance } from '../../src/security/maintenance.ts';
import {
  previewSecurityBackfill,
  queueSecurityBackfill,
  queueSecuritySweeps,
  SECURITY_BACKFILL_MAX,
  SECURITY_SWEEP_BATCH_MAX,
} from '../../src/security/sweeps.ts';
import {
  clearTables,
  createOperatorToken,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import { setupGate } from './security-gate-fixtures.ts';

let env: TestEnv;
let onEnv: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  onEnv = {
    ...env,
    PLATFORM_CAPABILITIES: JSON.stringify({
      ...getPlatformCapabilities(env),
      securityAudits: true,
    }),
    SECURITY_SCAN_SCHEDULER: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    },
  } as unknown as TestEnv;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const DAY = 24 * 60 * 60 * 1000;

function policyWith(overrides: Partial<SecurityPolicy> = {}): SecurityPolicy {
  return { ...defaultSecurityPolicy(), mode: 'all', revision: 1, ...overrides };
}

async function savePolicy(overrides: Partial<SecurityPolicy> = {}) {
  await setPlatformSetting(env.db, SECURITY_POLICY_SETTINGS_KEY, policyWith(overrides));
}

/**
 * A project with a live deployment whose code is stored for a scan: the stored bundle
 * (what the candidate list reads) and a snapshot in R2 (what the queued scan points at).
 */
async function liveProject(slug: string) {
  const { owner, project, deployment } = await codeGoneProject(slug);
  await env.db
    .update(deployments)
    .set({ bundle_stored: true })
    .where(eq(deployments.id, deployment.id));
  await env.STATIC_ASSETS_R2.put(
    `${securityScanInputPrefix(project.id, deployment.id)}modules.json`,
    '[]',
  );
  return { owner, project, deployment };
}

/** A project live since before audits were on: no snapshot and no stored bundle. */
async function codeGoneProject(slug: string) {
  const owner = await createTestUser(env.db, `owner-${slug}`);
  const project = await createTestProject(env.db, owner.id, slug);
  const deployment = await createTestDeployment(env.db, project.id, 'live');
  return { owner, project, deployment };
}

async function addScan(
  projectId: string,
  deploymentId: string,
  overrides: Partial<typeof securityScans.$inferInsert> = {},
) {
  const id = overrides.id ?? `ss_${crypto.randomUUID().slice(0, 8)}`;
  await env.db.insert(securityScans).values({
    status: 'succeeded',
    trigger: 'deploy',
    tier: 'built_diff',
    finished_at: new Date().toISOString(),
    ...overrides,
    id,
    project_id: projectId,
    deployment_id: deploymentId,
  });
  return id;
}

async function scansOf(trigger: 'backfill' | 'sweep') {
  return env.db.select().from(securityScans).where(eq(securityScans.trigger, trigger));
}

describe('tier and label', () => {
  it('runs a sweep as a full scan and a backfill by the base rule', () => {
    const base = { baseDeploymentId: 'dpl_1', baseSnapshot: true };
    expect(chooseSecurityTier({ ...base, trigger: 'sweep' })).toEqual({
      tier: 'full',
      fullReason: 'sweep',
    });
    expect(chooseSecurityTier({ ...base, trigger: 'backfill' })).toEqual({
      tier: 'built_diff',
      fullReason: null,
    });
    expect(
      chooseSecurityTier({ trigger: 'backfill', baseDeploymentId: null, baseSnapshot: false }),
    ).toEqual({ tier: 'full', fullReason: 'first_scan' });
    expect(
      securityCoverageLabel({
        tier: 'full',
        coverage: 'complete',
        coverageNotes: ['sweep'],
        filesScanned: 10,
        backlogFiles: 0,
      }),
    ).toBe('full scan (sweep)');
  });
});

describe('backfill', () => {
  it('previews and queues one scan per live deployment never scanned, in scope', async () => {
    await savePolicy();
    const fresh = await liveProject('fresh-app');
    const scanned = await liveProject('scanned-app');
    await addScan(scanned.project.id, scanned.deployment.id);
    const busy = await liveProject('busy-app');
    await addScan(busy.project.id, busy.deployment.id, { status: 'queued', finished_at: null });
    const failed = await liveProject('failed-app');
    await addScan(failed.project.id, failed.deployment.id, { status: 'refused' });
    await liveProject('preview-x1');
    const suspended = await liveProject('suspended-app');
    await env.db
      .update(users)
      .set({ suspended_reason: 'abuse' })
      .where(eq(users.id, suspended.owner.id));

    const preview = await previewSecurityBackfill(env.db);
    expect(preview).toMatchObject({ projects: 2, willQueue: 2, remaining: 0 });
    expect(new Set(preview.slugs)).toEqual(new Set(['fresh-app', 'failed-app']));
    expect(preview.worstCaseUsd).toBeGreaterThan(0);
    expect(await scansOf('backfill')).toHaveLength(0);

    const result = await queueSecurityBackfill(env, env.db);
    expect(result.queued.map((entry) => entry.project).sort()).toEqual(['failed-app', 'fresh-app']);
    expect(result.remaining).toBe(0);
    const rows = await scansOf('backfill');
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.project_id === fresh.project.id)).toMatchObject({
      deployment_id: fresh.deployment.id,
      status: 'queued',
      input_r2_key: securityScanInputPrefix(fresh.project.id, fresh.deployment.id),
    });

    // The queued scans make them busy: a second backfill queues nothing.
    expect((await queueSecurityBackfill(env, env.db)).queued).toHaveLength(0);
  });

  it('leaves out projects whose code is gone, so they never hold the batch', async () => {
    await savePolicy();
    // More projects with no stored code than one call queues, all older than the one
    // that can be scanned.
    for (let index = 0; index < SECURITY_BACKFILL_MAX + 2; index++) {
      await codeGoneProject(`gone-${index}`);
    }
    await liveProject('stored-app');
    const preview = await previewSecurityBackfill(env.db);
    expect(preview).toMatchObject({
      projects: 1,
      willQueue: 1,
      remaining: 0,
      noStoredCode: SECURITY_BACKFILL_MAX + 2,
      slugs: ['stored-app'],
    });
    const result = await queueSecurityBackfill(env, env.db);
    expect(result.queued.map((entry) => entry.project)).toEqual(['stored-app']);
    expect(result).toMatchObject({ remaining: 0, noStoredCode: SECURITY_BACKFILL_MAX + 2 });
  });

  it('a refusal at queue time does not take a slot, and the policy Off refuses', async () => {
    await savePolicy();
    // The row says a snapshot exists, but the R2 object is gone.
    const lost = await codeGoneProject('lost-app');
    await addScan(lost.project.id, lost.deployment.id, {
      status: 'failed',
      input_r2_key: securityScanInputPrefix(lost.project.id, lost.deployment.id),
    });
    await liveProject('next-app');
    const result = await queueSecurityBackfill(env, env.db);
    expect(result.queued.map((entry) => entry.project)).toEqual(['next-app']);
    expect(result.skipped).toEqual({ security_input_unavailable: 1 });

    await savePolicy({ mode: 'disabled' });
    await expect(previewSecurityBackfill(env.db)).rejects.toMatchObject({
      status: 409,
      code: 'security_not_in_scope',
    });
  });

  it('leaves protected projects out under Public projects only', async () => {
    const gate = await setupGate(env, { gateOn: false });
    await savePolicy({ mode: 'public' });
    await liveProject('open-app');
    const preview = await previewSecurityBackfill(env.db);
    expect(preview.slugs).toEqual(['open-app']);
    expect(preview.slugs).not.toContain(gate.project.slug);
  });

  it('runs through the operator route with a preview first, and is audited', async () => {
    await savePolicy();
    await liveProject('fresh-app');
    const admin = await createTestUser(
      env.db,
      'backfill-admin',
      'github',
      undefined,
      'free',
      'admin',
    );
    const token = await createOperatorToken(env.db, admin);
    const post = (body: Record<string, unknown>, bindings: TestEnv = onEnv) =>
      app.fetch(
        new Request('http://localhost/operator/v1/security/backfill', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        bindings,
      );
    const preview = await post({ dryRun: true });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      dryRun: true,
      action: 'security.backfill',
      target: 'platform',
      projects: 1,
      willQueue: 1,
    });
    expect(await scansOf('backfill')).toHaveLength(0);
    const queued = await post({});
    expect(queued.status).toBe(202);
    expect(await queued.json()).toMatchObject({ ok: true, queued: [{ project: 'fresh-app' }] });
    expect(await scansOf('backfill')).toHaveLength(1);
    expect((await post({}, env)).status).toBe(501);
    const events = await env.db.select().from(operatorEvents);
    expect(events.some((event) => event.target.includes('"backfill":true'))).toBe(true);
  });
});

describe('scheduled sweeps', () => {
  const now = Date.now();
  const sweepsOn = (everyDays = 30) => policyWith({ sweeps: { on: true, everyDays } });

  it('queues nothing while sweeps are off or the policy is Off', async () => {
    await liveProject('acme-web');
    expect(await queueSecuritySweeps(env, env.db, policyWith(), now)).toBe(0);
    expect(
      await queueSecuritySweeps(
        env,
        env.db,
        policyWith({ mode: 'disabled', sweeps: { on: true, everyDays: 30 } }),
        now,
      ),
    ).toBe(0);
    expect(await scansOf('sweep')).toHaveLength(0);
  });

  it('sweeps projects with no full scan or sweep inside the window, once', async () => {
    await savePolicy();
    const due = await liveProject('due-app');
    await addScan(due.project.id, due.deployment.id, {
      tier: 'full',
      finished_at: new Date(now - 40 * DAY).toISOString(),
      created_at: new Date(now - 40 * DAY).toISOString(),
    });
    const recent = await liveProject('recent-app');
    await addScan(recent.project.id, recent.deployment.id, { tier: 'full' });
    const sweptFailed = await liveProject('swept-app');
    await addScan(sweptFailed.project.id, sweptFailed.deployment.id, {
      trigger: 'sweep',
      tier: 'full',
      status: 'failed',
      created_at: new Date(now - 2 * DAY).toISOString(),
    });
    const diffOnly = await liveProject('diff-app');
    await addScan(diffOnly.project.id, diffOnly.deployment.id, { tier: 'built_diff' });

    expect(await queueSecuritySweeps(env, env.db, sweepsOn(), now)).toBe(2);
    const rows = await scansOf('sweep');
    const queued = rows.filter((row) => row.status === 'queued');
    expect(queued.map((row) => row.project_id).sort()).toEqual(
      [due.project.id, diffOnly.project.id].sort(),
    );
    // Queued sweeps make the projects busy; nothing more is due.
    expect(await queueSecuritySweeps(env, env.db, sweepsOn(), now)).toBe(0);
    // Ten days on, with a 7-day window, the recent full scan and the failed sweep are old.
    expect(await queueSecuritySweeps(env, env.db, sweepsOn(7), now + 10 * DAY)).toBe(2);
    const later = (await scansOf('sweep')).filter((row) => row.status === 'queued');
    expect(new Set(later.map((row) => row.project_id))).toEqual(
      new Set([due.project.id, diffOnly.project.id, recent.project.id, sweptFailed.project.id]),
    );
  });

  it('queues only what the queue can start soon', async () => {
    await savePolicy();
    for (let index = 0; index < 6; index++) {
      await liveProject(`app-${index}`);
    }
    // Concurrency 2: at most four waiting scans, and one already waits.
    const waiting = await liveProject('waiting-app');
    await addScan(waiting.project.id, waiting.deployment.id, {
      status: 'queued',
      finished_at: null,
    });
    expect(await queueSecuritySweeps(env, env.db, sweepsOn(), now)).toBe(3);
    expect(await queueSecuritySweeps(env, env.db, sweepsOn(), now)).toBe(0);
    expect(SECURITY_SWEEP_BATCH_MAX).toBe(10);
  });

  it('projects whose code is gone never take the batch', async () => {
    await savePolicy();
    // Concurrency 2: room for four, and six never-swept projects older than the rest.
    for (let index = 0; index < 6; index++) {
      await codeGoneProject(`gone-${index}`);
    }
    const lost = await codeGoneProject('lost-app');
    await addScan(lost.project.id, lost.deployment.id, {
      tier: 'built_diff',
      input_r2_key: securityScanInputPrefix(lost.project.id, lost.deployment.id),
    });
    const stored = await liveProject('stored-app');
    expect(await queueSecuritySweeps(env, env.db, sweepsOn(), now)).toBe(1);
    const rows = await scansOf('sweep');
    expect(rows.map((row) => row.project_id)).toEqual([stored.project.id]);
  });

  it('sweeps again when the sweep was replaced by a deploy or canceled by policy Off', async () => {
    await savePolicy();
    const replaced = await liveProject('replaced-app');
    await addScan(replaced.project.id, replaced.deployment.id, {
      trigger: 'sweep',
      tier: 'full',
      status: 'superseded',
      created_at: new Date(now - DAY).toISOString(),
    });
    const policyOff = await liveProject('off-app');
    await addScan(policyOff.project.id, policyOff.deployment.id, {
      trigger: 'sweep',
      tier: 'full',
      status: 'canceled',
      status_reason: 'policy_off',
      created_at: new Date(now - DAY).toISOString(),
    });
    // An operator cancel is a decision: that project waits for the next window.
    const operatorCanceled = await liveProject('canceled-app');
    await addScan(operatorCanceled.project.id, operatorCanceled.deployment.id, {
      trigger: 'sweep',
      tier: 'full',
      status: 'canceled',
      status_reason: 'operator',
      created_at: new Date(now - DAY).toISOString(),
    });
    expect(await queueSecuritySweeps(env, env.db, sweepsOn(), now)).toBe(2);
    const queued = (await scansOf('sweep')).filter((row) => row.status === 'queued');
    expect(new Set(queued.map((row) => row.project_id))).toEqual(
      new Set([replaced.project.id, policyOff.project.id]),
    );
  });

  it('runs from the hourly job when the policy turns sweeps on', async () => {
    await savePolicy({ sweeps: { on: true, everyDays: 30 } });
    await liveProject('acme-web');
    const report = await runSecurityMaintenance(onEnv as never, env.db, now, {
      controller: { cancel: async () => {} } as never,
      forget: async () => {},
      poke: async () => {},
      probe: async () => {},
      reapCopies: async () => 0,
      gatewayCosts: async () => 0,
    });
    expect(report?.sweepsQueued).toBe(1);
    expect(await scansOf('sweep')).toHaveLength(1);
  });
});

describe('sweeps policy', () => {
  async function operator() {
    const admin = await createTestUser(
      env.db,
      'sweeps-admin',
      'github',
      undefined,
      'free',
      'admin',
    );
    const token = await createOperatorToken(env.db, admin);
    return (body: Record<string, unknown>) =>
      app.fetch(
        new Request('http://localhost/operator/v1/security/policy', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        onEnv,
      );
  }

  it('previews the sweeps change with the projects due, then saves it', async () => {
    await savePolicy();
    await liveProject('acme-web');
    const post = await operator();
    const preview = await post({ dryRun: true, sweeps: { on: true, everyDays: 14 } });
    expect(preview.status).toBe(200);
    const body = (await preview.json()) as { preview: Array<string>; expectedRevision: number };
    const text = body.preview.join('\n');
    expect(text).toContain('Turn on: scheduled full sweeps, every 14 days');
    expect(text).toContain('1 project in scope has not had a full scan in the last 14 days');
    const saved = await post({ sweeps: { on: true, everyDays: 14 }, expectedRevision: 1 });
    expect(saved.status).toBe(200);
    const stored = readSecurityPolicy(
      await getPlatformSetting(env.db, SECURITY_POLICY_SETTINGS_KEY),
    );
    expect(stored.sweeps).toEqual({ on: true, everyDays: 14 });

    const lines = async (sweeps: Record<string, unknown>) =>
      ((await (await post({ dryRun: true, sweeps })).json()) as { preview: Array<string> }).preview;
    expect(await lines({ everyDays: 30 })).toContain('Sweep interval: 14 → 30 days.');
    expect((await lines({ on: false })).join('\n')).toContain('Turn off: scheduled full sweeps');

    // Only the interval changes while sweeps are off: nothing turns off.
    await post({ sweeps: { on: false }, expectedRevision: 2 });
    const offDays = await lines({ on: false, everyDays: 7 });
    expect(offDays).toContain('Sweep interval: 14 → 7 days. Sweeps stay off.');
    expect(offDays.join('\n')).not.toContain('Turn off');
  });

  it('refuses a bad sweeps body', async () => {
    await savePolicy();
    const post = await operator();
    for (const sweeps of [{ everyDays: 3 }, { on: 'yes' }, { every: 7 }, {}, 'on']) {
      const response = await post({ dryRun: true, sweeps });
      expect(response.status, JSON.stringify(sweeps)).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
  });

  it('reads a policy saved before sweeps existed as sweeps off', async () => {
    const { sweeps: _sweeps, ...old } = policyWith();
    expect(readSecurityPolicy(old).sweeps).toEqual({ on: false, everyDays: 30 });
    expect(readSecurityPolicy({ ...old, sweeps: { on: 'yes' } }).sweeps.on).toBe(false);
    expect(readSecurityPolicy({ ...old, sweeps: { on: true, everyDays: 400 } }).sweeps).toEqual({
      on: true,
      everyDays: 90,
    });
  });
});
