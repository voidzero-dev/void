import {
  defaultSecurityPolicy,
  SECURITY_POLICY_SETTINGS_KEY,
} from '@void/platform/security-policy';
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
import type { ApiEnv } from '../../src/env.ts';
import { setPlatformSetting } from '../../src/platform-settings.ts';
import {
  projectZeroTrust,
  securityFindings,
  securityProjectEvents,
  securityPublicRequests,
  securityScanBypasses,
  securityScans,
} from '../../src/schema.ts';
import { SecurityApiError } from '../../src/security/errors.ts';
import {
  bypassPublicRequest,
  reconcilePendingPublicRequests,
  recheckPublicRequest,
} from '../../src/security/public-gate-flow.ts';
import {
  configurePlatformZeroTrust,
  disablePlatformZeroTrust,
} from '../../src/zero-trust/installation.ts';
import { setProjectZeroTrustProtection } from '../../src/zero-trust/project.ts';
import {
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function bindings(): ApiEnv['Bindings'] {
  return {
    ...env,
    SITE_DOMAIN: 'apps.example.com',
    PLATFORM_INSTALLATION_ID: 'installation-test',
    PLATFORM_CAPABILITIES: JSON.stringify({
      ...getPlatformCapabilities(env),
      securityAudits: true,
    }),
    SECURITY_SCAN_SCHEDULER: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    },
  } as unknown as ApiEnv['Bindings'];
}

const input = {
  apiToken: 'access-management-token',
  identityProviderIds: ['idp-1'],
  policyIds: ['policy-1'],
  protectNewProjects: true,
  existingProjects: 'public' as const,
};

function accessApi() {
  const applications = new Map<string, Record<string, unknown>>();
  let nextApplication = 1;
  const fetcher = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
    const url = new URL(request.toString());
    const path = url.pathname.split('/access/')[1] ?? '';
    if (path === 'organizations') {
      return Response.json({
        success: true,
        result: { auth_domain: 'company.cloudflareaccess.com' },
      });
    }
    if (path === 'identity_providers/idp-1') {
      return Response.json({ success: true, result: { id: 'idp-1', name: 'Company SSO' } });
    }
    if (path === 'policies/policy-1') {
      return Response.json({
        success: true,
        result: {
          id: 'policy-1',
          decision: 'allow',
          include: [{ email_domain: { domain: 'example.com' } }],
        },
      });
    }
    if (path === 'apps' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const id = `app-${nextApplication++}`;
      const application = { ...body, id, aud: `aud-${id}` };
      applications.set(id, application);
      return Response.json({ success: true, result: application });
    }
    if (path === 'apps') {
      return Response.json({ success: true, result: [...applications.values()] });
    }
    const match = path.match(/^apps\/([^/]+)$/);
    if (match && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const previous = applications.get(match[1]!);
      const application = { ...body, id: match[1], aud: previous?.aud ?? `aud-${match[1]}` };
      applications.set(match[1]!, application);
      return Response.json({ success: true, result: application });
    }
    if (match && init?.method === 'DELETE') {
      applications.delete(match[1]!);
      return Response.json({ success: true, result: { id: match[1] } });
    }
    if (match) {
      const application = applications.get(match[1]!);
      return application
        ? Response.json({ success: true, result: application })
        : Response.json({ success: false, errors: [{ message: 'not found' }] }, { status: 404 });
    }
    throw new Error(`unexpected Cloudflare request: ${url}`);
  });
  return { applications, fetcher };
}

