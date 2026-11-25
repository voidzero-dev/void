import { eq } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vite-plus/test';
import {
  deleteUser,
  getProject,
  getUser,
  LastAdminError,
  prepareUserRemoval,
  suspendUser,
} from '../../src/db.ts';
import { app } from '../../src/index.ts';
import { resources, users } from '../../src/schema.ts';
import { isAdminSuspended } from '../../src/suspension.ts';
import {
  clearTables,
  createOperatorToken,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;
let admin: Awaited<ReturnType<typeof createTestUser>>;
let token: string;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
  admin = await createTestUser(env.db, 'last-admin', 'github', undefined, 'custom', 'admin');
  token = await createOperatorToken(env.db, admin);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function remove(id: string, action: 'delete' | 'suspend', dryRun = false) {
  return app.fetch(
    new Request(`http://localhost/operator/v1/users/${id}/${action}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun }),
    }),
    env,
  );
}

describe('last active administrator protection', () => {
  test.each(['delete', 'suspend'] as const)(
    'rejects %s and its preview before touching projects or external resources',
    async (action) => {
      const project = await createTestProject(env.db, admin.id, `protected-${action}`);
      const suspended = await createTestUser(
        env.db,
        'inactive-admin',
        'github',
        undefined,
        'custom',
        'admin',
      );
      await env.db
        .update(users)
        .set({ suspended_reason: 'security_review' })
        .where(eq(users.id, suspended.id));
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const putSpy = vi.spyOn(env.ROUTING, 'put');
      const deleteSpy = vi.spyOn(env.ROUTING, 'delete');
      for (const dryRun of [true, false]) {
        const response = await remove(admin.id, action, dryRun);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: 'last_admin' });
      }
      expect(await getUser(env.db, admin.id)).toMatchObject({
        role: 'admin',
        suspended_reason: null,
      });
      expect(await getProject(env.db, project.id)).toMatchObject({ status: 'active' });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(putSpy).not.toHaveBeenCalled();
      expect(deleteSpy).not.toHaveBeenCalled();
    },
  );

  test.each(['delete', 'suspend'] as const)(
    'protects the browser %s endpoint too',
    async (action) => {
      const response = await app.fetch(
        new Request(`http://localhost/admin/users/${admin.id}/${action}`, {
          method: 'POST',
          headers: {
            Origin: 'http://localhost',
            Cookie: `admin_token=${admin.adminJwt}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: '',
        }),
        env,
      );
      expect(response.status).toBe(409);
      expect(await response.text()).toContain('last active administrator');
      expect(await getUser(env.db, admin.id)).toMatchObject({
        role: 'admin',
        suspended_reason: null,
      });
    },
  );

  test('guards low-level deletion, demotion, and manual suspension but permits usage enforcement', async () => {
    await expect(deleteUser(env.db, admin.id)).rejects.toBeInstanceOf(LastAdminError);
    await expect(prepareUserRemoval(env.db, admin.id, { kind: 'delete' })).rejects.toBeInstanceOf(
      LastAdminError,
    );
    await expect(suspendUser(env.db, admin.id, 'admin_suspended')).rejects.toBeInstanceOf(
      LastAdminError,
    );
    await suspendUser(env.db, admin.id, 'requests_exceeded');
    expect(await getUser(env.db, admin.id)).toMatchObject({
      role: 'admin',
      suspended_reason: 'requests_exceeded',
    });
    expect((await remove(admin.id, 'delete')).status).toBe(409);
  });

  test.each(['requests_exceeded', 'sandbox_runtime_exceeded'])(
    'counts an administrator limited by %s as still able to administer',
    async (reason) => {
      const other = await createTestUser(
        env.db,
        'quota-admin',
        'github',
        undefined,
        'custom',
        'admin',
      );
      await suspendUser(env.db, other.id, reason);
      expect((await remove(admin.id, 'delete', true)).status).toBe(200);
      expect(await getUser(env.db, admin.id)).toMatchObject({ role: 'admin' });
      expect((await remove(admin.id, 'delete')).status).toBe(200);
      expect(await getUser(env.db, admin.id)).toBeNull();
      expect(await getUser(env.db, other.id)).toMatchObject({
        role: 'admin',
        suspended_reason: reason,
      });
    },
  );

  test.each([
    ['delete', 'delete'],
    ['suspend', 'suspend'],
    ['delete', 'suspend'],
  ] as const)('serializes concurrent %s and %s before cleanup', async (first, second) => {
    const other = await createTestUser(
      env.db,
      'concurrent-admin',
      'github',
      undefined,
      'custom',
      'admin',
    );
    const prepare = (id: string, kind: 'delete' | 'suspend') =>
      prepareUserRemoval(
        env.db,
        id,
        kind === 'delete' ? { kind } : { kind, reason: 'admin_suspended' },
      );
    const results = await Promise.allSettled([prepare(admin.id, first), prepare(other.id, second)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(LastAdminError);
    const remaining = await env.db.select().from(users);
    expect(
      remaining.filter((user) => user.role === 'admin' && !isAdminSuspended(user.suspended_reason)),
    ).toHaveLength(1);
  });

  test.each(['requests_exceeded', 'sandbox_runtime_exceeded'])(
    'does not let a delayed %s event undo manual administrator suspension',
    async (reason) => {
      const other = await createTestUser(
        env.db,
        'manually-suspended-admin',
        'github',
        undefined,
        'custom',
        'admin',
      );
      await prepareUserRemoval(env.db, other.id, { kind: 'suspend', reason: 'security_review' });
      await suspendUser(env.db, other.id, reason);
      expect(await getUser(env.db, other.id)).toMatchObject({
        suspended_reason: 'security_review',
      });
      expect((await remove(admin.id, 'delete')).status).toBe(409);
      expect((await remove(other.id, 'suspend')).status).toBe(200);
      expect(await getUser(env.db, other.id)).toMatchObject({
        suspended_reason: 'admin_suspended',
      });
    },
  );

  test('retains administrator revocation when deletion cleanup fails without hiding its checkpoints', async () => {
    const other = await createTestUser(
      env.db,
      'deleting-admin',
      'github',
      undefined,
      'custom',
      'admin',
    );
    const project = await createTestProject(env.db, other.id, 'deleting-admin-project');
    await env.db.insert(resources).values({
      id: 'failed-admin-container',
      project_id: project.id,
      type: 'container',
      binding_name: 'SANDBOX',
      cf_id: 'failed-container',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unavailable', { status: 500 })),
    );
    const response = await remove(other.id, 'delete');
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: 'partial_failure',
      details: { adminAccessRevoked: true },
    });
    expect(await getUser(env.db, other.id)).toMatchObject({ role: 'user' });
    expect(await getProject(env.db, project.id)).toMatchObject({ status: 'deleting' });
    expect((await remove(admin.id, 'delete')).status).toBe(409);
  });

  test('retains administrator suspension when routing fan-out fails', async () => {
    const other = await createTestUser(
      env.db,
      'suspending-admin',
      'github',
      undefined,
      'custom',
      'admin',
    );
    const project = await createTestProject(env.db, other.id, 'suspending-admin-project');
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'worker', projectId: project.id }),
    );
    vi.spyOn(env.ROUTING, 'put').mockRejectedValue(new Error('routing unavailable'));
    const response = await remove(other.id, 'suspend');
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: 'partial_failure',
      details: { adminAccessRevoked: true },
    });
    expect(await getUser(env.db, other.id)).toMatchObject({
      role: 'admin',
      suspended_reason: 'admin_suspended',
    });
    expect((await remove(admin.id, 'suspend')).status).toBe(409);
  });
});
