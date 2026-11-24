import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { securityLocalTreeTar } from '@void/platform/security-local-check';
import {
  defaultSecurityPolicy,
  SECURITY_POLICY_SETTINGS_KEY,
} from '@void/platform/security-policy';
import type { SecurityPolicy } from '@void/platform/security-policy';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { getPlatformCapabilities } from '../../src/capabilities.ts';
import app from '../../src/index.ts';
import { setPlatformSetting } from '../../src/platform-settings.ts';
import { deployments, projectMembers } from '../../src/schema.ts';
import {
  enqueueSecurityScanInTx,
  securityScanInputPrefix,
  securityScanProjectPrefix,
} from '../../src/security/enqueue.ts';
import { ingestSecurityScanResult } from '../../src/security/ingest.ts';
import { prepareSecurityScanInputFiles } from '../../src/security/input/prepare.ts';
import {
  SECURITY_LOCAL_UPLOAD_STALE_MS,
  securityLocalResultKey,
  securityLocalTreeKey,
  sweepSecurityLocalChecks,
} from '../../src/security/local-check.ts';
import {
  deleteOldSecurityScanRows,
  SECURITY_RAW_SWEEP_CURSOR_KEY,
  SECURITY_SCAN_ROWS_KEPT,
  securityRawOutputPrefix,
} from '../../src/security/maintenance.ts';
import { queueSecurityRescan } from '../../src/security/operator.ts';
import { securityPolicyPreviewCounts } from '../../src/security/policy.ts';
import { queueStalePendingSecurityScans } from '../../src/security/queue.ts';
import { countSecurityScanCandidates } from '../../src/security/scan-candidates.ts';
import {
  projectSecuritySettings,
  securityFindingEvents,
  securityFindings,
  securityNotifications,
  securityScans,
} from '../../src/security/schema.ts';
import { listSecurityProjectStreaks } from '../../src/security/streaks.ts';
import {
  captureQueries,
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestProjectSecret,
  createTestUser,
  mockCfApi,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

const CF = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
const OPUS = 'anthropic/claude-opus-5.5';

let env: TestEnv;
let onEnv: TestEnv;
let pokes: number;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  vi.restoreAllMocks();
  pokes = 0;
  onEnv = {
    ...env,
    PLATFORM_CAPABILITIES: JSON.stringify({
      ...getPlatformCapabilities(env),
      securityAudits: true,
    }),
    SECURITY_SCAN_SCHEDULER: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        fetch: async () => {
          pokes++;
          return Response.json({ ok: true });
        },
        forgetModelCalls: async () => 0,
      }),
    },
  } as unknown as TestEnv;
  mockCfApi();
});

async function savePolicy(policy: Partial<SecurityPolicy> = {}) {
  await setPlatformSetting(env.db, SECURITY_POLICY_SETTINGS_KEY, {
    ...defaultSecurityPolicy(),
    mode: 'all',
    revision: 1,
    ...policy,
  });
}

async function setup(slug = `app-${crypto.randomUUID().slice(0, 8)}`) {
  const owner = await createTestUser(env.db, `owner-${slug}`);
  const project = await createTestProject(env.db, owner.id, slug);
  const reader = await createTestUser(env.db, `reader-${slug}`);
  await env.db.insert(projectMembers).values({
    project_id: project.id,
    user_id: reader.id,
    role: 'reader',
    added_by_user_id: owner.id,
  });
  return { owner, project, reader };
}

function call(
  path: string,
  jwt: string,
  options: { method?: string; body?: unknown; bindings?: TestEnv } = {},
) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    options.bindings ?? onEnv,
  );
}

// oxlint-disable-next-line typescript/no-explicit-any
async function json(response: Response): Promise<any> {
  return response.json();
}

const encoder = new TextEncoder();

/** The archive the CLI uploads, and the request that describes it. */
function tree(files: Record<string, string>) {
  const entries = Object.entries(files).map(([path, text]) => ({
    path,
    data: encoder.encode(text),
  }));
  const archive = gzipSync(securityLocalTreeTar(entries));
  return {
    archive,
    request: {
      files: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.data.length, 0),
      size: archive.length,
      md5: createHash('md5').update(archive).digest('hex'),
    },
  };
}