async function savePolicy(publicGate: boolean) {
  await setPlatformSetting(env.db, SECURITY_POLICY_SETTINGS_KEY, {
    ...defaultSecurityPolicy(),
    mode: 'all',
    publicGate,
    revision: 1,
  });
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** A protected project with a live deployment, the gate on. */
async function setup() {
  vi.stubGlobal('fetch', accessApi().fetcher);
  const platform = bindings();
  await configurePlatformZeroTrust(platform, env.db, input);
  await savePolicy(true);
  const user = await createTestUser(env.db, `gate-${crypto.randomUUID()}`);
  const project = await createTestProject(env.db, user.id);
  const deployment = await createTestDeployment(env.db, project.id, 'live');
  await env.ROUTING.put(
    project.slug,
    JSON.stringify({
      projectId: project.id,
      userId: user.id,
      workerName: `user-${project.slug}-${deployment.id}`,
      version: deployment.id,
    }),
  );
  await setProjectZeroTrustProtection(platform, env.db, project.id, true);
  return { platform, user, project, deployment };
}

function ask(s: Setup, protectedAfter = false) {
  return setProjectZeroTrustProtection(s.platform, env.db, s.project.id, protectedAfter, {
    actorUserId: s.user.id,
  });
}

async function ztRow(projectId: string) {
  const [row] = await env.db
    .select()
    .from(projectZeroTrust)
    .where(eq(projectZeroTrust.project_id, projectId));
  return row!;
}

async function succeededScan(s: Setup, id = 'ss_ok') {
  await env.db.insert(securityScans).values({
    id,
    project_id: s.project.id,
    deployment_id: s.deployment.id,
    status: 'succeeded',
    trigger: 'deploy',
    finished_at: new Date().toISOString(),
  } as typeof securityScans.$inferInsert);
}

async function urgentFinding(s: Setup, number = 1) {
  await env.db.insert(securityFindings).values({
    id: `sf_${number}`,
    project_id: s.project.id,
    number,
    fingerprint_key: `fp-${number}`,
    verdict: 'confirmed',
    severity: 'high',
    title: 'SQL injection',
    category: 'injection',
    first_scan_id: 'ss_ok',
    last_seen_scan_id: 'ss_ok',
  } as typeof securityFindings.$inferInsert);
}

const owner = (s: Setup) => ({ kind: 'user' as const, userId: s.user.id, role: 'owner' });

describe('public gate', () => {
  it('holds a request with no scan or kept input, then goes public once a scan passes', async () => {
    const s = await setup();
    const asked = await ask(s);
    expect(asked.held).toBe(true);
    expect(asked.publicRequest?.state).toBe('needs_deploy');
    expect((await ztRow(s.project.id)).desired_protected).toBe(true);

    await succeededScan(s);
    const rechecked = await recheckPublicRequest(s.platform, env.db, s.project.id);
    expect(rechecked?.state).toBe('passed');
    expect((await ztRow(s.project.id)).desired_protected).toBe(false);
  });

  it('keeps the project protected while an urgent finding is open', async () => {
    const s = await setup();
    await succeededScan(s);
    await urgentFinding(s);
    const asked = await ask(s);
    expect(asked.publicRequest?.state).toBe('held_findings');
    expect((await ztRow(s.project.id)).desired_protected).toBe(true);
  });

  it('refuses a bypass while an urgent finding is open and records nothing', async () => {
    const s = await setup();
    await succeededScan(s);
    await urgentFinding(s);
    await ask(s);
    await expect(
      bypassPublicRequest(s.platform, env.db, {
        projectId: s.project.id,
        reason: 'launch day',
        actor: owner(s),
      }),
    ).rejects.toBeInstanceOf(SecurityApiError);
    expect(await env.db.select().from(securityScanBypasses)).toHaveLength(0);
    expect((await ztRow(s.project.id)).desired_protected).toBe(true);
  });

  it('bypasses the scan with a reason and writes the bypass row', async () => {
    const s = await setup();
    await ask(s);
    await expect(
      bypassPublicRequest(s.platform, env.db, {
        projectId: s.project.id,
        reason: '  ',
        actor: owner(s),
      }),
    ).rejects.toBeInstanceOf(SecurityApiError);
    const result = await bypassPublicRequest(s.platform, env.db, {
      projectId: s.project.id,
      reason: 'launch day',
      actor: owner(s),
    });
    expect(result.publicRequest?.state).toBe('bypassed');
    expect((await ztRow(s.project.id)).desired_protected).toBe(false);
    const [bypass] = await env.db.select().from(securityScanBypasses);
    expect(bypass).toMatchObject({ project_id: s.project.id, reason: 'launch day' });
  });

  it('protecting again cancels the open request and keeps the project protected', async () => {
    const s = await setup();
    await ask(s);
    const again = await ask(s, true);
    expect(again.publicRequest?.state).toBe('canceled');
    expect((await ztRow(s.project.id)).desired_protected).toBe(true);
    const open = await env.db
      .select()
      .from(securityPublicRequests)
      .where(eq(securityPublicRequests.state, 'waiting_scan'));
    expect(open).toHaveLength(0);
  });

  it('refuses to disable installation Zero Trust while the gate is on', async () => {
    const s = await setup();
    await expect(disablePlatformZeroTrust(s.platform, env.db)).rejects.toMatchObject({
      code: 'security public gate on',
    });
  });

  it('the hourly backstop judges every open request and rotates the order', async () => {
    const s = await setup();
    await ask(s);
    const [before] = await env.db.select().from(securityPublicRequests);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await reconcilePendingPublicRequests(s.platform, env.db)).toBe(1);
    const [held] = await env.db.select().from(securityPublicRequests);
    expect(held!.state).toBe(before!.state);
    expect(new Date(held!.updated_at).getTime()).toBeGreaterThan(
      new Date(before!.updated_at).getTime(),
    );
    // A hold needs no routing budget; a pass with no budget left stays queued for the next run.
    await succeededScan(s);
    expect(await reconcilePendingPublicRequests(s.platform, env.db, 20, { remaining: 0 })).toBe(1);
    expect((await ztRow(s.project.id)).effective_protected).toBe(true);
  });

  it('writes the canceled event when the gate was turned off under an open request', async () => {
    const s = await setup();
    await ask(s);
    await savePolicy(false);
    const rechecked = await recheckPublicRequest(s.platform, env.db, s.project.id);
    expect(rechecked?.state).toBe('canceled');
    const events = await env.db.select().from(securityProjectEvents);
    expect(events.filter((event) => event.action === 'public_canceled')).toHaveLength(1);
    expect((await ztRow(s.project.id)).desired_protected).toBe(true);
  });
});
