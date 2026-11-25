import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { hmacSignState } from '../../src/auth/hmac.ts';
import {
  createDeployment,
  createOrRefreshProjectInvitation,
  createProject,
  getAccessibleProjectsByUserId,
  removeProjectMember,
  setProjectMemberRole,
} from '../../src/db.ts';
import app from '../../src/index.ts';
import {
  ProjectAccessDeniedError,
  ProjectOwnerSuspendedError,
  requireProjectCapability,
} from '../../src/project-access.ts';
import {
  deployments,
  projectMembers,
  projectOwnershipPeriods,
  projects,
  users,
} from '../../src/schema.ts';
import { clearTables, createTestUser, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
});

async function userWithEmail(login: string) {
  const user = await createTestUser(env.db, login);
  const email = `${login}@example.com`;
  await env.db.update(users).set({ email }).where(eq(users.id, user.id));
  return { ...user, email };
}

describe('project access', () => {
  it('grants implicit owner access without a member row', async () => {
    const owner = await createTestUser(env.db, 'implicit-owner');
    const project = await createProject(env.db, owner.id, 'implicit-access');

    const access = await requireProjectCapability(env.db, project.id, owner.id, 'delete');
    expect(access.role).toBe('owner');
    expect(access.owner.id).toBe(owner.id);
    expect(
      await env.db.select().from(projectMembers).where(eq(projectMembers.project_id, project.id)),
    ).toEqual([]);
  });

  it('enforces reader and collaborator capabilities using the owner for billing', async () => {
    const owner = await createTestUser(env.db, 'access-owner');
    const reader = await createTestUser(env.db, 'access-reader');
    const collaborator = await createTestUser(env.db, 'access-collaborator');
    const project = await createProject(env.db, owner.id, 'shared-access');
    await env.db.insert(projectMembers).values([
      {
        project_id: project.id,
        user_id: reader.id,
        role: 'reader',
        added_by_user_id: owner.id,
      },
      {
        project_id: project.id,
        user_id: collaborator.id,
        role: 'collaborator',
        added_by_user_id: owner.id,
      },
    ]);

    expect((await requireProjectCapability(env.db, project.id, reader.id, 'read')).owner.id).toBe(
      owner.id,
    );
    await expect(
      requireProjectCapability(env.db, project.id, reader.id, 'deploy'),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    expect(
      (await requireProjectCapability(env.db, project.id, collaborator.id, 'deploy')).role,
    ).toBe('collaborator');
    await expect(
      requireProjectCapability(env.db, project.id, collaborator.id, 'settings'),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);

    const accessible = await getAccessibleProjectsByUserId(env.db, reader.id);
    expect(accessible.map(({ project: item, role }) => [item.id, role])).toEqual([
      [project.id, 'reader'],
    ]);
  });

  it('suspends shared access only when the owner is manually suspended', async () => {
    const owner = await createTestUser(env.db, 'suspended-owner');
    const collaborator = await createTestUser(env.db, 'suspended-collaborator');
    const project = await createProject(env.db, owner.id, 'suspended-owner-project');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: collaborator.id,
      role: 'collaborator',
      added_by_user_id: owner.id,
    });

    await env.db
      .update(users)
      .set({ suspended_reason: 'platform policy violation' })
      .where(eq(users.id, owner.id));
    await expect(
      requireProjectCapability(env.db, project.id, collaborator.id, 'read'),
    ).rejects.toBeInstanceOf(ProjectOwnerSuspendedError);

    await env.db
      .update(users)
      .set({ suspended_reason: 'requests_exceeded' })
      .where(eq(users.id, owner.id));
    expect(
      (await requireProjectCapability(env.db, project.id, collaborator.id, 'deploy')).role,
    ).toBe('collaborator');
  });

  it('records owner attribution on new projects and deployments', async () => {
    const owner = await createTestUser(env.db, 'attribution-owner');
    const actor = await createTestUser(env.db, 'attribution-actor');
    const project = await createProject(env.db, owner.id, 'attribution');
    const [period] = await env.db
      .select()
      .from(projectOwnershipPeriods)
      .where(eq(projectOwnershipPeriods.project_id, project.id));
    expect(period).toMatchObject({ owner_user_id: owner.id, starts_at: project.created_at });

    const deployment = await createDeployment(env.db, project.id, '{}', 'manual', null, {
      initiatedByUserId: actor.id,
    });
    expect(deployment.billing_user_id).toBe(owner.id);
    expect(deployment.initiated_by_user_id).toBe(actor.id);
  });

  it('attributes projects and deployments inserted by the previous API revision', async () => {
    const owner = await createTestUser(env.db, 'legacy-attribution-owner');
    const [project] = await env.db
      .insert(projects)
      .values({ id: 'proj_legacy_attribution', user_id: owner.id, slug: 'legacy-attribution' })
      .returning();
    const [deployment] = await env.db
      .insert(deployments)
      .values({
        id: 'dpl_legacy_attribution',
        project_id: project.id,
        manifest: '{}',
      })
      .returning();

    expect(
      await env.db
        .select()
        .from(projectOwnershipPeriods)
        .where(eq(projectOwnershipPeriods.project_id, project.id)),
    ).toEqual([
      expect.objectContaining({
        project_id: project.id,
        owner_user_id: owner.id,
        starts_at: project.created_at,
      }),
    ]);
    expect(deployment.billing_user_id).toBe(owner.id);
  });

  it('rejects a team mutation after the actor loses admin access', async () => {
    const owner = await userWithEmail('lock-owner');
    const admin = await userWithEmail('lock-admin');
    const target = await userWithEmail('lock-target');
    const project = await createProject(env.db, owner.id, 'locked-auth');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: admin.id,
      role: 'admin',
      added_by_user_id: owner.id,
    });
    await setProjectMemberRole(env.db, {
      projectId: project.id,
      subjectUserId: admin.id,
      role: 'reader',
      actorUserId: owner.id,
    });

    await expect(
      createOrRefreshProjectInvitation(env.db, {
        projectId: project.id,
        email: target.email,
        role: 'reader',
        actorUserId: admin.id,
      }),
    ).rejects.toMatchObject({ reason: 'forbidden', status: 403 });
  });

  it('keeps the legacy internal verifier URL but live-checks deploy capability', async () => {
    const owner = await createTestUser(env.db, 'verify-owner');
    const reader = await createTestUser(env.db, 'verify-reader');
    const collaborator = await createTestUser(env.db, 'verify-collaborator');
    const project = await createProject(env.db, owner.id, 'verify-access');
    await env.db.insert(projectMembers).values([
      {
        project_id: project.id,
        user_id: reader.id,
        role: 'reader',
        added_by_user_id: owner.id,
      },
      {
        project_id: project.id,
        user_id: collaborator.id,
        role: 'collaborator',
        added_by_user_id: owner.id,
      },
    ]);
    const proxyOrigin = 'https://proxy.example.com';
    const internalAuth = await hmacSignState(
      `void-proxy-owner-v2\n${project.id}\n${proxyOrigin}`,
      env.JWT_SECRET,
    );
    const verify = (userId: string) =>
      app.fetch(
        new Request(`http://localhost/internal/verify-owner/${project.id}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-void-internal': internalAuth,
          },
          body: JSON.stringify({ userId, proxyOrigin }),
        }),
        env,
      );

    expect((await verify(owner.id)).status).toBe(200);
    expect((await verify(collaborator.id)).status).toBe(200);
    expect((await verify(reader.id)).status).toBe(403);
    await removeProjectMember(env.db, {
      projectId: project.id,
      subjectUserId: collaborator.id,
      actorUserId: owner.id,
    });
    expect((await verify(collaborator.id)).status).toBe(403);
  });
});
