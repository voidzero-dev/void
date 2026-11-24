import { SECURITY_POLICY_SETTINGS_KEY } from '@void/platform/security-policy';
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
import { app } from '../../src/index.ts';
import { platformSettings } from '../../src/schema.ts';
import { SecurityPolicyUnreadableError } from '../../src/security/errors.ts';
import { changeSecurityPolicy } from '../../src/security/policy.ts';
import { readZeroTrustConfigurationStrict } from '../../src/zero-trust/configuration.ts';
import {
  configurePlatformZeroTrust,
  disablePlatformZeroTrust,
} from '../../src/zero-trust/installation.ts';
import { claimConfiguration } from '../../src/zero-trust/operation.ts';
import {
  clearTables,
  createOperatorToken,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import { askPublic, gateBindings, setupGate, ztRow } from './security-gate-fixtures.ts';

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

async function corruptPolicy() {
  await env.db
    .update(platformSettings)
    .set({ value: { version: 1, revision: 7, mode: 'nonsense' } })
    .where(eq(platformSettings.key, SECURITY_POLICY_SETTINGS_KEY));
}

function turnGateOn(userId: string) {
  return changeSecurityPolicy(
    env.db,
    { publicGate: true, expectedRevision: 1 },
    { userId, preview: false },
  );
}

describe('public gate and installation Zero Trust', () => {
  it('refuses a disable and a public-only claim while the gate is on (#64)', async () => {
    const s = await setupGate(env);
    await askPublic(s);

    await expect(disablePlatformZeroTrust(s.platform, env.db)).rejects.toMatchObject({
      status: 409,
      code: 'security public gate on',
    });
    await expect(
      claimConfiguration(
        env.db,
        (current) => {
          throw new Error(`claim must not run: ${current?.revision}`);
        },
        { refuseWhileGateOn: s.platform },
      ),
    ).rejects.toMatchObject({ code: 'security public gate on' });

    const configuration = await readZeroTrustConfigurationStrict(env.db);
    expect(configuration).toMatchObject({ enabled: true, operation: null });
    expect((await ztRow(s)).desired_protected).toBe(true);
  });

  it('refuses a public-only switch from an enabled install with the gate code (#64)', async () => {
    const s = await setupGate(env);
    await expect(
      configurePlatformZeroTrust(s.platform, env.db, {
        apiToken: 'access-management-token',
        identityProviderIds: [],
        policyIds: [],
        protectNewProjects: false,
        publicAccess: true,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'security public gate on',
      message: expect.stringContaining('Turn off "Scan before a project goes public" first'),
    });
    expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
      enabled: true,
      operation: null,
    });
  });

  it('turning the gate off lets the disable run and the open request is canceled (#64)', async () => {
    const s = await setupGate(env);
    await askPublic(s);
    const off = await changeSecurityPolicy(
      env.db,
      { publicGate: false, expectedRevision: 1 },
      { userId: s.user.id, preview: false },
    );
    expect(off).toMatchObject({ ok: true, canceledRequests: 1 });

    await disablePlatformZeroTrust(s.platform, env.db);

    expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({ enabled: false });
  });

  it('turning the gate on after a disable began is refused (#90)', async () => {
    const s = await setupGate(env, { gateOn: false });
    await disablePlatformZeroTrust(s.platform, env.db);

    await expect(turnGateOn(s.user.id)).rejects.toMatchObject({
      status: 409,
      code: 'security public gate needs zero trust',
    });
    const policy = await env.db
      .select()
      .from(platformSettings)
      .where(eq(platformSettings.key, SECURITY_POLICY_SETTINGS_KEY));
    expect(policy[0]!.value).toMatchObject({ publicGate: false });
  });

  it('a gate turn-on racing a disable never leaves the gate on without Zero Trust (#90)', async () => {
    const s = await setupGate(env, { gateOn: false });

    const [turned, disabled] = await Promise.allSettled([
      turnGateOn(s.user.id),
      disablePlatformZeroTrust(s.platform, env.db),
    ]);

    // Both take the Zero Trust configuration lock, so they run one at a time and the
    // second is refused (409).
    expect([turned.status, disabled.status].sort()).toEqual(['fulfilled', 'rejected']);
    const [policy] = await env.db
      .select()
      .from(platformSettings)
      .where(eq(platformSettings.key, SECURITY_POLICY_SETTINGS_KEY));
    const gateOn = (policy!.value as { publicGate: boolean }).publicGate;
    const configuration = await readZeroTrustConfigurationStrict(env.db);
    if (turned.status === 'fulfilled') {
      expect(gateOn).toBe(true);
      expect(configuration).toMatchObject({ enabled: true, operation: null });
      expect(disabled).toMatchObject({
        reason: { status: 409, code: 'security public gate on' },
      });
    } else {
      expect(gateOn).toBe(false);
      expect(configuration?.enabled).toBe(false);
      expect(turned.reason).toMatchObject({
        status: 409,
        code: 'security public gate needs zero trust',
      });
    }
  });

  it('answers 503 and changes nothing when the saved policy cannot be read', async () => {
    const s = await setupGate(env);
    await corruptPolicy();

    const error = await disablePlatformZeroTrust(s.platform, env.db).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecurityPolicyUnreadableError);
    expect(error).toMatchObject({ status: 503, code: 'security policy unreadable' });
    expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
      enabled: true,
      operation: null,
    });

    await expect(
      claimConfiguration(env.db, (current) => current!, { refuseWhileGateOn: s.platform }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('the operator disable route reports the same 503 and the 409', async () => {
    await setupGate(env);
    const admin = await createTestUser(env.db, 'gate-admin', 'github', undefined, 'free', 'admin');
    const token = await createOperatorToken(env.db, admin);
    const call = () =>
      app.fetch(
        new Request('http://localhost/operator/v1/zero-trust/disable', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: '{}',
        }),
        gateBindings(env),
      );

    const refused = await call();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'security public gate on' });

    await corruptPolicy();
    const unreadable = await call();
    expect(unreadable.status).toBe(503);
    expect(await unreadable.json()).toMatchObject({ error: 'security policy unreadable' });
    expect((await readZeroTrustConfigurationStrict(env.db))?.enabled).toBe(true);
  });
});
