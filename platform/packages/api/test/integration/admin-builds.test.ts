import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vite-plus/test';
import { deserializePageData } from 'void/pages-server';
import { updateBuildStatus } from '../../src/db.ts';
import { app } from '../../src/index.ts';
import { builds } from '../../src/schema.ts';
import { BUILD_INSTANCE_LARGE } from '../../src/tiers.ts';
import {
  createTestBuild,
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  createTestDeployment,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  // `builds` references projects/users without ON DELETE cascade, so clear it
  // before `clearTables` (which deletes projects/users) to avoid FK violations.
  await env.db.delete(builds);
  await clearTables(env.db);
});

function req(path: string, cookie?: string): Response | Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) {
    headers.Cookie = `admin_token=${cookie}`;
  }
  return app.fetch(new Request(`http://localhost${path}`, { headers, redirect: 'manual' }), env);
}

/**
 * A spy DurableObjectNamespace whose `get().fetch()` records the path it was
 * called with and returns a fixed `/logs` payload. Lets a test assert WHICH
 * namespace (`BUILD_MANAGER` vs `BUILD_MANAGER_LARGE`) the route resolved.
 */
function spyNamespace(payload: unknown): {
  ns: DurableObjectNamespace;
  calls: Array<string>;
} {
  const calls: Array<string> = [];
  const ns = {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (_id: unknown) => ({
      fetch: async (input: Request | string) => {
        const u = typeof input === 'string' ? input : input.url;
        calls.push(u);
        return Response.json(payload);
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { ns, calls };
}

async function admin(): Promise<string> {
  const user = await createTestUser(env.db, 'admin', 'github', undefined, 'free', 'admin');
  return user.adminJwt;
}

describe('GET /admin/builds/:id/logs', () => {
  test('Fate exposes build logs and status through the admin-only endpoint', async () => {
    const cookie = await admin();
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
    });
    const base = spyNamespace({
      lines: [{ seq: 1, line: 'ready', stream: 'stdout', ts: 1 }],
      lastSeq: 1,
      terminal: true,
      logsComplete: false,
    });
    env.BUILD_MANAGER = base.ns;
    const response = await app.fetch(
      new Request('http://localhost/admin/fate', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost',
          Cookie: `admin_token=${cookie}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          version: 1,
          operations: [
            {
              id: 'logs',
              kind: 'query',
              name: 'buildLogs',
              args: { id: build.id, since: 0 },
              select: ['id', 'lines', 'lastSeq', 'terminal', 'logsComplete'],
            },
            {
              id: 'status',
              kind: 'query',
              name: 'buildStatus',
              args: { id: build.id },
              select: ['id', 'status', 'terminal'],
            },
          ],
        }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      results: Array<{
        ok: boolean;
        data?: {
          lines?: Array<{ line: string }>;
          lastSeq?: number;
          terminal?: boolean;
          logsComplete?: boolean | null;
        };
      }>;
    };
    expect(result.results[0]?.ok).toBe(true);
    expect(result.results[0]?.data?.lines?.[0]?.line).toBe('ready');
    expect(result.results[0]?.data?.lastSeq).toBe(1);
    expect(result.results[0]?.data?.terminal).toBe(true);
    expect(result.results[0]?.data?.logsComplete).toBe(false);
    expect(result.results[1]?.data?.terminal).toBe(false);
    expect(base.calls).toHaveLength(1);
  });

  test('container build routes the DO via instance_type — free/null hits BUILD_MANAGER', async () => {
    const cookie = await admin();
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      instanceType: null,
    });

    const base = spyNamespace({
      lines: [{ seq: 1, line: 'hi', stream: 'stdout', ts: 1 }],
      lastSeq: 1,
    });
    const large = spyNamespace({ lines: [], lastSeq: 0 });
    env.BUILD_MANAGER = base.ns;
    env.BUILD_MANAGER_LARGE = large.ns;

    const res = await req(`/admin/builds/${build.id}/logs?since=0`, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: Array<unknown>; lastSeq: number };
    expect(body.lastSeq).toBe(1);
    expect(body.lines).toHaveLength(1);

    expect(base.calls).toHaveLength(1);
    expect(large.calls).toHaveLength(0);
    expect(base.calls[0]).toContain('/logs?since=0');
  });

  test('container build with standard-4 hits BUILD_MANAGER_LARGE', async () => {
    const cookie = await admin();
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      instanceType: BUILD_INSTANCE_LARGE,
    });

    const base = spyNamespace({ lines: [], lastSeq: 0 });
    const large = spyNamespace({
      lines: [{ seq: 5, line: 'big', stream: 'stdout', ts: 2 }],
      lastSeq: 5,
    });
    env.BUILD_MANAGER = base.ns;
    env.BUILD_MANAGER_LARGE = large.ns;

    const res = await req(`/admin/builds/${build.id}/logs?since=3`, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: Array<unknown>; lastSeq: number };
    expect(body.lastSeq).toBe(5);

    expect(large.calls).toHaveLength(1);
    expect(base.calls).toHaveLength(0);
    expect(large.calls[0]).toContain('/logs?since=3');
  });

  test('missing/NaN since is treated as 0', async () => {
    const cookie = await admin();
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
    });

    const base = spyNamespace({ lines: [], lastSeq: 0 });
    env.BUILD_MANAGER = base.ns;

    const res = await req(`/admin/builds/${build.id}/logs?since=not-a-number`, cookie);
    expect(res.status).toBe(200);
    expect(base.calls[0]).toContain('/logs?since=0');
  });

  test('github_actions build returns external logs_url with NO DO call', async () => {
    const cookie = await admin();
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const logsUrl = 'https://github.com/acme/app/actions/runs/123';
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      logsUrl,
    });

    const base = spyNamespace({
      lines: [{ seq: 9, line: 'should not be read', stream: 'stdout', ts: 9 }],
      lastSeq: 9,
    });
    const large = spyNamespace({ lines: [], lastSeq: 0 });
    env.BUILD_MANAGER = base.ns;
    env.BUILD_MANAGER_LARGE = large.ns;

    const res = await req(`/admin/builds/${build.id}/logs`, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lines: Array<unknown>;
      lastSeq: number;
      external: string | null;
    };
    expect(body.lines).toEqual([]);
    expect(body.lastSeq).toBe(0);
    expect(body.external).toBe(logsUrl);

    expect(base.calls).toHaveLength(0);
    expect(large.calls).toHaveLength(0);
  });

  test('missing build returns 404', async () => {
    const cookie = await admin();
    const res = await req('/admin/builds/bld_does_not_exist/logs', cookie);
    expect(res.status).toBe(404);
  });

  test('requires admin auth', async () => {
    const res = await req('/admin/builds/bld_anything/logs');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/login');
  });
});

describe('project detail Builds section', () => {
  test('renders a Builds section with a row per build and marks the ongoing build active', async () => {
    const cookie = await admin();
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    // An ongoing (ACTIVE) build and a terminal build.
    const ongoing = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      commitSha: 'abc1234567890',
      branch: 'main',
      instanceType: null,
    });
    await updateBuildStatus(env.db, ongoing.id, 'building');
    const done = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      commitSha: 'def9876543210',
      branch: 'feat/x',
    });
    await updateBuildStatus(env.db, done.id, 'complete');

    const res = await req(`/admin/projects/${project.id}`, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('Builds');
    // Both builds link to their build pages.
    expect(html).toContain(`/admin/builds/${ongoing.id}`);
    expect(html).toContain(`/admin/builds/${done.id}`);
    // Short commit shown, not the full sha.
    expect(html).toContain('abc1234');
    expect(html).toContain('building');
    expect(html).toContain('complete');
    expect(html).toContain('github_actions');

    // The ongoing row carries the active-build highlight class; the terminal
    // row does not.
    const ongoingRow = tableRowContaining(html, `/admin/builds/${ongoing.id}`);
    const doneRow = tableRowContaining(html, `/admin/builds/${done.id}`);
    expect(ongoingRow).toContain('build-active');
    expect(doneRow).not.toContain('build-active');
  });

  test('renders "No builds." when a project has no builds', async () => {
    const cookie = await admin();
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const res = await req(`/admin/projects/${project.id}`, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Builds');
    expect(html).toContain('No builds.');
  });
});

describe('GET /admin/builds/:id (build page)', () => {
  test('container build renders a live log panel and the poll target', async () => {
    const cookie = await admin();
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      commitSha: 'cafebabe000000',
      branch: 'main',
      instanceType: null,
    });
    await updateBuildStatus(env.db, build.id, 'building');

    const res = await req(`/admin/builds/${build.id}`, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain(build.id);
    expect(html).toContain('container');
    expect(html).toContain('building');
    expect(html).toContain('cafebab');
    // The React log panel receives the build ID and starts with its loading state.
    expect(html).toContain('id="build-log"');
    expect(
      deserializePageData(
        html.match(/<script id="__VOID_PAGE_DATA__"[^>]*>([\s\S]*?)<\/script>/)![1],
      ),
    ).toMatchObject({ component: 'buildDetail' });
    expect(html).toContain('Loading logs...');
    // No external GitHub link for a container build.
    expect(html).not.toContain('View logs on GitHub');
  });

  test('github_actions build renders the GitHub logs link and NO log panel', async () => {
    const cookie = await admin();
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const logsUrl = 'https://github.com/acme/app/actions/runs/123';
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      commitSha: 'deadbeef000000',
      branch: 'main',
      logsUrl,
    });
    await updateBuildStatus(env.db, build.id, 'complete');

    const res = await req(`/admin/builds/${build.id}`, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();

    // External link present; no live log panel.
    expect(html).toContain('View logs on GitHub');
    expect(html).toContain(logsUrl);
    expect(html).not.toContain('id="build-log"');
  });

  test('links to the resulting deployment when deployment_id is set', async () => {
    const cookie = await admin();
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
    });
    await updateBuildStatus(env.db, build.id, 'complete', { deploymentId: deployment.id });

    const res = await req(`/admin/builds/${build.id}`, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`/admin/deployments/${deployment.id}`);
  });

  test('missing build returns 404', async () => {
    const cookie = await admin();
    const res = await req('/admin/builds/bld_does_not_exist', cookie);
    expect(res.status).toBe(404);
  });

  test('requires admin auth', async () => {
    const res = await req('/admin/builds/bld_anything');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/login');
  });
});

function tableRowContaining(html: string, needle: string): string {
  const needleIndex = html.indexOf(needle);
  expect(needleIndex).toBeGreaterThan(-1);
  const rowStart = html.lastIndexOf('<tr', needleIndex);
  const rowEnd = html.indexOf('</tr>', needleIndex);
  expect(rowStart).toBeGreaterThan(-1);
  expect(rowEnd).toBeGreaterThan(rowStart);
  return html.slice(rowStart, rowEnd);
}
