import { createHmac } from 'node:crypto';
import {
  PLATFORM_DISABLED_KEY,
  PLATFORM_APP_ACCESS_SETUP_PROOF_PREFIX,
  PLATFORM_APP_ACCESS_TURN_OFF_PROOF_PREFIX,
} from '@void/platform';
import type { PlatformAppAccessSetup } from '@void/platform';
import { sql } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
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
import { importLegacyAuthentication } from '../../src/auth/configuration.ts';
import { getProject } from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import app from '../../src/index.ts';
import { getPlatformSetting, setPlatformSetting } from '../../src/platform-settings.ts';
import { tryActivateDomain } from '../../src/provisioning/activate-domain.ts';
import { domains, platformAuthSettings } from '../../src/schema.ts';
import { readZeroTrustConfigurationStrict } from '../../src/zero-trust/configuration.ts';
import { configurePlatformZeroTrust } from '../../src/zero-trust/installation.ts';
import * as zeroTrustInstallation from '../../src/zero-trust/installation.ts';
import {
  initializeNewProjectZeroTrust,
  reconcileProjectZeroTrustDomains,
  setProjectZeroTrustProtection,
} from '../../src/zero-trust/project.ts';
import { getProjectZeroTrustState } from '../../src/zero-trust/state.ts';
import {
  clearTables,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;
const installationId = 'company-123456789abc';
const setupKey = 'one-time-setup-authority'.repeat(3);
beforeAll(async () => {
  env = await setupEnv();
  await env.db.execute(
    sql`CREATE TABLE IF NOT EXISTS __void_platform_installation (singleton boolean PRIMARY KEY, installation_id text NOT NULL, ownership_nonce text NOT NULL DEFAULT 'test-owner', lifecycle_manifest jsonb)`,
  );
});
afterAll(async () => {
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
  await env.db.execute(sql`DELETE FROM __void_platform_installation`);
  await env.ROUTING.put(PLATFORM_DISABLED_KEY, 'disabled');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function bindings(choice: 'platform' | 'public' = 'platform') {
  return {
    ...env,
    SITE_DOMAIN: 'apps.example.test',
    AUTH_REDIRECT_URI: 'https://platform.example.test/auth/callback',
    PROXY_URL: 'https://proxy.example.test',
    PLATFORM_INSTALLATION_ID: installationId,
    PLATFORM_HEALTH_PROBE_TOKEN: 'installer-proof',
    PLATFORM_APP_ACCESS: choice,
    PLATFORM_APP_ACCESS_SETUP_TOKEN: setupKey,
    PLATFORM_TRAFFIC_STATE: 'staging',
  } as unknown as ApiEnv['Bindings'];
}
async function claim(choice: 'platform' | 'public' = 'platform', status = 'verifying') {
  const value = JSON.stringify({ id: installationId, status, deployment: { appAccess: choice } });
  await env.db.execute(
    sql`INSERT INTO __void_platform_installation (singleton, installation_id, lifecycle_manifest) VALUES (true, ${installationId}, ${value}::jsonb)`,
  );
}
function setup(mode: 'protected' | 'public' = 'protected', managed = true): PlatformAppAccessSetup {
  return {
    version: 1,
    accountId: env.CF_ACCOUNT_ID,
    mode,
    managed,
    ...(managed ? { apiToken: 'app-management-token' } : {}),
    identityProviderIds: mode === 'protected' ? ['idp-1'] : [],
    policyIds: mode === 'protected' ? ['policy-1'] : [],
  };
}
function request(body: unknown, token = 'installer-proof') {
  const signature = createHmac('sha256', setupKey)
    .update(`${PLATFORM_APP_ACCESS_SETUP_PROOF_PREFIX}\n${installationId}\n${JSON.stringify(body)}`)
    .digest('base64url');
  return new Request('https://platform.example.test/internal/platform/app-access', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Void-Platform-Probe': token,
      'X-Void-App-Access-Setup': signature,
    },
    body: JSON.stringify(body),
  });
}
function turnOffRequest(options: { prefix?: string; token?: string; body?: string } = {}): Request {
  const body = options.body ?? JSON.stringify({ version: 1 });
  const signature = createHmac('sha256', setupKey)
    .update(
      `${options.prefix ?? PLATFORM_APP_ACCESS_TURN_OFF_PROOF_PREFIX}\n${installationId}\n${body}`,
    )
    .digest('base64url');
  return new Request('https://platform.example.test/internal/platform/app-access/turn-off', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Void-Platform-Probe': options.token ?? 'installer-proof',
      'X-Void-App-Access-Setup': signature,
    },
    body,
  });
}
function accessApi(identity?: { issuer: string; jwk: Record<string, unknown> }) {
  const applications = new Map<string, Record<string, unknown>>();
  let next = 0;
  const controls = { loseCreateResponse: false, rejectToken: false, domainVerified: false };
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (identity && String(input) === `${identity.issuer}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [identity.jwk] });
    }
    const path = new URL(String(input)).pathname.split('/access/')[1];
    const response = (result: unknown, status = 200) =>
      Response.json(
        status === 200
          ? { success: true, result }
          : {
              success: false,
              errors: [
                { message: status === 403 ? 'permission denied' : 'application unavailable' },
              ],
            },
        { status },
      );
    if (new URL(String(input)).pathname.endsWith('/custom_hostnames/cf-pending')) {
      return response({
        id: 'cf-pending',
        hostname: 'pending.example.test',
        status: controls.domainVerified ? 'active' : 'pending',
        ssl: { method: 'http', status: controls.domainVerified ? 'active' : 'pending_validation' },
        ...(!controls.domainVerified
          ? {
              ownership_verification: {
                type: 'txt',
                name: '_cf-custom-hostname.pending.example.test',
                value: 'challenge',
              },
            }
          : {}),
      });
    }
    if (controls.rejectToken) {
      return response(null, 403);
    }
    if (path === 'organizations') {
      return response({
        auth_domain: 'company.cloudflareaccess.com',
        deny_unmatched_requests: true,
      });
    }
    if (path === 'identity_providers/idp-1') {
      return response({ id: 'idp-1' });
    }
    if (path?.startsWith('policies/')) {
      return response({
        id: path.slice(9),
        decision: 'allow',
        include: [{ email_domain: { domain: 'example.test' } }],
      });
    }
    if (path === 'apps' && init?.method === 'POST') {
      const value = JSON.parse(String(init.body));
      if ([...applications.values()].some((a) => a.domain === value.domain)) {
        return response(null, 409);
      }
      const id = `app-${++next}`;
      const result = { ...value, id, aud: `aud-${id}` };
      applications.set(id, result);
      if (controls.loseCreateResponse) {
        controls.loseCreateResponse = false;
        throw new Error('provider response lost');
      }
      return response(result);
    }
    if (path === 'apps') {
      return response([...applications.values()]);
    }
    const policy = path?.match(/^apps\/([^/]+)\/policies$/);
    if (policy) {
      return response(applications.get(policy[1]!)?.policies ?? []);
    }
    const match = path?.match(/^apps\/([^/]+)$/);
    const id = match?.[1];
    if (id && init?.method === 'PUT') {
      const value = { ...JSON.parse(String(init.body)), id, aud: applications.get(id)?.aud };
      applications.set(id, value);
      return response(value);
    }
    if (id && init?.method === 'DELETE') {
      applications.delete(id);
      return response({ id });
    }
    if (id) {
      return applications.has(id) ? response(applications.get(id)) : response(null, 404);
    }
    throw new Error(`Unexpected Access request: ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return { applications, fetcher, controls };
}

describe('uninstall before any platform user exists', () => {
  // A failed install closes traffic; the installer's probe still reaches the route.
  const closed = () => ({ ...bindings(), PLATFORM_TRAFFIC_STATE: 'enabled' });

  it('turns off installer-managed Zero Trust and deletes its Access applications', async () => {
    const cf = accessApi();
    await claim();
    expect((await app.fetch(request(setup()), bindings())).status).toBe(200);
    const enabled = (await readZeroTrustConfigurationStrict(env.db))!;
    expect(cf.applications.has(enabled.wildcardApplication!.id)).toBe(true);
    const response = await app.fetch(turnOffRequest(), closed());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ installationId, turnedOff: true });
    expect(cf.applications.has(enabled.wildcardApplication!.id)).toBe(false);
    expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
      enabled: false,
      operation: null,
    });
  });

  it('accepts the installer service identity behind platform Access', async () => {
    const issuer = 'https://uninstall-company.cloudflareaccess.com';
    const pair = await generateKeyPair('RS256', { extractable: true });
    accessApi({
      issuer,
      jwk: { ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'turn-off-key', use: 'sig' },
    });
    await claim();
    expect((await app.fetch(request(setup()), bindings())).status).toBe(200);
    await importLegacyAuthentication(env.db, env);
    await env.db.update(platformAuthSettings).set({
      protection: {
        teamDomain: issuer,
        applications: [{ origin: 'https://platform.example.test', audience: 'installer-api' }],
      },
    });
    expect((await app.fetch(turnOffRequest(), closed())).status).toBe(403);
    const authorized = turnOffRequest();
    authorized.headers.set(
      'Cf-Access-Jwt-Assertion',
      await new SignJWT({ type: 'app', common_name: 'installer.access' })
        .setIssuer(issuer)
        .setAudience('installer-api')
        .setSubject('')
        .setIssuedAt()
        .setExpirationTime('5m')
        .setProtectedHeader({ alg: 'RS256', kid: 'turn-off-key' })
        .sign(pair.privateKey),
    );
    const response = await app.fetch(authorized, closed());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ installationId, turnedOff: true });
  });

  it('reports a user who signed in while Zero Trust was turning off', async () => {
    accessApi();
    await claim();
    expect((await app.fetch(request(setup()), bindings())).status).toBe(200);
    // First administrator setup finishes after the route found no user.
    const disable = zeroTrustInstallation.disablePlatformZeroTrust;
    vi.spyOn(zeroTrustInstallation, 'disablePlatformZeroTrust').mockImplementationOnce(
      async (...args) => {
        await createTestUser(env.db, 'first-admin');
        return disable(...args);
      },
    );
    const response = await app.fetch(turnOffRequest(), closed());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ installationId, turnedOff: true, usersExist: true });
  });

  it('refuses once a platform user exists', async () => {
    accessApi();
    await claim();
    expect((await app.fetch(request(setup()), bindings())).status).toBe(200);
    await createTestUser(env.db, 'first-user');
    const response = await app.fetch(turnOffRequest(), closed());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'users_exist' });
    expect((await readZeroTrustConfigurationStrict(env.db))?.enabled).toBe(true);
  });

  it('accepts only the turn-off proof with the installer probe', async () => {
    const cf = accessApi();
    expect(
      (
        await app.fetch(
          turnOffRequest({ prefix: PLATFORM_APP_ACCESS_SETUP_PROOF_PREFIX }),
          closed(),
        )
      ).status,
    ).toBe(404);
    // Without the installer probe the closed platform answers before the route.
    expect((await app.fetch(turnOffRequest({ token: 'wrong' }), closed())).status).toBe(503);
    expect(
      (await app.fetch(turnOffRequest(), { ...closed(), PLATFORM_APP_ACCESS: undefined })).status,
    ).toBe(404);
    expect((await app.fetch(turnOffRequest({ body: '{"version":2}' }), closed())).status).toBe(400);
    expect(cf.fetcher).not.toHaveBeenCalled();
  });
});

