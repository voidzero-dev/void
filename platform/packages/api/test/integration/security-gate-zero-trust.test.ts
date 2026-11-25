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
import { platformSettings } from '../../src/schema.ts';
import { changeSecurityPolicy } from '../../src/security/policy.ts';
import { readZeroTrustConfigurationStrict } from '../../src/zero-trust/configuration.ts';
import { disablePlatformZeroTrust } from '../../src/zero-trust/installation.ts';
import { clearTables, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import { askPublic, setupGate, ztRow } from './security-gate-fixtures.ts';

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

describe('public gate and installation Zero Trust (I6)', () => {
  it('refuses a disable while the gate is on, so nothing goes public unscanned (#64)', async () => {
    const s = await setupGate(env);
    await askPublic(s);
    await expect(disablePlatformZeroTrust(s.platform, env.db)).rejects.toMatchObject({
      status: 409,
      code: 'security public gate on',
    });
    expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({ enabled: true });
    expect((await ztRow(s)).desired_protected).toBe(true);
  });

  it('a gate turn-on racing a disable never leaves the gate on without Zero Trust (#90)', async () => {
    const s = await setupGate(env, { gateOn: false });
    const [turned, disabled] = await Promise.allSettled([
      changeSecurityPolicy(
        env.db,
        { publicGate: true, expectedRevision: 1 },
        { userId: s.user.id, preview: false },
      ),
      disablePlatformZeroTrust(s.platform, env.db),
    ]);
    expect([turned.status, disabled.status].sort()).toEqual(['fulfilled', 'rejected']);
    const [policy] = await env.db
      .select()
      .from(platformSettings)
      .where(eq(platformSettings.key, SECURITY_POLICY_SETTINGS_KEY));
    const gateOn = (policy.value as { publicGate: boolean }).publicGate;
    expect((await readZeroTrustConfigurationStrict(env.db))?.enabled).toBe(gateOn);
  });
});
