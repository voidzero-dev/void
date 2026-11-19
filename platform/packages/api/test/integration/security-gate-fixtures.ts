/**
 * Shared set-up of the public gate race suites: a protected project with a live
 * deployment, the gate on, and a fake Cloudflare Access API.
 */
import {
  defaultSecurityPolicy,
  SECURITY_POLICY_SETTINGS_KEY,
} from '@void/platform/security-policy';
import { eq } from 'drizzle-orm';
import { vi } from 'vite-plus/test';
import { getPlatformCapabilities } from '../../src/capabilities.ts';
import type { ApiEnv } from '../../src/env.ts';
import { setPlatformSetting } from '../../src/platform-settings.ts';
import { projectZeroTrust, securityFindings, securityScans } from '../../src/schema.ts';
import { configurePlatformZeroTrust } from '../../src/zero-trust/installation.ts';
import { setProjectZeroTrustProtection } from '../../src/zero-trust/project.ts';
import {
  createTestDeployment,
  createTestProject,
  createTestUser,
  type TestEnv,
} from './helpers.ts';

export function gateBindings(env: TestEnv): ApiEnv['Bindings'] {
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

export const gateZeroTrustInput = {
  apiToken: 'access-management-token',
  identityProviderIds: ['idp-1'],
  policyIds: ['policy-1'],
  protectNewProjects: true,
  existingProjects: 'public' as const,
};

export function gateAccessApi() {
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

/** A fresh passing entitlement probe, so the gate may be turned on. */
export const freshEntitlement = () => ({
  checkedAt: new Date().toISOString(),
  ok: true,
  missing: [] as Array<string>,
  hosts: { openai: true, anthropic: true },
});

export async function saveGatePolicy(env: TestEnv, publicGate: boolean) {
  await setPlatformSetting(env.db, SECURITY_POLICY_SETTINGS_KEY, {
    ...defaultSecurityPolicy(),
    mode: 'all',
    publicGate,
    entitlement: freshEntitlement(),
    revision: 1,
  });
}

export type GateSetup = Awaited<ReturnType<typeof setupGate>>;

/** A protected project with a live deployment, the gate on (or off with `gateOn: false`). */
export async function setupGate(env: TestEnv, options: { gateOn?: boolean } = {}) {
  const cloudflare = gateAccessApi();
  vi.stubGlobal('fetch', cloudflare.fetcher);
  const platform = gateBindings(env);
  await configurePlatformZeroTrust(platform, env.db, gateZeroTrustInput);
  await saveGatePolicy(env, options.gateOn ?? true);
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
  return { env, platform, user, project, deployment, cloudflare };
}

/** Asks for public (or protects again with `protectedAfter`). */
export function askPublic(s: GateSetup, protectedAfter = false) {
  return setProjectZeroTrustProtection(s.platform, s.env.db, s.project.id, protectedAfter, {
    actorUserId: s.user.id,
  });
}

export async function ztRow(s: GateSetup) {
  const [row] = await s.env.db
    .select()
    .from(projectZeroTrust)
    .where(eq(projectZeroTrust.project_id, s.project.id));
  return row!;
}

export async function succeededScan(s: GateSetup, id = 'ss_ok') {
  await s.env.db.insert(securityScans).values({
    id,
    project_id: s.project.id,
    deployment_id: s.deployment.id,
    status: 'succeeded',
    trigger: 'deploy',
    finished_at: new Date().toISOString(),
  } as typeof securityScans.$inferInsert);
}

export async function urgentFinding(s: GateSetup, number = 1) {
  await s.env.db.insert(securityFindings).values({
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

export const gateOwner = (s: GateSetup) => ({
  kind: 'user' as const,
  userId: s.user.id,
  role: 'owner',
});
