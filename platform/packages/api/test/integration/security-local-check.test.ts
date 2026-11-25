import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { securityLocalTreeTar } from '@void/platform/security-local-check';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import app from '../../src/index.ts';
import { projectMembers } from '../../src/schema.ts';
import { ingestSecurityScanResult } from '../../src/security/ingest.ts';
import { prepareSecurityScanInputFiles } from '../../src/security/input/prepare.ts';
import { securityLocalTreeKey } from '../../src/security/local-check.ts';
import {
  securityFindingEvents,
  securityFindings,
  securityNotifications,
  securityScans,
} from '../../src/security/schema.ts';
import {
  clearTables,
  createTestProject,
  createTestUser,
  mockCfApi,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import {
  findingRecord,
  saveSecurityPolicy,
  scanResult,
  securityBindings,
} from './security-fixtures.ts';

const CF = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';

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
  onEnv = securityBindings(env, {
    scheduler: {
      fetch: async () => {
        pokes++;
        return Response.json({ ok: true });
      },
      forgetModelCalls: async () => 0,
    },
  });
  mockCfApi();
});

async function setup() {
  const slug = `app-${crypto.randomUUID().slice(0, 8)}`;
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

function call(path: string, jwt: string, options: { body?: unknown; bindings?: TestEnv } = {}) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: options.body === undefined ? 'GET' : 'POST',
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

/** The archive the CLI uploads, and the request that describes it. */
function tree() {
  const files = {
    'src/routes/users.ts':
      'export const GET = (c) => db.prepare(`SELECT * FROM users WHERE id = ${c.req.query("id")}`);\n',
    'void.config.ts': 'export default {};\n',
  };
  const entries = Object.entries(files).map(([path, text]) => ({
    path,
    data: new TextEncoder().encode(text),
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

async function scanRow(id: string) {
  const [row] = await env.db.select().from(securityScans).where(eq(securityScans.id, id));
  return row;
}

describe('local checks (I12)', () => {
  it('a check is stored apart: it opens no finding, event or email and is no project scan', async () => {
    await saveSecurityPolicy(env);
    const { owner, project, reader } = await setup();
    const { archive, request } = tree();
    const path = `/projects/${project.id}/security/checks`;
    expect((await call(path, reader.jwt, { body: request })).status).toBe(403);
    expect((await call(path, owner.jwt, { body: request, bindings: env })).status).toBe(501);

    const response = await call(path, owner.jwt, { body: request });
    expect(response.status).toBe(201);
    const { checkId } = await json(response);
    expect(await scanRow(checkId)).toMatchObject({
      trigger: 'local',
      deployment_id: null,
      status: 'pending_input',
    });
    await env.STATIC_ASSETS_R2.put(securityLocalTreeKey(project.id, checkId), archive);
    const started = await call(`${path}/${checkId}/start`, owner.jwt, { body: {} });
    expect(started.status).toBe(202);
    expect(pokes).toBe(1);

    // What the scheduler's claim does: the check is running attempt 1.
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
    expect(await prepareSecurityScanInputFiles(onEnv, env.db, checkId, 1)).not.toBeNull();
    const stored = await ingestSecurityScanResult(
      onEnv,
      env.db,
      checkId,
      1,
      scanResult(checkId, [findingRecord({ line_start: 1, line_end: 1 })], { model: CF }),
    );
    expect(stored).toMatchObject({ ok: true, kind: 'stored', status: 'succeeded', news: [] });
    expect(await env.db.select().from(securityFindings)).toHaveLength(0);
    expect(await env.db.select().from(securityFindingEvents)).toHaveLength(0);
    expect(await env.db.select().from(securityNotifications)).toHaveLength(0);
    expect(await env.STATIC_ASSETS_R2.get(securityLocalTreeKey(project.id, checkId))).toBeNull();

    const view = await json(await call(`${path}/${checkId}`, owner.jwt));
    expect(view).toMatchObject({ ended: true, result: { total: 1 } });
    // The project status still shows no scan: a local check is not a scan of what it serves.
    const status = await json(await call(`/projects/${project.id}/security`, owner.jwt));
    expect(status.lastScan).toBeNull();
    expect(status.lastSuccessfulScan).toBeNull();
  });
});