const APP = {
  'src/routes/users.ts':
    'export const GET = (c) => db.prepare(`SELECT * FROM users WHERE id = ${c.req.query("id")}`);\n',
  'src/client/app.tsx': 'export const App = () => null;\n',
  'test/users.test.ts': 'it("works", () => {});\n',
  'void.config.ts': 'export default {};\n',
};

async function scanRow(id: string) {
  const [row] = await env.db.select().from(securityScans).where(eq(securityScans.id, id));
  return row;
}

/** Creates a check through the API and uploads its tree, then starts it. */
async function queuedCheck(projectId: string, jwt: string, files: Record<string, string> = APP) {
  const { archive, request } = tree(files);
  const created = await json(
    await call(`/projects/${projectId}/security/checks`, jwt, { method: 'POST', body: request }),
  );
  await env.STATIC_ASSETS_R2.put(securityLocalTreeKey(projectId, created.checkId), archive);
  const started = await call(
    `/projects/${projectId}/security/checks/${created.checkId}/start`,
    jwt,
    { method: 'POST', body: {} },
  );
  expect(started.status).toBe(202);
  return created.checkId as string;
}

/** What the scheduler's claim does: the check is running attempt 1. */
async function run(checkId: string) {
  await env.db
    .update(securityScans)
    .set({
      status: 'running',
      attempt: 1,
      lease_until: new Date(Date.now() + 60 * 60_000).toISOString(),
      model_requested: CF,
      model_used: CF,
      engine: 'void_loop',
      model_calls: 2,
      started_at: new Date().toISOString(),
    })
    .where(eq(securityScans.id, checkId));
}

