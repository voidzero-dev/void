import { and, count, eq, gt, sql } from 'drizzle-orm';
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
import { createGitHubConnection, getBuild, upsertGitHubInstallation } from '../../src/db.ts';
import app from '../../src/index.ts';
// oxlint-disable-next-line import/no-namespace -- The test replaces or spies on members of the module object.
import * as projectAccess from '../../src/project-access.ts';
import {
  proxyTokenRotationStuckWarning,
  proxyTokenRotationTarget,
} from '../../src/proxy-token-rotation.ts';
import {
  projectAccessEvents,
  projectCleanupJobs,
  projectInvitations,
  projectMembers,
  projects,
  users,
} from '../../src/schema.ts';
import {
  captureQueries,
  createTestBuild,
  clearTables,
  createTestProject,
  createTestUser,
  recordingBuildManager,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
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
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

function request(
  path: string,
  jwt: string,
  init: { method?: string; body?: Record<string, unknown> } = {},
): Request {
  return new Request(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}

async function setEmail(userId: string, email: string): Promise<void> {
  await env.db.update(users).set({ email }).where(eq(users.id, userId));
}

async function invite(
  projectId: string,
  ownerJwt: string,
  email: string,
  role: 'reader' | 'collaborator' | 'admin',
): Promise<{ id: string; refreshed: boolean; delivery: { status: string } }> {
  const response = await app.fetch(
    request(`/projects/${projectId}/invitations`, ownerJwt, {
      method: 'POST',
      body: { email, role },
    }),
    env,
  );
  expect([200, 201]).toContain(response.status);
  const body = await response.json<{
    invitation: { id: string };
    refreshed: boolean;
    delivery: { status: string };
  }>();
  return { id: body.invitation.id, refreshed: body.refreshed, delivery: body.delivery };
}

describe('project team API', () => {
  it('lists the implicit owner and lets every member view the roster', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const reader = await createTestUser(env.db, 'reader');
    await setEmail(owner.id, 'owner@example.com');
    await setEmail(reader.id, 'reader@example.com');
    const project = await createTestProject(env.db, owner.id);
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: reader.id,
      role: 'reader',
      added_by_user_id: owner.id,
    });

    const response = await app.fetch(request(`/projects/${project.id}/members`, reader.jwt), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      members: [
        { user: { id: owner.id, login: 'owner' }, role: 'owner' },
        { user: { id: reader.id, login: 'reader' }, role: 'reader' },
      ],
    });

    const forbidden = await app.fetch(
      request(`/projects/${project.id}/invitations`, reader.jwt),
      env,
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: 'forbidden',
      message: expect.stringMatching(
        /requires the admin or owner role.*Ask a project admin or owner/,
      ),
    });
  });

  it('stops container builds when an authorizing admin is downgraded', async () => {
    const owner = await createTestUser(env.db, 'build-owner');
    const admin = await createTestUser(env.db, 'build-admin');
    const project = await createTestProject(env.db, owner.id, 'build-access-project');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: admin.id,
      role: 'admin',
      added_by_user_id: owner.id,
    });
    await upsertGitHubInstallation(env.db, {
      installationId: 'build-access-installation',
      userId: admin.id,
      accountLogin: admin.login,
      accountId: 'build-access-account',
      accountType: 'User',
      repositories: [{ full_name: `${admin.login}/app`, id: 7711 }],
    });
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'build-access-installation',
      repoFullName: `${admin.login}/app`,
      repositoryId: '7711',
      authorizedByUserId: admin.id,
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: owner.id,
      executor: 'container',
      status: 'building',
    });
    const { namespace, cancelledIds } = recordingBuildManager();

    const response = await app.fetch(
      request(`/projects/${project.id}/members/${admin.id}`, owner.jwt, {
        method: 'PATCH',
        body: { role: 'collaborator' },
      }),
      { ...env, BUILD_MANAGER: namespace },
    );

    expect(response.status).toBe(200);
    expect((await getBuild(env.db, build.id))?.status).toBe('cancelled');
    expect(cancelledIds).toEqual([build.id]);
  });

  it('requires an existing registered user and supports invitation acceptance', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const target = await createTestUser(env.db, 'target');
    await setEmail(owner.id, 'owner@example.com');
    await setEmail(target.id, 'Target@Example.com');
    const project = await createTestProject(env.db, owner.id, 'shared-app');

    const unknown = await app.fetch(
      request(`/projects/${project.id}/invitations`, owner.jwt, {
        method: 'POST',
        body: { email: 'missing@example.com', role: 'reader' },
      }),
      env,
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: 'registered user not found',
      message: expect.stringMatching(/Check the address.*sign in to this platform/),
    });

    const created = await invite(project.id, owner.jwt, 'target@example.com', 'collaborator');
    expect(created.delivery).toEqual({ status: 'not_configured' });

    const pending = await app.fetch(request('/me/project-invitations', target.jwt), env);
    expect(pending.status).toBe(200);
    expect(await pending.json()).toMatchObject({
      invitations: [
        {
          id: created.id,
          project: { id: project.id, slug: 'shared-app', owner: { id: owner.id } },
          invited_by: { id: owner.id },
          role: 'collaborator',
        },
      ],
    });

    const accepted = await app.fetch(
      request(`/project-invitations/${created.id}/accept`, target.jwt, { method: 'POST' }),
      env,
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      member: { user: { id: target.id }, role: 'collaborator' },
    });
  });

  it('rejects invitation acceptance while the project owner is manually suspended', async () => {
    const owner = await createTestUser(env.db, 'accept-suspended-owner');
    const target = await createTestUser(env.db, 'accept-suspended-target');
    await setEmail(target.id, 'accept-suspended@example.com');
    const project = await createTestProject(env.db, owner.id);
    const invitation = await invite(
      project.id,
      owner.jwt,
      'accept-suspended@example.com',
      'reader',
    );
    await env.db
      .update(users)
      .set({ suspended_reason: 'platform policy violation' })
      .where(eq(users.id, owner.id));

    const response = await app.fetch(
      request(`/project-invitations/${invitation.id}/accept`, target.jwt, { method: 'POST' }),
      env,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'project owner suspended',
      message: expect.stringMatching(/owner account is suspended.*platform administrator/),
    });
    expect(await env.db.select().from(projectMembers)).toEqual([]);

    await env.db
      .update(users)
      .set({ suspended_reason: 'requests_exceeded' })
      .where(eq(users.id, owner.id));
    const accepted = await app.fetch(
      request(`/project-invitations/${invitation.id}/accept`, target.jwt, { method: 'POST' }),
      env,
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ member: { role: 'reader' } });
  });

  it('rejects team mutations after project deletion begins', async () => {
    const owner = await createTestUser(env.db, 'deleting-team-owner');
    const invited = await createTestUser(env.db, 'deleting-team-invited');
    const other = await createTestUser(env.db, 'deleting-team-other');
    await setEmail(invited.id, 'deleting-team-invited@example.com');
    await setEmail(other.id, 'deleting-team-other@example.com');
    const project = await createTestProject(env.db, owner.id);
    const invitation = await invite(
      project.id,
      owner.jwt,
      'deleting-team-invited@example.com',
      'reader',
    );
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));

    const createResponse = await app.fetch(
      request(`/projects/${project.id}/invitations`, owner.jwt, {
        method: 'POST',
        body: { email: 'deleting-team-other@example.com', role: 'admin' },
      }),
      env,
    );
    expect(createResponse.status).toBe(409);
    expect(await createResponse.json()).toEqual({
      error: 'project is being deleted',
      message: expect.stringMatching(/Wait for deletion to finish/),
    });

    const acceptResponse = await app.fetch(
      request(`/project-invitations/${invitation.id}/accept`, invited.jwt, { method: 'POST' }),
      env,
    );
    expect(acceptResponse.status).toBe(409);
    expect(await acceptResponse.json()).toEqual({
      error: 'project is being deleted',
      message: expect.stringMatching(/Wait for deletion to finish/),
    });

    expect(await env.db.select().from(projectMembers)).toEqual([]);
    expect(await env.db.select().from(projectInvitations)).toMatchObject([
      { id: invitation.id, status: 'pending' },
    ]);
    expect(await env.db.select().from(projectAccessEvents)).toMatchObject([{ action: 'invited' }]);
  });

  it('rechecks owner suspension under the project lock before a team mutation', async () => {
    const owner = await createTestUser(env.db, 'team-race-owner');
    const admin = await createTestUser(env.db, 'team-race-admin');
    const target = await createTestUser(env.db, 'team-race-target');
    await setEmail(target.id, 'team-race-target@example.com');
    const project = await createTestProject(env.db, owner.id);
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: admin.id,
      role: 'admin',
      added_by_user_id: owner.id,
    });

    const requireCapability = projectAccess.requireProjectCapability;
    let suspended = false;
    vi.spyOn(projectAccess, 'requireProjectCapability').mockImplementation(async (...args) => {
      const access = await requireCapability(...args);
      if (!suspended && args[3] === 'members') {
        suspended = true;
        await env.db
          .update(users)
          .set({ suspended_reason: 'platform policy violation' })
          .where(eq(users.id, owner.id));
      }
      return access;
    });

    const response = await app.fetch(
      request(`/projects/${project.id}/invitations`, admin.jwt, {
        method: 'POST',
        body: { email: 'team-race-target@example.com', role: 'reader' },
      }),
      env,
    );
    expect(suspended).toBe(true);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'project owner suspended',
      message: expect.stringMatching(/owner account is suspended.*platform administrator/),
    });
    expect(await env.db.select().from(projectInvitations)).toEqual([]);
  });

  it('rechecks owner suspension under the project lock before a member leaves', async () => {
    const owner = await createTestUser(env.db, 'leave-race-owner');
    const member = await createTestUser(env.db, 'leave-race-member');
    const project = await createTestProject(env.db, owner.id);
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: member.id,
      role: 'reader',
      added_by_user_id: owner.id,
    });

    const requireCapability = projectAccess.requireProjectCapability;
    let suspended = false;
    vi.spyOn(projectAccess, 'requireProjectCapability').mockImplementation(async (...args) => {
      const access = await requireCapability(...args);
      if (!suspended && args[3] === 'read') {
        suspended = true;
        await env.db
          .update(users)
          .set({ suspended_reason: 'platform policy violation' })
          .where(eq(users.id, owner.id));
      }
      return access;
    });

    const response = await app.fetch(
      request(`/projects/${project.id}/leave`, member.jwt, { method: 'POST' }),
      env,
    );
    expect(suspended).toBe(true);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'project owner suspended',
      message: expect.stringMatching(/owner account is suspended.*platform administrator/),
    });
    expect(await env.db.select().from(projectMembers)).toHaveLength(1);
  });

  it('binds invitations to exactly one registered account and rejects owner/member conflicts', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const member = await createTestUser(env.db, 'member');
    const duplicateA = await createTestUser(env.db, 'duplicate-a');
    const duplicateB = await createTestUser(env.db, 'duplicate-b');
    await setEmail(owner.id, 'owner@example.com');
    await setEmail(member.id, 'member@example.com');
    await setEmail(duplicateA.id, 'duplicate@example.com');
    await setEmail(duplicateB.id, 'duplicate@example.com');
    const project = await createTestProject(env.db, owner.id);
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: member.id,
      role: 'reader',
      added_by_user_id: owner.id,
    });

    const inviteOwner = await app.fetch(
      request(`/projects/${project.id}/invitations`, owner.jwt, {
        method: 'POST',
        body: { email: 'OWNER@example.com', role: 'admin' },
      }),
      env,
    );
    expect(inviteOwner.status).toBe(409);
    expect(await inviteOwner.json()).toEqual({
      error: 'the project owner cannot be invited or changed as a member',
      message: expect.stringMatching(/owner already has full access.*Manage other members/),
    });

    const inviteMember = await app.fetch(
      request(`/projects/${project.id}/invitations`, owner.jwt, {
        method: 'POST',
        body: { email: 'member@example.com', role: 'admin' },
      }),
      env,
    );
    expect(inviteMember.status).toBe(409);
    expect(await inviteMember.json()).toEqual({
      error: 'user is already a project member',
      message: expect.stringMatching(/already a project member.*Refresh the member list/),
    });

    const ambiguous = await app.fetch(
      request(`/projects/${project.id}/invitations`, owner.jwt, {
        method: 'POST',
        body: { email: 'duplicate@example.com', role: 'reader' },
      }),
      env,
    );
    expect(ambiguous.status).toBe(404);
    expect(await ambiguous.json()).toEqual({
      error: 'registered user not found',
      message: expect.stringMatching(/Check the address.*sign in to this platform/),
    });
    expect(await env.db.select().from(projectInvitations)).toEqual([]);
  });

  it('serializes concurrent acceptance and records one membership and event', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const target = await createTestUser(env.db, 'target');
    await setEmail(target.id, 'target@example.com');
    const project = await createTestProject(env.db, owner.id);
    const invitation = await invite(project.id, owner.jwt, 'target@example.com', 'collaborator');

    const responses = await Promise.all([
      app.fetch(
        request(`/project-invitations/${invitation.id}/accept`, target.jwt, { method: 'POST' }),
        env,
      ),
      app.fetch(
        request(`/project-invitations/${invitation.id}/accept`, target.jwt, { method: 'POST' }),
        env,
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(
      await env.db
        .select()
        .from(projectMembers)
        .where(
          and(eq(projectMembers.project_id, project.id), eq(projectMembers.user_id, target.id)),
        ),
    ).toHaveLength(1);
    const events = await env.db
      .select()
      .from(projectAccessEvents)
      .where(eq(projectAccessEvents.project_id, project.id));
    expect(events.map((event) => event.action)).toEqual(['invited', 'accepted']);
  });

  it('does not let an accepted invitation recreate access after member removal', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const target = await createTestUser(env.db, 'target');
    await setEmail(target.id, 'target@example.com');
    const project = await createTestProject(env.db, owner.id);
    const invitation = await invite(project.id, owner.jwt, 'target@example.com', 'reader');

    expect(
      (
        await app.fetch(
          request(`/project-invitations/${invitation.id}/accept`, target.jwt, { method: 'POST' }),
          env,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.fetch(
          request(`/projects/${project.id}/members/${target.id}`, owner.jwt, {
            method: 'DELETE',
          }),
          env,
        )
      ).status,
    ).toBe(204);

    const replay = await app.fetch(
      request(`/project-invitations/${invitation.id}/accept`, target.jwt, { method: 'POST' }),
      env,
    );
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({
      error: 'project invitation is no longer pending',
      message: expect.stringMatching(/no longer pending.*send a new invitation/),
    });
    expect(
      await env.db
        .select()
        .from(projectMembers)
        .where(
          and(eq(projectMembers.project_id, project.id), eq(projectMembers.user_id, target.id)),
        ),
    ).toEqual([]);

    const fresh = await invite(project.id, owner.jwt, 'target@example.com', 'admin');
    expect(fresh.id).not.toBe(invitation.id);
    const acceptedFresh = await app.fetch(
      request(`/project-invitations/${fresh.id}/accept`, target.jwt, { method: 'POST' }),
      env,
    );
    expect(acceptedFresh.status).toBe(200);
    expect(await acceptedFresh.json()).toMatchObject({ member: { role: 'admin' } });
  });

  it('rejects forwarded response and cross-project management IDs without consuming the invite', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const target = await createTestUser(env.db, 'target');
    const bystander = await createTestUser(env.db, 'bystander');
    await setEmail(target.id, 'target@example.com');
    const source = await createTestProject(env.db, owner.id, 'source-project');
    const other = await createTestProject(env.db, owner.id, 'other-project');
    const invitation = await invite(source.id, owner.jwt, 'target@example.com', 'reader');
    const beforeInvitations = await env.db.select().from(projectInvitations);
    const beforeEvents = await env.db.select().from(projectAccessEvents);

    for (const action of ['accept', 'decline']) {
      const response = await app.fetch(
        request(`/project-invitations/${invitation.id}/${action}`, bystander.jwt, {
          method: 'POST',
        }),
        env,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'forbidden',
        message:
          'This invitation belongs to a different account. Sign in with the account that received it, or ask a project admin or owner to invite your current account.',
      });
      expect(await env.db.select().from(projectInvitations)).toEqual(beforeInvitations);
      expect(await env.db.select().from(projectAccessEvents)).toEqual(beforeEvents);
      expect(await env.db.select().from(projectMembers)).toEqual([]);
    }
    const crossProjectResend = await app.fetch(
      request(`/projects/${other.id}/invitations/${invitation.id}/resend`, owner.jwt, {
        method: 'POST',
      }),
      env,
    );
    expect(crossProjectResend.status).toBe(404);
    expect(await crossProjectResend.json()).toEqual({
      error: 'project invitation not found',
      message: expect.stringMatching(/Check your pending invitations.*send a new one/),
    });
    const crossProjectRevoke = await app.fetch(
      request(`/projects/${other.id}/invitations/${invitation.id}`, owner.jwt, {
        method: 'DELETE',
      }),
      env,
    );
    expect(crossProjectRevoke.status).toBe(404);
    expect(await crossProjectRevoke.json()).toEqual({
      error: 'project invitation not found',
      message: expect.stringMatching(/Check your pending invitations.*send a new one/),
    });
    expect(await env.db.select().from(projectInvitations)).toEqual(beforeInvitations);
    expect(await env.db.select().from(projectAccessEvents)).toEqual(beforeEvents);

    const targetAccept = await app.fetch(
      request(`/project-invitations/${invitation.id}/accept`, target.jwt, { method: 'POST' }),
      env,
    );
    expect(targetAccept.status).toBe(200);
  });

  it('refreshes, resends to the current account email, and revokes invitations', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const target = await createTestUser(env.db, 'target');
    await setEmail(owner.id, 'owner@example.com');
    await setEmail(target.id, 'old@example.com');
    const project = await createTestProject(env.db, owner.id);

    const first = await invite(project.id, owner.jwt, 'old@example.com', 'reader');
    const refreshed = await invite(project.id, owner.jwt, 'OLD@example.com', 'admin');
    expect(refreshed).toMatchObject({ id: first.id, refreshed: true });

    await setEmail(target.id, 'new@example.com');
    const resentResponse = await app.fetch(
      request(`/projects/${project.id}/invitations/${first.id}/resend`, owner.jwt, {
        method: 'POST',
      }),
      env,
    );
    expect(resentResponse.status).toBe(200);
    expect(await resentResponse.json()).toMatchObject({
      invitation: {
        id: first.id,
        target: { id: target.id, email: 'new@example.com' },
        target_email: 'new@example.com',
        role: 'admin',
      },
      delivery: { status: 'not_configured' },
    });

    const revoked = await app.fetch(
      request(`/projects/${project.id}/invitations/${first.id}`, owner.jwt, {
        method: 'DELETE',
      }),
      env,
    );
    expect(revoked.status).toBe(204);
    const beforeInvitations = await env.db.select().from(projectInvitations);
    const beforeEvents = await env.db.select().from(projectAccessEvents);

    const acceptRevoked = await app.fetch(
      request(`/project-invitations/${first.id}/accept`, target.jwt, { method: 'POST' }),
      env,
    );
    expect(acceptRevoked.status).toBe(409);
    expect(await acceptRevoked.json()).toEqual({
      error: 'project invitation is no longer pending',
      message: expect.stringMatching(/no longer pending.*send a new invitation/),
    });
    expect(await env.db.select().from(projectInvitations)).toEqual(beforeInvitations);
    expect(await env.db.select().from(projectAccessEvents)).toEqual(beforeEvents);
    expect(await env.db.select().from(projectMembers)).toEqual([]);
  });

  it('rate-limits create, refresh, and resend delivery while preserving invitations', async () => {
    // All delivery attempts must stay in the same UTC-minute rate-limit window.
    vi.setSystemTime(new Date());
    const owner = await createTestUser(env.db, 'owner');
    const target = await createTestUser(env.db, 'target');
    await setEmail(target.id, 'target@example.com');
    const project = await createTestProject(env.db, owner.id, 'delivery-limited');
    const send = vi.fn(async () => {});
    const emailEnv = {
      ...env,
      EMAIL: { send } as unknown as SendEmail,
      EMAIL_FROM: 'Void Platform <platform@example.com>',
      AUTH_REDIRECT_URI: 'http://localhost/auth/callback',
      PLATFORM_INSTALLATION_ID: 'test-installation',
    };
    const createOrRefresh = (role: 'reader' | 'collaborator' | 'admin') =>
      app.fetch(
        request(`/projects/${project.id}/invitations`, owner.jwt, {
          method: 'POST',
          body: { email: 'target@example.com', role },
        }),
        emailEnv,
      );

    const created = await createOrRefresh('reader');
    expect(created.status).toBe(201);
    const invitationId = (await created.json<{ invitation: { id: string } }>()).invitation.id;

    const refreshed = await createOrRefresh('admin');
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({
      invitation: { id: invitationId, role: 'admin' },
      refreshed: true,
      delivery: { status: 'sent' },
    });

    const resend = () =>
      app.fetch(
        request(`/projects/${project.id}/invitations/${invitationId}/resend`, owner.jwt, {
          method: 'POST',
        }),
        emailEnv,
      );
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await resend();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ delivery: { status: 'sent' } });
    }

    send.mockRejectedValueOnce(new Error('provider unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    let failed: Response;
    try {
      failed = await resend();
    } finally {
      consoleError.mockRestore();
    }
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({ delivery: { status: 'failed' } });

    const shortExpiry = new Date(Date.now() + 60_000).toISOString();
    await env.db
      .update(projectInvitations)
      .set({ expires_at: shortExpiry })
      .where(eq(projectInvitations.id, invitationId));
    const limited = await resend();
    expect(limited.status).toBe(200);
    expect(await limited.json()).toMatchObject({
      invitation: { id: invitationId, role: 'admin' },
      delivery: { status: 'rate_limited' },
    });
    expect(send).toHaveBeenCalledTimes(5);

    const [persisted] = await env.db
      .select()
      .from(projectInvitations)
      .where(eq(projectInvitations.id, invitationId));
    expect(persisted.status).toBe('pending');
    expect(Date.parse(persisted.expires_at)).toBeGreaterThan(Date.parse(shortExpiry));
  });

  it('applies the daily delivery limit without rolling back a new invitation', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const target = await createTestUser(env.db, 'target');
    await setEmail(target.id, 'target@example.com');
    const project = await createTestProject(env.db, owner.id, 'daily-delivery-limited');
    const now = new Date();
    const day = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(
      now.getUTCDate(),
    ).padStart(2, '0')}`;
    await env.ROUTING.put(`project-invitation-email-rate:${project.id}:${day}`, '50');
    const send = vi.fn(async () => {});

    const response = await app.fetch(
      request(`/projects/${project.id}/invitations`, owner.jwt, {
        method: 'POST',
        body: { email: 'target@example.com', role: 'reader' },
      }),
      {
        ...env,
        EMAIL: { send } as unknown as SendEmail,
        EMAIL_FROM: 'Void Platform <platform@example.com>',
        AUTH_REDIRECT_URI: 'http://localhost/auth/callback',
        PLATFORM_INSTALLATION_ID: 'test-installation',
      },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      invitation: { target: { id: target.id }, role: 'reader', status: 'pending' },
      delivery: { status: 'rate_limited' },
    });
    expect(send).not.toHaveBeenCalled();
    expect(await env.db.select().from(projectInvitations)).toHaveLength(1);
  });

  it('lets project admins invite and manage any non-owner member, and lets members leave', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const admin = await createTestUser(env.db, 'admin');
    const collaborator = await createTestUser(env.db, 'collaborator');
    const peerAdmin = await createTestUser(env.db, 'peer-admin');
    const invitee = await createTestUser(env.db, 'invitee');
    await setEmail(invitee.id, 'invitee@example.com');
    const project = await createTestProject(env.db, owner.id);
    await env.db.insert(projectMembers).values([
      {
        project_id: project.id,
        user_id: admin.id,
        role: 'admin',
        added_by_user_id: owner.id,
      },
      {
        project_id: project.id,
        user_id: collaborator.id,
        role: 'collaborator',
        added_by_user_id: owner.id,
      },
      {
        project_id: project.id,
        user_id: peerAdmin.id,
        role: 'admin',
        added_by_user_id: owner.id,
      },
    ]);

    const changed = await app.fetch(
      request(`/projects/${project.id}/members/${collaborator.id}`, admin.jwt, {
        method: 'PATCH',
        body: { role: 'admin' },
      }),
      env,
    );
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ member: { role: 'admin' } });

    const adminInvitation = await invite(project.id, admin.jwt, 'invitee@example.com', 'reader');
    const accepted = await app.fetch(
      request(`/project-invitations/${adminInvitation.id}/accept`, invitee.jwt, { method: 'POST' }),
      env,
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ member: { role: 'reader' } });

    const removedPeerAdmin = await app.fetch(
      request(`/projects/${project.id}/members/${peerAdmin.id}`, admin.jwt, {
        method: 'DELETE',
      }),
      env,
    );
    expect(removedPeerAdmin.status).toBe(204);

    const ownerConflict = await app.fetch(
      request(`/projects/${project.id}/members/${owner.id}`, admin.jwt, {
        method: 'PATCH',
        body: { role: 'reader' },
      }),
      env,
    );
    expect(ownerConflict.status).toBe(409);

    const ownerRemovalConflict = await app.fetch(
      request(`/projects/${project.id}/members/${owner.id}`, admin.jwt, {
        method: 'DELETE',
      }),
      env,
    );
    expect(ownerRemovalConflict.status).toBe(409);

    const leave = await app.fetch(
      request(`/projects/${project.id}/leave`, collaborator.jwt, { method: 'POST' }),
      env,
    );
    expect(leave.status).toBe(204);
    const [remaining] = await env.db
      .select()
      .from(projectMembers)
      .where(
        and(eq(projectMembers.project_id, project.id), eq(projectMembers.user_id, collaborator.id)),
      );
    expect(remaining).toBeUndefined();

    const ownerLeave = await app.fetch(
      request(`/projects/${project.id}/leave`, owner.jwt, { method: 'POST' }),
      env,
    );
    expect(ownerLeave.status).toBe(409);
    expect(await ownerLeave.json()).toEqual({
      error: 'the project owner cannot leave the project',
      message: expect.stringMatching(/Ask a platform administrator to transfer ownership/),
    });

    const events = await env.db
      .select()
      .from(projectAccessEvents)
      .where(eq(projectAccessEvents.project_id, project.id));
    expect(events.map((event) => event.action).sort()).toEqual(
      ['accepted', 'invited', 'left', 'member_removed', 'role_changed'].sort(),
    );
  });

  it('hides pending invitations once project deletion starts', async () => {
    const owner = await createTestUser(env.db, 'deleting-invitation-owner');
    const target = await createTestUser(env.db, 'deleting-invitation-target');
    await setEmail(target.id, 'deleting-target@example.com');
    const project = await createTestProject(env.db, owner.id, 'deleting-invitation-project');
    await invite(project.id, owner.jwt, 'deleting-target@example.com', 'reader');
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));

    const response = await app.fetch(request('/me/project-invitations', target.jwt), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ invitations: [] });
  });

  it('filters expired invitations and allows the target to decline a live invitation', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const target = await createTestUser(env.db, 'target');
    await setEmail(target.id, 'target@example.com');
    const project = await createTestProject(env.db, owner.id);
    const expired = await invite(project.id, owner.jwt, 'target@example.com', 'reader');
    await env.db
      .update(projectInvitations)
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where(eq(projectInvitations.id, expired.id));

    const pending = await app.fetch(request('/me/project-invitations', target.jwt), env);
    expect(await pending.json()).toEqual({ invitations: [] });

    const acceptExpired = await app.fetch(
      request(`/project-invitations/${expired.id}/accept`, target.jwt, { method: 'POST' }),
      env,
    );
    expect(acceptExpired.status).toBe(409);
    expect(await acceptExpired.json()).toEqual({
      error: 'project invitation has expired',
      message: expect.stringMatching(/expired.*resend.*renewed invitation/),
    });
    expect(
      (
        await env.db.select().from(projectInvitations).where(eq(projectInvitations.id, expired.id))
      )[0],
    ).toMatchObject({ status: 'expired' });

    const live = await invite(project.id, owner.jwt, 'target@example.com', 'reader');
    expect(live.id).not.toBe(expired.id);
    const declined = await app.fetch(
      request(`/project-invitations/${live.id}/decline`, target.jwt, { method: 'POST' }),
      env,
    );
    expect(declined.status).toBe(204);
    const declinedAgain = await app.fetch(
      request(`/project-invitations/${live.id}/decline`, target.jwt, { method: 'POST' }),
      env,
    );
    expect(declinedAgain.status).toBe(204);
  });

  it('refreshes an expired pending invitation using the same invitation ID', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const target = await createTestUser(env.db, 'target');
    await setEmail(target.id, 'target@example.com');
    const project = await createTestProject(env.db, owner.id);
    const expiredPending = await invite(project.id, owner.jwt, 'target@example.com', 'reader');
    await env.db
      .update(projectInvitations)
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where(eq(projectInvitations.id, expiredPending.id));

    const refreshed = await invite(project.id, owner.jwt, 'target@example.com', 'admin');
    expect(refreshed).toMatchObject({ id: expiredPending.id, refreshed: true });
    const [row] = await env.db
      .select()
      .from(projectInvitations)
      .where(eq(projectInvitations.id, expiredPending.id));
    expect(row).toMatchObject({ status: 'pending', role: 'admin' });
    expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.now());
    expect(await env.db.select().from(projectInvitations)).toHaveLength(1);
  });

  describe('pending invitation capacity', () => {
    async function seedInvitations(
      projectId: string,
      ownerId: string,
      liveCount: number,
    ): Promise<void> {
      const targets = Array.from({ length: liveCount + 1 }, (_, index) => ({
        id: `${projectId}-target-${index}`,
        provider: 'github',
        provider_id: `${projectId}-provider-${index}`,
        login: `target-${index}`,
        email: `target-${index}@example.com`,
      }));
      await env.db.insert(users).values(targets);
      await env.db.insert(projectInvitations).values(
        targets.map((target, index) => ({
          id: `${projectId}-invitation-${index}`,
          project_id: projectId,
          target_user_id: target.id,
          target_email_snapshot: target.email,
          role: 'reader' as const,
          invited_by_user_id: ownerId,
          expires_at:
            index < liveCount ? sql`now() + interval '1 day'` : sql`now() - interval '1 day'`,
        })),
      );
    }

    async function liveInvitationCount(projectId: string): Promise<number> {
      const [result] = await env.db
        .select({ count: count() })
        .from(projectInvitations)
        .where(
          and(
            eq(projectInvitations.project_id, projectId),
            eq(projectInvitations.status, 'pending'),
            gt(projectInvitations.expires_at, sql`now()`),
          ),
        );
      return result.count;
    }

    it.each(['create', 'refresh', 'resend'] as const)(
      'rejects %s at capacity without changing invitations, auditing, or emailing',
      async (action) => {
        const owner = await createTestUser(env.db, 'capacity-owner');
        const target = await createTestUser(env.db, 'capacity-new-target');
        await setEmail(target.id, 'new-target@example.com');
        const project = await createTestProject(env.db, owner.id);
        await seedInvitations(project.id, owner.id, 100);
        const before = await env.db.select().from(projectInvitations);
        const send = vi.fn().mockResolvedValue(undefined);

        const response = await app.fetch(
          action === 'resend'
            ? request(
                `/projects/${project.id}/invitations/${project.id}-invitation-100/resend`,
                owner.jwt,
                {
                  method: 'POST',
                },
              )
            : request(`/projects/${project.id}/invitations`, owner.jwt, {
                method: 'POST',
                body: {
                  email: action === 'create' ? 'new-target@example.com' : 'target-100@example.com',
                  role: 'admin',
                },
              }),
          { ...env, EMAIL: { send } as unknown as SendEmail },
        );

        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          error: 'project has too many pending invitations',
          message: expect.stringMatching(/pending invitation limit.*Revoke unused invitations/),
        });
        expect(await env.db.select().from(projectInvitations)).toEqual(before);
        expect(await liveInvitationCount(project.id)).toBe(100);
        expect(await env.db.select().from(projectAccessEvents)).toEqual([]);
        expect(send).not.toHaveBeenCalled();
      },
    );

    it.each(['create', 'refresh', 'resend'] as const)(
      'allows %s to consume the final live slot despite expired and historical invitations',
      async (action) => {
        const owner = await createTestUser(env.db, 'capacity-owner');
        const target = await createTestUser(env.db, 'capacity-new-target');
        await setEmail(target.id, 'new-target@example.com');
        const project = await createTestProject(env.db, owner.id);
        await seedInvitations(project.id, owner.id, 99);
        await env.db.insert(projectInvitations).values(
          (['accepted', 'declined', 'revoked', 'expired'] as const).map((status) => ({
            id: `${project.id}-history-${status}`,
            project_id: project.id,
            target_user_id: target.id,
            target_email_snapshot: 'new-target@example.com',
            role: 'reader' as const,
            invited_by_user_id: owner.id,
            status,
            expires_at: sql`now() + interval '1 day'`,
          })),
        );

        const response = await app.fetch(
          action === 'resend'
            ? request(
                `/projects/${project.id}/invitations/${project.id}-invitation-99/resend`,
                owner.jwt,
                {
                  method: 'POST',
                },
              )
            : request(`/projects/${project.id}/invitations`, owner.jwt, {
                method: 'POST',
                body: {
                  email: action === 'create' ? 'new-target@example.com' : 'target-99@example.com',
                  role: 'admin',
                },
              }),
          env,
        );

        expect(response.status).toBe(action === 'create' ? 201 : 200);
        expect(await response.json()).toMatchObject({
          invitation: {
            ...(action === 'create' ? {} : { id: `${project.id}-invitation-99` }),
            status: 'pending',
            role: action === 'resend' ? 'reader' : 'admin',
          },
        });
        expect(await liveInvitationCount(project.id)).toBe(100);
        expect(await env.db.select().from(projectAccessEvents)).toMatchObject([
          { action: action === 'resend' ? 'invitation_resent' : 'invited' },
        ]);
      },
    );

    it.each(['refresh', 'resend'] as const)(
      'allows %s of an existing live invitation at capacity without consuming another slot',
      async (action) => {
        const owner = await createTestUser(env.db, 'capacity-owner');
        const project = await createTestProject(env.db, owner.id);
        await seedInvitations(project.id, owner.id, 100);
        const invitationId = `${project.id}-invitation-0`;
        const [before] = await env.db
          .select()
          .from(projectInvitations)
          .where(eq(projectInvitations.id, invitationId));

        const response = await app.fetch(
          action === 'resend'
            ? request(`/projects/${project.id}/invitations/${invitationId}/resend`, owner.jwt, {
                method: 'POST',
              })
            : request(`/projects/${project.id}/invitations`, owner.jwt, {
                method: 'POST',
                body: { email: 'target-0@example.com', role: 'admin' },
              }),
          env,
        );

        expect(response.status).toBe(200);
        const [after] = await env.db
          .select()
          .from(projectInvitations)
          .where(eq(projectInvitations.id, invitationId));
        expect(Date.parse(after.expires_at)).toBeGreaterThan(Date.parse(before.expires_at));
        expect(after.role).toBe(action === 'resend' ? 'reader' : 'admin');
        expect(await liveInvitationCount(project.id)).toBe(100);
        expect(await env.db.select().from(projectInvitations)).toHaveLength(101);
        expect(await env.db.select().from(projectAccessEvents)).toHaveLength(1);
      },
    );

    it('serializes competing expired invitation renewals for the final live slot', async () => {
      const owner = await createTestUser(env.db, 'capacity-owner');
      const target = await createTestUser(env.db, 'capacity-resend-target');
      await setEmail(target.id, 'resend-target@example.com');
      const project = await createTestProject(env.db, owner.id);
      await seedInvitations(project.id, owner.id, 99);
      const resendId = `${project.id}-resend`;
      await env.db.insert(projectInvitations).values({
        id: resendId,
        project_id: project.id,
        target_user_id: target.id,
        target_email_snapshot: 'resend-target@example.com',
        role: 'reader',
        invited_by_user_id: owner.id,
        expires_at: sql`now() - interval '1 day'`,
      });

      const responses = await Promise.all([
        app.fetch(
          request(`/projects/${project.id}/invitations`, owner.jwt, {
            method: 'POST',
            body: { email: 'target-99@example.com', role: 'admin' },
          }),
          env,
        ),
        app.fetch(
          request(`/projects/${project.id}/invitations/${resendId}/resend`, owner.jwt, {
            method: 'POST',
          }),
          env,
        ),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(await liveInvitationCount(project.id)).toBe(100);
      expect(await env.db.select().from(projectAccessEvents)).toHaveLength(1);
    });
  });

  it('rejects acceptance when the invited account has become the project owner', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const target = await createTestUser(env.db, 'target');
    await setEmail(target.id, 'target@example.com');
    const project = await createTestProject(env.db, owner.id);
    const invitation = await invite(project.id, owner.jwt, 'target@example.com', 'reader');
    await env.db.update(projects).set({ user_id: target.id }).where(eq(projects.id, project.id));

    const response = await app.fetch(
      request(`/project-invitations/${invitation.id}/accept`, target.jwt, { method: 'POST' }),
      env,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'the project owner cannot be invited or changed as a member',
      message: expect.stringMatching(/owner already has full access.*Manage other members/),
    });
    expect(await env.db.select().from(projectMembers)).toEqual([]);
  });
});

describe('proxy token rotation on member changes', () => {
  async function rotationJob(projectId: string) {
    const [job] = await env.db
      .select()
      .from(projectCleanupJobs)
      .where(eq(projectCleanupJobs.target, proxyTokenRotationTarget(projectId)));
    return job;
  }

  async function projectWithMember(role: 'reader' | 'collaborator' | 'admin') {
    const owner = await createTestUser(env.db, 'rotation-owner');
    const member = await createTestUser(env.db, `rotation-${role}`);
    const project = await createTestProject(env.db, owner.id);
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: member.id,
      role,
      added_by_user_id: owner.id,
    });
    return { owner, member, project };
  }

  function change(
    projectId: string,
    jwt: string,
    userId: string,
    next: 'reader' | 'collaborator' | 'admin' | null,
  ): Promise<Response> {
    return Promise.resolve(
      app.fetch(
        request(
          `/projects/${projectId}/members/${userId}`,
          jwt,
          next ? { method: 'PATCH', body: { role: next } } : { method: 'DELETE' },
        ),
        env,
      ),
    );
  }

  it.each([
    { role: 'collaborator', next: null, reason: 'member-removed' },
    { role: 'admin', next: null, reason: 'member-removed' },
    { role: 'collaborator', next: 'reader', reason: 'member-role-changed' },
    { role: 'admin', next: 'reader', reason: 'member-role-changed' },
  ] as const)('requests a rotation when $role -> $next', async ({ role, next, reason }) => {
    const { owner, member, project } = await projectWithMember(role);
    const response = await change(project.id, owner.jwt, member.id, next);
    expect(response.ok).toBe(true);
    expect(await rotationJob(project.id)).toMatchObject({
      kind: 'proxy-token-rotation',
      project_id: project.id,
      payload: { phase: 'requested', reason },
    });
  });

  it.each([
    { role: 'reader', next: null },
    { role: 'reader', next: 'collaborator' },
    { role: 'collaborator', next: 'admin' },
  ] as const)('requests nothing when $role -> $next', async ({ role, next }) => {
    const { owner, member, project } = await projectWithMember(role);
    const response = await change(project.id, owner.jwt, member.id, next);
    expect(response.ok).toBe(true);
    expect(await rotationJob(project.id)).toBeUndefined();
  });

  it.each([
    { role: 'collaborator', rotates: true },
    { role: 'reader', rotates: false },
  ] as const)('requests a rotation when a $role leaves: $rotates', async ({ role, rotates }) => {
    const { member, project } = await projectWithMember(role);
    const response = await app.fetch(
      request(`/projects/${project.id}/leave`, member.jwt, { method: 'POST' }),
      env,
    );
    expect(response.status).toBe(204);
    const job = await rotationJob(project.id);
    if (rotates) {
      expect(job?.payload).toEqual({ phase: 'requested', reason: 'member-removed' });
    } else {
      expect(job).toBeUndefined();
    }
  });

  it('requests nothing when the member change fails', async () => {
    const { owner, member, project } = await projectWithMember('admin');
    const conflict = await change(project.id, member.jwt, owner.id, null);
    expect(conflict.status).toBe(409);
    expect(await rotationJob(project.id)).toBeUndefined();
  });

  it('writes the request under the project lock', async () => {
    const { owner, member, project } = await projectWithMember('collaborator');
    const { result, queries } = await captureQueries(env.db, () =>
      change(project.id, owner.jwt, member.id, null),
    );
    expect(result.status).toBe(204);
    const lockAt = queries.findIndex((query) => /from "projects".* for update/i.test(query));
    const insertAt = queries.findIndex((query) =>
      /insert into "project_cleanup_jobs"/i.test(query),
    );
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(insertAt).toBeGreaterThan(lockAt);
  });
});

describe('stuck rotation warning on the member list', () => {
  it('warns only owners and admins', async () => {
    const owner = await createTestUser(env.db, 'stuck-owner');
    const project = await createTestProject(env.db, owner.id);
    const jwts: Record<'reader' | 'collaborator' | 'admin', string> = {
      reader: '',
      collaborator: '',
      admin: '',
    };
    for (const role of ['reader', 'collaborator', 'admin'] as const) {
      const user = await createTestUser(env.db, `stuck-${role}`);
      await env.db.insert(projectMembers).values({
        project_id: project.id,
        user_id: user.id,
        role,
        added_by_user_id: owner.id,
      });
      jwts[role] = user.jwt;
    }

    const listAs = async (jwt: string) => {
      const response = await app.fetch(request(`/projects/${project.id}/members`, jwt), env);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain('cf boom');
      expect(text).not.toContain('user-x-dep');
      expect(text).not.toContain('mock-proxy-token');
      return JSON.parse(text) as { members: Array<unknown>; warnings?: Array<string> };
    };

    expect(await listAs(owner.jwt)).not.toHaveProperty('warnings');

    await env.db.insert(projectCleanupJobs).values({
      target: proxyTokenRotationTarget(project.id),
      project_id: project.id,
      kind: 'proxy-token-rotation',
      payload: { phase: 'patch', reason: 'member-removed' },
      attempts: 3,
      last_error: 'cf boom user-x-dep',
    });
    expect(await listAs(owner.jwt)).not.toHaveProperty('warnings');

    await env.db
      .update(projectCleanupJobs)
      .set({ attempts: 4 })
      .where(eq(projectCleanupJobs.target, proxyTokenRotationTarget(project.id)));
    for (const jwt of [owner.jwt, jwts.admin]) {
      const body = await listAs(jwt);
      expect(body.warnings).toEqual([proxyTokenRotationStuckWarning(project.id)]);
      expect(body.members).toHaveLength(4);
    }
    for (const jwt of [jwts.reader, jwts.collaborator]) {
      expect(await listAs(jwt)).not.toHaveProperty('warnings');
    }
  });
});
