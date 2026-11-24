import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test';
import { app } from '../../src/index.ts';
import { operatorEvents } from '../../src/schema.ts';
import {
  reconcileProjectZeroTrust,
  setProjectZeroTrustProtection,
} from '../../src/zero-trust/project.ts';
import {
  clearTables,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

vi.mock('../../src/zero-trust/project.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/zero-trust/project.ts')>()),
  setProjectZeroTrustProtection: vi.fn(async () => ({})),
  reconcileProjectZeroTrust: vi.fn(async () => ({})),
}));

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
  vi.mocked(setProjectZeroTrustProtection).mockClear();
  vi.mocked(reconcileProjectZeroTrust).mockClear();
});

function post(path: string, cookie: string, form: Record<string, string> = {}) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        Cookie: `admin_token=${cookie}`,
        Origin: 'http://localhost',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
      redirect: 'manual',
    }),
    env,
  );
}

describe('admin project Zero Trust actions', () => {
  test('changes protection, audits it, and returns to the Zero Trust section', async () => {
    const admin = await createTestUser(env.db, 'zt-action', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'zt-action-project');

    const res = await post(`/admin/projects/${project.id}/zero-trust`, admin.adminJwt, {
      protected: 'true',
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`/admin/projects/${project.id}#zero-trust`);
    expect(setProjectZeroTrustProtection).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      project.id,
      true,
    );
    expect((await env.db.select().from(operatorEvents)).map((event) => event.action)).toEqual([
      `zero-trust/projects/${project.id}`,
    ]);
  });

  test('reconciles a project and returns to the Zero Trust section', async () => {
    const admin = await createTestUser(
      env.db,
      'zt-reconcile',
      'github',
      undefined,
      'free',
      'admin',
    );
    const project = await createTestProject(env.db, admin.id, 'zt-reconcile-project');

    const res = await post(`/admin/projects/${project.id}/zero-trust/reconcile`, admin.adminJwt);

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`/admin/projects/${project.id}#zero-trust`);
    expect(reconcileProjectZeroTrust).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      project.id,
    );
  });
});