function report(
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
      model: CF,
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

function finding(overrides: Record<string, unknown> = {}) {
  return {
    fingerprint: 'sqli-users',
    verdict: 'confirmed',
    severity: 'high',
    confidence: 'high',
    title: 'SQL injection in /users',
    category: 'sql-injection',
    cwe: 'CWE-89',
    file: 'src/routes/users.ts',
    line_start: 1,
    line_end: 1,
    sink_path: 'src/routes/users.ts',
    outside_diff: false,
    trace: [{ file: 'src/routes/users.ts', line: 1, note: 'id from the query' }],
    evidence: 'db.prepare(`SELECT … ${id}`)',
    conditions: '',
    fix: 'bind the id',
    reason: '',
    ...overrides,
  };
}

describe('local check routes', () => {
  it('previews what it would run, with the provider notice for a third-party model', async () => {
    await savePolicy();
    const { owner, project } = await setup();
    const { request } = tree(APP);
    const cf = await call(`/projects/${project.id}/security/checks`, owner.jwt, {
      method: 'POST',
      body: { ...request, dryRun: true },
    });
    expect(cf.status).toBe(200);
    const preview = await json(cf);
    expect(preview).toMatchObject({ dryRun: true, model: CF, thirdParty: false, notice: null });
    expect(preview.worstCaseUsd).toBeGreaterThan(0);
    expect(preview.limits.maxFiles).toBe(10_000);

    await savePolicy({
      entitlement: {
        checkedAt: new Date().toISOString(),
        ok: true,
        missing: [],
        hosts: { openai: false, anthropic: true },
      },
      thirdPartyNotice: {
        acceptedByUserId: 'usr_admin',
        acceptedAt: '2026-11-01T00:00:00.000Z',
        version: 1,
      },
    });
    await env.db.insert(projectSecuritySettings).values({
      project_id: project.id,
      model: OPUS,
      provider_notice_version: 1,
      provider_notice_by_user_id: owner.id,
      provider_notice_at: new Date().toISOString(),
    });
    const third = await json(
      await call(`/projects/${project.id}/security/checks`, owner.jwt, {
        method: 'POST',
        body: { ...request, dryRun: true },
      }),
    );
    expect(third.model).toBe(OPUS);
    expect(third.thirdParty).toBe(true);
    expect(third.notice[0]).toBe('This model is run by Anthropic, not by Cloudflare.');
    // A preview stores nothing.
    expect(await env.db.select().from(securityScans)).toHaveLength(0);
  });

  it('needs deploy access, the capability, a policy that applies, and a tree within the limits', async () => {
    await savePolicy();
    const { owner, project, reader } = await setup();
    const { request } = tree(APP);
    const path = `/projects/${project.id}/security/checks`;
    expect((await call(path, reader.jwt, { method: 'POST', body: request })).status).toBe(403);
    expect(
      (await call(path, owner.jwt, { method: 'POST', body: request, bindings: env })).status,
    ).toBe(501);
    const big = await call(path, owner.jwt, {
      method: 'POST',
      body: { ...request, bytes: 33 * 1024 * 1024 },
    });
    expect(big.status).toBe(413);
    expect((await json(big)).error).toBe('security_check_too_large');
    const bad = await call(path, owner.jwt, { method: 'POST', body: { ...request, md5: 'nope' } });
    expect(bad.status).toBe(400);

    await savePolicy({ mode: 'disabled' });
    const off = await call(path, owner.jwt, { method: 'POST', body: request });
    expect(off.status).toBe(409);
    expect((await json(off)).error).toBe('security_not_in_scope');

    // The project rule never (M34) refuses it too.
    await savePolicy();
    await env.db
      .insert(projectSecuritySettings)
      .values({ project_id: project.id, policy_override: 'never' });
    const never = await call(path, owner.jwt, { method: 'POST', body: request });
    expect(never.status).toBe(409);
    expect(await json(never)).toMatchObject({
      error: 'security_not_in_scope',
      message: `${project.slug} is not scanned: a platform admin turned scans off for this project.`,
    });
    expect(await env.db.select().from(securityScans)).toHaveLength(0);
  });

  it('stores a check with no deployment and signs one upload of exactly that archive', async () => {
    await savePolicy();
    const { owner, project } = await setup();
    const { request } = tree(APP);
    const response = await call(`/projects/${project.id}/security/checks`, owner.jwt, {
      method: 'POST',
      body: request,
    });
    expect(response.status).toBe(201);
    const created = await json(response);
    expect(created.model).toBe(CF);
    const url = new URL(created.upload.url);
    expect(url.pathname).toContain(
      `security-scans/${project.id}/scans/${created.checkId}/local-tree.tar.gz`,
    );
    expect(created.upload.headers['Content-Md5']).toBe(
      (Buffer as BufferConstructor).from(request.md5, 'hex').toString('base64'),
    );
    expect(created.upload.headers['Content-Length']).toBe(String(request.size));
    const row = await scanRow(created.checkId);
    expect(row).toMatchObject({
      trigger: 'local',
      deployment_id: null,
      status: 'pending_input',
      input_r2_key: securityLocalTreeKey(project.id, created.checkId),
    });

    // A check whose upload never came (Ctrl-C, a failed PUT) is replaced by a new one.
    const again = await call(`/projects/${project.id}/security/checks`, owner.jwt, {
      method: 'POST',
      body: request,
    });
    expect(again.status).toBe(201);
    const second = await json(again);
    expect(await scanRow(created.checkId)).toMatchObject({
      status: 'canceled',
      status_reason: 'upload_replaced',
    });
    // One queued or running check at a time per project.
    await env.STATIC_ASSETS_R2.put(
      securityLocalTreeKey(project.id, second.checkId),
      tree(APP).archive,
    );
    await call(`/projects/${project.id}/security/checks/${second.checkId}/start`, owner.jwt, {
      method: 'POST',
      body: {},
    });
    const busy = await call(`/projects/${project.id}/security/checks`, owner.jwt, {
      method: 'POST',
      body: request,
    });
    expect(busy.status).toBe(409);
    expect(await json(busy)).toMatchObject({
      error: 'security_check_in_progress',
      checkId: second.checkId,
    });
  });

  it('reads the policy again under the shared policy lock before it stores the check', async () => {
    await savePolicy();
    const { owner, project } = await setup();
    const { result, queries } = await captureQueries(env.db, async () =>
      call(`/projects/${project.id}/security/checks`, owner.jwt, {
        method: 'POST',
        body: tree(APP).request,
      }),
    );
    expect(result.status).toBe(201);
    const lower = queries.map((query) => query.toLowerCase());
    const row = lower.findIndex((query) => query.includes('for update'));
    const lock = lower.findIndex((query) => query.includes('pg_advisory_xact_lock_shared'));
    const insert = lower.findIndex((query) => query.startsWith('insert into "security_scans"'));
    expect(row).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(row);
    expect(insert).toBeGreaterThan(lock);
    expect(lower.slice(lock, insert).some((query) => query.includes('"platform_settings"'))).toBe(
      true,
    );
  });

  it('never joins the queue while the policy is Off', async () => {
    await savePolicy();
    const { owner, project } = await setup();
    const { archive, request } = tree(APP);
    const created = await json(
      await call(`/projects/${project.id}/security/checks`, owner.jwt, {
        method: 'POST',
        body: request,
      }),
    );
    await env.STATIC_ASSETS_R2.put(securityLocalTreeKey(project.id, created.checkId), archive);
    await savePolicy({ mode: 'disabled' });
    const started = await call(
      `/projects/${project.id}/security/checks/${created.checkId}/start`,
      owner.jwt,
      { method: 'POST', body: {} },
    );
    expect(await json(started)).toEqual({ checkId: created.checkId, status: 'canceled' });
    expect(await scanRow(created.checkId)).toMatchObject({
      status: 'canceled',
      status_reason: 'policy_off',
    });
    expect(pokes).toBe(0);
  });

  it('starts only once the archive is there, then waits in the queue', async () => {
    await savePolicy();
    const { owner, project } = await setup();
    const { archive, request } = tree(APP);
    const created = await json(
      await call(`/projects/${project.id}/security/checks`, owner.jwt, {
        method: 'POST',
        body: request,
      }),
    );
    const start = `/projects/${project.id}/security/checks/${created.checkId}/start`;
    const missing = await call(start, owner.jwt, { method: 'POST', body: {} });
    expect(missing.status).toBe(409);
    expect((await json(missing)).error).toBe('security_check_upload_missing');

    await env.STATIC_ASSETS_R2.put(securityLocalTreeKey(project.id, created.checkId), archive);
    const started = await call(start, owner.jwt, { method: 'POST', body: {} });
    expect(started.status).toBe(202);
    expect(await json(started)).toEqual({ checkId: created.checkId, status: 'queued' });
    expect(pokes).toBe(1);
    expect((await scanRow(created.checkId)).first_queued_at).not.toBeNull();
    // A repeated start only reads the state back.
    expect(await json(await call(start, owner.jwt, { method: 'POST', body: {} }))).toEqual({
      checkId: created.checkId,
      status: 'queued',
    });
    expect(pokes).toBe(1);

    const view = await json(
      await call(`/projects/${project.id}/security/checks/${created.checkId}`, owner.jwt),
    );
    expect(view).toMatchObject({
      ended: false,
      result: null,
      check: { status: 'queued', trigger: 'local', deploymentId: null },
    });
    const other = await setup();
    expect(
      (
        await call(
          `/projects/${other.project.id}/security/checks/${created.checkId}`,
          other.owner.jwt,
        )
      ).status,
    ).toBe(404);
  });
});

describe('local check scan', () => {
  it('reads the uploaded tree as a full scan: server code first, secrets redacted, nothing stored for the project', async () => {
    await savePolicy();
    const { owner, project } = await setup();
    await createTestProjectSecret(env.db, env, project.id, 'API_KEY', 'Sup3r-Secret-Value');
    const checkId = await queuedCheck(project.id, owner.jwt, {
      ...APP,
      'src/lib/client.ts': 'const key = "Sup3r-Secret-Value";\n',
      '.env': 'API_KEY=Sup3r-Secret-Value\n',
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    });
    await run(checkId);
    const prepared = await prepareSecurityScanInputFiles(onEnv, env.db, checkId, 1);
    expect(prepared).not.toBeNull();
    const built = prepared!.built;
    expect(built.tier).toBe('full');
    expect(built.notes).toContain('local-check');
    expect(built.notes).not.toContain('no-commit');
    expect(built.notes).toContain('dropped secret-like file .env');
    const paths = built.entries.filter((e) => e.path.startsWith('input/')).map((e) => e.path);
    expect(paths[0]).toBe('input/src/routes/users.ts');
    expect(paths.at(-1)).toBe('input/test/users.test.ts');
    expect(paths).not.toContain('input/.env');
    expect(paths).not.toContain('input/pnpm-lock.yaml');
    const client = built.entries.find((e) => e.path === 'input/src/lib/client.ts')!;
    expect(String(client.data)).toContain('[REDACTED:API_KEY]');
    expect(String(client.data)).not.toContain('Sup3r-Secret-Value');
    expect(JSON.parse(String(built.entries[0].data))).toMatchObject({
      tier: 'full',
      changed_files: [],
    });
    // The secret value in the tree is a server lead, kept with the scan.
    const leads = JSON.parse(
      await (await env.STATIC_ASSETS_R2.get(
        `${securityRawOutputPrefix(project.id, checkId)}server-leads.json`,
      ))!.text(),
    );
    expect((leads.leads as Array<{ kind: string }>).map((lead) => lead.kind)).toContain(
      'secret_in_output',
    );
    // No base snapshot, backlog or scope file is written for the project.
    const keys = (
      await env.STATIC_ASSETS_R2.list({ prefix: securityScanProjectPrefix(project.id) })
    ).objects.map((o) => o.key);
    expect(keys.filter((key) => !key.includes(`/scans/${checkId}/`))).toEqual([]);
    expect(await scanRow(checkId)).toMatchObject({
      tier: 'full',
      backlog_files: 0,
      files_scanned: 5,
    });
  });

  it('fails as input_missing when the tree is gone', async () => {
    await savePolicy();
    const { owner, project } = await setup();
    const checkId = await queuedCheck(project.id, owner.jwt);
    await env.STATIC_ASSETS_R2.delete(securityLocalTreeKey(project.id, checkId));
    await run(checkId);
    expect(await prepareSecurityScanInputFiles(onEnv, env.db, checkId, 1)).toBeNull();
    expect(await scanRow(checkId)).toMatchObject({
      status: 'failed',
      status_reason: 'input_missing',
    });
  });

  it('stores the result apart: no finding, event or email, and the tree is deleted', async () => {
    await savePolicy();
    const { owner, project } = await setup();
    const checkId = await queuedCheck(project.id, owner.jwt);
    await run(checkId);
    await prepareSecurityScanInputFiles(onEnv, env.db, checkId, 1);
    const lead = finding({
      fingerprint: 'open-redirect',
      verdict: 'needs_validation',
      severity: null,
      title: 'Possible open redirect',
      category: 'open-redirect',
      file: 'src/client/app.tsx',
      sink_path: null,
      trace: [],
    });
    const low = finding({ fingerprint: 'verbose-error', severity: 'low', title: 'Verbose error' });
    const stored = await ingestSecurityScanResult(
      onEnv,
      env.db,
      checkId,
      1,
      report(checkId, [lead, low, finding()]),
    );
    expect(stored).toMatchObject({ ok: true, kind: 'stored', status: 'succeeded', news: [] });
    expect(await env.db.select().from(securityFindings)).toHaveLength(0);
    expect(await env.db.select().from(securityFindingEvents)).toHaveLength(0);
    expect(await env.db.select().from(securityNotifications)).toHaveLength(0);
    const row = await scanRow(checkId);
    expect(row).toMatchObject({ status: 'succeeded', input_r2_key: null, ledger_summary: null });
    expect(await env.STATIC_ASSETS_R2.get(securityLocalTreeKey(project.id, checkId))).toBeNull();
    // The project's backlog is never written by a local check.
    expect(
      await env.STATIC_ASSETS_R2.get(`${securityScanProjectPrefix(project.id)}backlog.json`),
    ).toBeNull();

    const view = await json(
      await call(`/projects/${project.id}/security/checks/${checkId}`, owner.jwt),
    );
    expect(view.ended).toBe(true);
    expect(view.check).toMatchObject({
      status: 'succeeded',
      coverageLabel: 'full scan (local check)',
    });
    expect(view.result.total).toBe(3);
    expect(
      (
        view.result.findings as Array<{ verdict: string; severity: string | null; title: string }>
      ).map((f) => [f.verdict, f.severity, f.title]),
    ).toEqual([
      ['confirmed', 'high', 'SQL injection in /users'],
      ['confirmed', 'low', 'Verbose error'],
      ['needs_validation', null, 'Possible open redirect'],
    ]);
    expect(
      await env.STATIC_ASSETS_R2.get(securityLocalResultKey(project.id, checkId, 1)),
    ).not.toBeNull();

    // The project status still shows no scan: a local check is not a scan of what it serves.
    const status = await json(await call(`/projects/${project.id}/security`, owner.jwt));
    expect(status.lastScan).toBeNull();
    expect(status.lastSuccessfulScan).toBeNull();
    // The scan history lists it.
    const scans = await json(
      await call(`/projects/${project.id}/security/scans?limit=10`, owner.jwt),
    );
    expect((scans.scans as Array<{ trigger: string }>).map((s) => s.trigger)).toEqual(['local']);
  });

  it('writes the result before the row ends: a failed write leaves the check running', async () => {
    await savePolicy();
    const { owner, project } = await setup();
    const checkId = await queuedCheck(project.id, owner.jwt);
    await run(checkId);
    await prepareSecurityScanInputFiles(onEnv, env.db, checkId, 1);
    const put = vi
      .spyOn(env.STATIC_ASSETS_R2, 'put')
      .mockRejectedValueOnce(new Error('storage is down'));
    await expect(
      ingestSecurityScanResult(onEnv, env.db, checkId, 1, report(checkId, [finding()])),
    ).rejects.toThrow('storage is down');
    expect(put).toHaveBeenCalledWith(
      securityLocalResultKey(project.id, checkId, 1),
      expect.any(String),
    );
    // Nothing ended: a poll never sees an ended check with no result.
    expect((await scanRow(checkId)).status).toBe('running');
    expect(
      await json(await call(`/projects/${project.id}/security/checks/${checkId}`, owner.jwt)),
    ).toMatchObject({ ended: false, result: null });

    // The controller hands the result again.
    put.mockRestore();
    await ingestSecurityScanResult(onEnv, env.db, checkId, 1, report(checkId, [finding()]));
    const view = await json(
      await call(`/projects/${project.id}/security/checks/${checkId}`, owner.jwt),
    );
    expect(view).toMatchObject({
      ended: true,
      check: { status: 'succeeded' },
      result: { total: 1 },
    });
  });

  it('names a secret in the tree as code not deployed yet', async () => {
    await savePolicy();
    const { owner, project } = await setup();
    await createTestProjectSecret(env.db, env, project.id, 'API_KEY', 'Sup3r-Secret-Value');
    const checkId = await queuedCheck(project.id, owner.jwt, {
      ...APP,
      'src/routes/key.ts': 'export const key = "Sup3r-Secret-Value";\n',
    });
    await run(checkId);
    await prepareSecurityScanInputFiles(onEnv, env.db, checkId, 1);
    await ingestSecurityScanResult(onEnv, env.db, checkId, 1, report(checkId, []));
    const view = await json(
      await call(`/projects/${project.id}/security/checks/${checkId}`, owner.jwt),
    );
    const secret = (
      view.result.findings as Array<{
        category: string;
        title: string;
        detail: { evidence: string };
      }>
    ).find((f) => f.category === 'secret-in-output');
    expect(secret?.title).toBe(
      'Secret API_KEY is written into your code (not deployed yet): src/routes/key.ts',
    );
    expect(secret?.detail.evidence).toContain('of your code (not deployed yet).');
    expect(JSON.stringify(view.result)).not.toContain('deployed Worker');
  });

  it('keeps no result for a refused check and queues no fallback', async () => {
    await savePolicy({ fallbackToCf: true });
    const { owner, project } = await setup();
    const checkId = await queuedCheck(project.id, owner.jwt);
    await run(checkId);
    await prepareSecurityScanInputFiles(onEnv, env.db, checkId, 1);
    await ingestSecurityScanResult(
      onEnv,
      env.db,
      checkId,
      1,
      report(checkId, [], { status: 'refused', refusal_category: 'cyber' }),
    );
    const rows = await env.db.select().from(securityScans);
    expect(rows.map((r) => [r.trigger, r.status])).toEqual([['local', 'refused']]);
    const view = await json(
      await call(`/projects/${project.id}/security/checks/${checkId}`, owner.jwt),
    );
    expect(view).toMatchObject({ ended: true, result: null, check: { status: 'refused' } });
  });
});

describe('local checks and the scan queue', () => {
  it('is never replaced by a deploy, and never re-poked before its upload', async () => {
    await savePolicy();
    const { owner, project } = await setup();
    const { request } = tree(APP);
    const created = await json(
      await call(`/projects/${project.id}/security/checks`, owner.jwt, {
        method: 'POST',
        body: request,
      }),
    );
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM projects WHERE id = ${project.id} FOR UPDATE`);
      await enqueueSecurityScanInTx(tx, onEnv, {
        projectId: project.id,
        deploymentId: deployment.id,
        trigger: 'deploy',
      });
    });
    expect((await scanRow(created.checkId)).status).toBe('pending_input');
    // The hourly re-poke moves a deploy's stale row, not a check waiting for its upload.
    const later = Date.now() + 11 * 60_000;
    expect(await queueStalePendingSecurityScans(env.db, later)).toBe(1);
    expect((await scanRow(created.checkId)).status).toBe('pending_input');
  });

  it('cancels a check whose upload never came and deletes trees of ended checks', async () => {
    await savePolicy();
    const { owner, project } = await setup();
    const { archive, request } = tree(APP);
    const created = await json(
      await call(`/projects/${project.id}/security/checks`, owner.jwt, {
        method: 'POST',
        body: request,
      }),
    );
    await env.STATIC_ASSETS_R2.put(securityLocalTreeKey(project.id, created.checkId), archive);
    // The upload URL works 30 minutes; the check goes a little after.
    expect(SECURITY_LOCAL_UPLOAD_STALE_MS).toBe(35 * 60_000);
    expect(await sweepSecurityLocalChecks(env.db, env.STATIC_ASSETS_R2, Date.now())).toBe(0);
    expect(
      await sweepSecurityLocalChecks(
        env.db,
        env.STATIC_ASSETS_R2,
        Date.now() + SECURITY_LOCAL_UPLOAD_STALE_MS + 60_000,
      ),
    ).toBe(1);
    expect(await scanRow(created.checkId)).toMatchObject({
      status: 'canceled',
      status_reason: 'upload_missing',
      input_r2_key: null,
    });
    expect(
      await env.STATIC_ASSETS_R2.get(securityLocalTreeKey(project.id, created.checkId)),
    ).toBeNull();
  });
});

describe('local checks never change deployment scan rules', () => {
  /** An ended local check of the project, `minutesAgo` old. */
  async function endedCheck(
    projectId: string,
    overrides: Partial<typeof securityScans.$inferInsert> = {},
  ) {
    const id = overrides.id ?? `scan_local_${crypto.randomUUID().slice(0, 8)}`;
    const at = new Date().toISOString();
    await env.db.insert(securityScans).values({
      status: 'succeeded',
      tier: 'full',
      model_used: CF,
      created_at: at,
      finished_at: at,
      ...overrides,
      id,
      project_id: projectId,
      deployment_id: null,
      trigger: 'local',
    });
    return id;
  }

  async function deployScan(
    projectId: string,
    deploymentId: string,
    overrides: Partial<typeof securityScans.$inferInsert> = {},
  ) {
    const id = overrides.id ?? `ss_${crypto.randomUUID().slice(0, 8)}`;
    await env.db.insert(securityScans).values({
      status: 'refused',
      failure_cause: 'project',
      trigger: 'deploy',
      model_used: OPUS,
      finished_at: new Date().toISOString(),
      ...overrides,
      id,
      project_id: projectId,
      deployment_id: deploymentId,
    });
    return id;
  }

  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const DAY = 24 * 60 * 60_000;

  it('neither counts toward nor breaks a failure streak', async () => {
    await savePolicy();
    const { project } = await setup();
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    for (let i = 0; i < 3; i++) {
      await deployScan(project.id, deployment.id, { created_at: ago((10 - 2 * i) * 60_000) });
      // A clean check between and after the failures.
      await endedCheck(project.id, { created_at: ago((9 - 2 * i) * 60_000) });
    }
    const [streak] = await listSecurityProjectStreaks(env.db, {
      now: Date.now(),
      projectId: project.id,
    });
    expect(streak?.failures).toBe(3);

    // Failed checks alone are no streak.
    const other = await setup();
    for (let i = 0; i < 3; i++) {
      await endedCheck(other.project.id, { status: 'refused', created_at: ago(i * 60_000) });
    }
    expect(
      await listSecurityProjectStreaks(env.db, { now: Date.now(), projectId: other.project.id }),
    ).toEqual([]);
  });

  it('is not a recent full scan for the scheduled sweep', async () => {
    await savePolicy();
    const { project } = await setup();
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ bundle_stored: true })
      .where(eq(deployments.id, deployment.id));
    const query = {
      kind: 'sweep' as const,
      mode: 'all' as const,
      protects: false,
      everyDays: 7,
      now: Date.now(),
    };
    expect(await countSecurityScanCandidates(env.db, query)).toBe(1);
    await endedCheck(project.id);
    expect(await countSecurityScanCandidates(env.db, query)).toBe(1);
  });

  it('is never kept as the base row, and never pushes deployment scans out of retention', async () => {
    const { project } = await setup();
    await env.db.insert(securityScans).values([
      // The current base: the latest succeeded scan of a deployment, kept however old.
      {
        id: 'ss_base',
        project_id: project.id,
        deployment_id: 'dpl',
        trigger: 'deploy',
        status: 'succeeded',
        created_at: ago(200 * DAY),
        finished_at: ago(200 * DAY),
      },
      {
        id: 'ss_deploy',
        project_id: project.id,
        deployment_id: 'dpl',
        trigger: 'deploy',
        status: 'failed',
        created_at: ago(41 * DAY),
        finished_at: ago(41 * DAY),
      },
    ]);
    // A newer succeeded check, past the age limit: it goes, the base stays.
    await endedCheck(project.id, {
      id: 'scan_local_old',
      created_at: ago(190 * DAY),
      finished_at: ago(190 * DAY),
    });
    // More checks than the row limit, all newer than the deployment scan.
    await env.db.insert(securityScans).values(
      Array.from({ length: SECURITY_SCAN_ROWS_KEPT + 1 }, (_, index) => ({
        id: `scan_local_${String(index).padStart(3, '0')}`,
        project_id: project.id,
        deployment_id: null,
        trigger: 'local' as const,
        status: 'failed' as const,
        created_at: ago(40 * DAY - index * 1000),
        finished_at: ago(40 * DAY - index * 1000),
      })),
    );
    // The raw output sweep has passed every row.
    await env.ROUTING.put(
      SECURITY_RAW_SWEEP_CURSOR_KEY,
      JSON.stringify({ finishedAt: new Date().toISOString(), id: 'zzz' }),
    );
    expect(await deleteOldSecurityScanRows(env.db, env.ROUTING, Date.now())).toBe(2);
    const left = new Set(
      (await env.db.select({ id: securityScans.id }).from(securityScans)).map((row) => row.id),
    );
    expect(left.has('ss_base')).toBe(true);
    expect(left.has('ss_deploy')).toBe(true);
    expect(left.has('scan_local_old')).toBe(false);
    expect(left.has('scan_local_000')).toBe(false);
    expect(left.size).toBe(SECURITY_SCAN_ROWS_KEPT + 2);
  });

  it('leaves a project "never scanned" in the policy preview', async () => {
    const { project } = await setup();
    await endedCheck(project.id);
    const current = { ...defaultSecurityPolicy(), mode: 'disabled' as const, revision: 1 };
    const counts = await securityPolicyPreviewCounts(
      env.db,
      current,
      { ...current, mode: 'all' },
      {
        mode: { from: 'disabled', to: 'all' },
        defaultModel: null,
        blocked: [],
        unblocked: [],
        noticeAccepted: null,
        limits: [],
        publicGateOn: false,
        publicGateOff: false,
        sweeps: null,
        fallbackToCf: null,
        digest: null,
        repaired: false,
      },
    );
    expect(counts).toMatchObject({ scannedProjects: 1, firstFullScan: 1 });
  });

  it('does not make a rescan of the live deployment wait', async () => {
    await savePolicy();
    const { owner, project } = await setup();
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ bundle_stored: true })
      .where(eq(deployments.id, deployment.id));
    await env.STATIC_ASSETS_R2.put(
      `${securityScanInputPrefix(project.id, deployment.id)}modules.json`,
      '[]',
    );
    const checkId = await queuedCheck(project.id, owner.jwt);
    const { scanId } = await queueSecurityRescan(onEnv, env.db, project.id, { by: 'project' });
    expect(await scanRow(scanId)).toMatchObject({ trigger: 'rescan', status: 'queued' });
    expect((await scanRow(checkId)).status).toBe('queued');
  });
});