describe('installer app access handoff', () => {
  it('initializes behind platform Access with both a scoped service identity and setup authority', async () => {
    const issuer = 'https://installer-company.cloudflareaccess.com';
    const pair = await generateKeyPair('RS256', { extractable: true });
    accessApi({
      issuer,
      jwk: { ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'setup-key', use: 'sig' },
    });
    await claim();
    await importLegacyAuthentication(env.db, env);
    await env.db.update(platformAuthSettings).set({
      protection: {
        teamDomain: issuer,
        applications: [{ origin: 'https://platform.example.test', audience: 'installer-api' }],
      },
    });
    const assertion = (audience: string) =>
      new SignJWT({ type: 'app', common_name: 'installer.access' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject('')
        .setIssuedAt()
        .setExpirationTime('5m')
        .setProtectedHeader({ alg: 'RS256', kid: 'setup-key' })
        .sign(pair.privateKey);
    expect((await app.fetch(request(setup()), bindings())).status).toBe(403);
    const wrongAudience = request(setup());
    wrongAudience.headers.set('Cf-Access-Jwt-Assertion', await assertion('another-app'));
    expect((await app.fetch(wrongAudience, bindings())).status).toBe(403);
    const service = await assertion('installer-api');
    const healthOnly = request(setup());
    healthOnly.headers.set('Cf-Access-Jwt-Assertion', service);
    healthOnly.headers.delete('X-Void-App-Access-Setup');
    expect((await app.fetch(healthOnly, bindings())).status).toBe(404);
    const authorized = request(setup());
    authorized.headers.set('Cf-Access-Jwt-Assertion', service);
    const response = await app.fetch(authorized, bindings());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ installationId, ready: true });
  });

  it('rejects a health proof without setup authority and rejects a modified signed body', async () => {
    const cf = accessApi();
    await claim();
    const healthOnly = request(setup());
    healthOnly.headers.delete('X-Void-App-Access-Setup');
    expect((await app.fetch(healthOnly, bindings())).status).toBe(404);
    const signed = request(setup());
    const changed = new Request(signed, {
      method: 'POST',
      body: JSON.stringify({ ...setup(), policyIds: ['different'] }),
    });
    expect((await app.fetch(changed, bindings())).status).toBe(404);
    expect(await getPlatformSetting(env.db, 'appAccess.installation.v1')).toBeNull();
    expect(cf.fetcher).not.toHaveBeenCalled();
  });
  it('requires the installer proof and recorded setup phase before touching Access', async () => {
    const cf = accessApi();
    await claim();
    expect((await app.fetch(request(setup(), 'wrong'), bindings())).ok).toBe(false);
    await env.db.execute(
      sql`UPDATE __void_platform_installation SET lifecycle_manifest = jsonb_set(lifecycle_manifest,'{status}','"installed"')`,
    );
    expect((await app.fetch(request(setup()), bindings())).status).toBe(503);
    expect(cf.fetcher).not.toHaveBeenCalled();
    expect(await getPlatformSetting(env.db, 'appAccess.installation.v1')).toBeNull();
  });

  it('sets the shared company policy before readiness and protects new projects automatically', async () => {
    const cf = accessApi();
    await claim();
    const response = await app.fetch(request(setup()), bindings());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ready: true, installationId });
    const current = (await readZeroTrustConfigurationStrict(env.db))!;
    expect(current).toMatchObject({
      enabled: true,
      protectNewProjects: true,
      identityProviderIds: ['idp-1'],
      policyIds: ['policy-1'],
    });
    expect(JSON.stringify(current)).not.toContain('app-management-token');
    expect(cf.applications.get(current.wildcardApplication!.id)).toMatchObject({
      domain: '*.apps.example.test',
      allowed_idps: ['idp-1'],
      policies: [{ id: 'policy-1', precedence: 1 }],
    });
    const owner = await createTestUser(env.db, 'app-owner');
    const project = await createTestProject(env.db, owner.id, 'app-one');
    await initializeNewProjectZeroTrust(bindings(), env.db, project.id);
    expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
      desired_protected: true,
      effective_protected: true,
      status: 'ready',
    });
    expect(await env.ROUTING.get(PLATFORM_DISABLED_KEY)).toBe('disabled');
    await setPlatformSetting(env.db, 'zeroTrust.configuration', {
      ...current,
      protectNewProjects: false,
    });
    cf.fetcher.mockClear();
    expect((await app.fetch(request(setup()), bindings())).status).toBe(200);
    expect((await readZeroTrustConfigurationStrict(env.db))?.protectNewProjects).toBe(false);
    expect(cf.fetcher).not.toHaveBeenCalled();
  });

  it('resumes a lost provider response without duplicating apps or changing the saved choice', async () => {
    const cf = accessApi();
    cf.controls.loseCreateResponse = true;
    await claim();
    expect((await app.fetch(request(setup()), bindings())).status).toBe(503);
    expect(await getPlatformSetting(env.db, 'appAccess.installation.v1')).toMatchObject({
      complete: false,
    });
    expect(
      (await app.fetch(request({ ...setup(), policyIds: ['other'] }), bindings())).status,
    ).toBe(503);
    expect((await app.fetch(request(setup()), bindings())).status).toBe(200);
    expect(cf.applications.size).toBe(2);
    expect((await readZeroTrustConfigurationStrict(env.db))?.operation).toBeNull();
  });

  it('reports rejected credentials without opening traffic and accepts a replacement', async () => {
    const cf = accessApi();
    cf.controls.rejectToken = true;
    await claim();
    const failed = await app.fetch(request(setup()), bindings());
    expect(failed.status).toBe(403);
    expect(await failed.json()).toMatchObject({ code: 'app_access_credentials' });
    expect(await env.ROUTING.get(PLATFORM_DISABLED_KEY)).toBe('disabled');
    cf.controls.rejectToken = false;
    expect(
      (await app.fetch(request({ ...setup(), apiToken: 'replacement' }), bindings())).status,
    ).toBe(200);
  });

  it('finishes an uncommitted receipt using replacement credentials after Access itself was configured', async () => {
    const cf = accessApi();
    await claim();
    expect((await app.fetch(request(setup()), bindings())).status).toBe(200);
    const receipt = (await getPlatformSetting(env.db, 'appAccess.installation.v1')) as Record<
      string,
      unknown
    >;
    await setPlatformSetting(env.db, 'appAccess.installation.v1', { ...receipt, complete: false });
    cf.fetcher.mockClear();
    expect(
      (await app.fetch(request({ ...setup(), apiToken: 'replacement-token' }), bindings())).status,
    ).toBe(200);
    expect(
      cf.fetcher.mock.calls.every(
        ([, init]) =>
          new Headers(init?.headers).get('Authorization') === 'Bearer replacement-token',
      ),
    ).toBe(true);
    expect(cf.applications.size).toBe(2);
  });

  it('creates scoped public rules under Default-Deny and maintains public custom domains', async () => {
    const cf = accessApi();
    await claim('public');
    expect((await app.fetch(request(setup('public')), bindings('public'))).status).toBe(200);
    const current = (await readZeroTrustConfigurationStrict(env.db))!;
    expect(current).toMatchObject({
      publicAccess: true,
      protectNewProjects: false,
      identityProviderIds: [],
      policyIds: [],
    });
    expect(cf.applications.get(current.wildcardApplication!.id)).toMatchObject({
      domain: 'void-platform-health.apps.example.test/__void/app-access-management',
      policies: [{ decision: 'deny', include: [{ everyone: {} }] }],
    });
    const owner = await createTestUser(env.db, 'public-owner');
    const project = await createTestProject(env.db, owner.id, 'public-app');
    await initializeNewProjectZeroTrust(bindings('public'), env.db, project.id);
    expect(
      [...cf.applications.values()].find(
        (application) => application.domain === 'public-app.apps.example.test',
      ),
    ).toMatchObject({ policies: [{ decision: 'bypass', include: [{ everyone: {} }] }] });
    expect(
      [...cf.applications.values()].some(
        (application) =>
          String(application.domain).includes('*') &&
          (application.policies as Array<{ decision: string }>).some(
            (policy) => policy.decision === 'bypass',
          ),
      ),
    ).toBe(false);
    await env.db.insert(domains).values({
      id: 'custom-one',
      project_id: project.id,
      hostname: 'custom.example.test',
      cf_hostname_id: 'cf-custom',
      status: 'active',
    });
    await env.ROUTING.put(
      'domain:custom.example.test',
      JSON.stringify({ worker: 'public-app', projectId: project.id }),
    );
    await reconcileProjectZeroTrustDomains(bindings('public'), env.db, project.id);
    expect(
      [...cf.applications.values()].find((a) => a.domain === 'custom.example.test'),
    ).toMatchObject({ policies: [{ decision: 'bypass', include: [{ everyone: {} }] }] });
    await expect(
      setProjectZeroTrustProtection(bindings('public'), env.db, project.id, true),
    ).rejects.toThrow('Choose company identity providers');
    // Public-only management credentials can be renewed without inventing identity policies.
    await configurePlatformZeroTrust(bindings('public'), env.db, {
      apiToken: 'renewed',
      identityProviderIds: [],
      policyIds: [],
      protectNewProjects: false,
      publicAccess: true,
    });
    expect((await readZeroTrustConfigurationStrict(env.db))?.publicAccess).toBe(true);
  });

  it('needs no persistent Access token or provider writes for public apps without Default-Deny', async () => {
    const cf = accessApi();
    await claim('public');
    expect((await app.fetch(request(setup('public', false)), bindings('public'))).status).toBe(200);
    expect(await readZeroTrustConfigurationStrict(env.db)).toBeNull();
    expect(cf.fetcher).not.toHaveBeenCalled();
    expect(await getPlatformSetting(env.db, 'appAccess.installation.v1')).toMatchObject({
      complete: true,
    });
  });

  it('refuses to create a public exception for a platform control-plane hostname', async () => {
    const cf = accessApi();
    await claim('public');
    expect((await app.fetch(request(setup('public')), bindings('public'))).status).toBe(200);
    const owner = await createTestUser(env.db, 'reserved-owner');
    const project = await createTestProject(env.db, owner.id, 'normal-app');
    await initializeNewProjectZeroTrust(bindings('public'), env.db, project.id);
    await env.db.insert(domains).values({
      id: 'reserved-domain',
      project_id: project.id,
      hostname: 'platform.example.test',
      cf_hostname_id: 'reserved-cf',
      status: 'active',
    });
    cf.fetcher.mockClear();
    await expect(
      reconcileProjectZeroTrustDomains(bindings('public'), env.db, project.id),
    ).rejects.toThrow('overlaps a platform');
    expect(cf.fetcher).not.toHaveBeenCalled();
  });

  it('waits for custom-hostname ownership and certificate verification before creating public rules', async () => {
    const cf = accessApi();
    await claim('public');
    expect((await app.fetch(request(setup('public')), bindings('public'))).status).toBe(200);
    const owner = await createTestUser(env.db, 'verification-owner');
    const project = await createTestProject(env.db, owner.id, 'verified-app');
    const persistedProject = (await getProject(env.db, project.id))!;
    await initializeNewProjectZeroTrust(bindings('public'), env.db, project.id);
    const [domain] = await env.db
      .insert(domains)
      .values({
        id: 'pending-domain',
        project_id: project.id,
        hostname: 'pending.example.test',
        cf_hostname_id: 'cf-pending',
        status: 'pending',
      })
      .returning();
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ worker: 'app-worker', projectId: project.id }),
    );
    await reconcileProjectZeroTrustDomains(bindings('public'), env.db, project.id);
    expect(
      [...cf.applications.values()].some((value) => value.domain === 'pending.example.test'),
    ).toBe(false);
    expect(
      (await tryActivateDomain(bindings('public'), env.db, domain!, persistedProject)).activated,
    ).toBe(false);
    cf.controls.domainVerified = true;
    expect(
      (await tryActivateDomain(bindings('public'), env.db, domain!, persistedProject)).activated,
    ).toBe(true);
    expect(
      [...cf.applications.values()].find((value) => value.domain === 'pending.example.test'),
    ).toMatchObject({ policies: [{ decision: 'bypass', include: [{ everyone: {} }] }] });
  });
});
