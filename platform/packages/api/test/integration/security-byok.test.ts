import { getSecurityModel, securityModelCostNanoUsd } from '@void/platform/security-models';
import type { SecurityEntitlement, SecurityPolicy } from '@void/platform/security-policy';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test';
import type { ApiEnv } from '../../src/env.ts';
import { getPlatformSetting } from '../../src/platform-settings.ts';
import { projectSecuritySettings, securityPlatformSpend, securityScans } from '../../src/schema.ts';
import { holdSecurityModelCall, settleSecurityModelCall } from '../../src/security/budget.ts';
import {
  handleSecurityModelRequest,
  loadSecurityModelScan,
} from '../../src/security/model-proxy.ts';
import type { SecurityModelProxyDeps } from '../../src/security/model-proxy.ts';
import { readSecurityPolicyLenient } from '../../src/security/policy.ts';
import {
  loadSecurityProviderKey,
  SECURITY_PROVIDER_KEYS_SETTINGS_KEY,
} from '../../src/security/provider-keys.ts';
import { operatorFetch } from './ai-logging-helpers.ts';
import {
  clearTables,
  createOperatorToken,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import { saveSecurityPolicy, securityOn } from './security-fixtures.ts';

// BYOK (design doc 0095 M33): an installation's own provider key, stored encrypted,
// added server-side by the model proxy (I3), and still metered toward the caps (I7, R14).

const OPUS = 'anthropic/claude-opus-5.5';
const KEY = 'sk-ant-test-0123456789abcdef';
const NOW = Date.parse('2026-11-18T12:00:00.000Z');

let env: TestEnv;
let bindings: TestEnv;
let token: string;
let gatewayRun: ReturnType<typeof vi.fn>;

const PASSED: SecurityEntitlement = {
  checkedAt: '2026-11-18T11:00:00.000Z',
  ok: true,
  missing: [],
  hosts: { openai: true, anthropic: true },
};

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  const admin = await createTestUser(env.db, 'byok-admin', 'github', undefined, 'free', 'admin');
  token = await createOperatorToken(env.db, admin);
  gatewayRun = vi.fn(async () => Response.json({ id: 'msg', usage: {} }));
  bindings = {
    ...securityOn(env),
    PLATFORM_INSTALLATION_ID: 'inst_byok',
    AI_GATEWAY_ID: 'void-gw',
    AI: { run: vi.fn(), gateway: () => ({ run: gatewayRun }) } as unknown as Ai,
  } as TestEnv;
});

function savePolicy(changes: Partial<SecurityPolicy> = {}) {
  return saveSecurityPolicy(env, { entitlement: PASSED, ...changes });
}

const post = (path: string, body: Record<string, unknown>) =>
  operatorFetch(bindings, token, path, body);

/** The one gateway `run` request the binding got, by call index. */
function gatewayCall(index = 0) {
  const [request] = gatewayRun.mock.calls[index] as [
    { provider: string; endpoint: string; headers: Record<string, string> },
  ];
  return request;
}

describe('own provider keys (I3)', () => {
  test('a refused key is not saved; a good one is stored encrypted and never shown', async () => {
    await savePolicy();
    gatewayRun.mockResolvedValueOnce(Response.json({ error: 'invalid' }, { status: 401 }));
    const refused = await post('/security/provider-keys', { host: 'anthropic', key: KEY });
    expect(refused.status).toBe(422);
    expect(await getPlatformSetting(env.db, SECURITY_PROVIDER_KEYS_SETTINGS_KEY)).toBeNull();

    const saved = await post('/security/provider-keys', { host: 'anthropic', key: KEY });
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain(KEY);
    const row = await getPlatformSetting(env.db, SECURITY_PROVIDER_KEYS_SETTINGS_KEY);
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(await loadSecurityProviderKey(bindings, env.db, 'anthropic')).toMatchObject({
      key: KEY,
    });
    // Bound to its installation: another installation id cannot open it.
    await expect(
      loadSecurityProviderKey(
        { ...bindings, PLATFORM_INSTALLATION_ID: 'other' },
        env.db,
        'anthropic',
      ),
    ).rejects.toThrow('Failed to decrypt');
  });

  test('the proxy adds the key server-side and meters the call like any other (I7)', async () => {
    await savePolicy();
    const owner = await createTestUser(env.db, 'byok-owner');
    const project = await createTestProject(env.db, owner.id, 'byok-app');
    const deployment = await createTestDeployment(env.db, project.id);
    await env.db.insert(securityScans).values({
      id: 'ss_byok',
      project_id: project.id,
      deployment_id: deployment.id,
      status: 'running',
      trigger: 'deploy',
      attempt: 1,
      lease_until: '2026-11-18T13:00:00.000Z',
      model_used: OPUS,
      engine: getSecurityModel(OPUS).engine,
    });
    await env.db.insert(projectSecuritySettings).values({
      project_id: project.id,
      provider_notice_version: 1,
      provider_notice_by_user_id: owner.id,
      provider_notice_at: new Date(NOW).toISOString(),
    });
    await post('/security/provider-keys', { host: 'anthropic', key: KEY });
    gatewayRun.mockClear();
    gatewayRun.mockResolvedValue(
      Response.json({ id: 'msg', usage: { input_tokens: 5000, output_tokens: 300 } }),
    );
    const proxy: SecurityModelProxyDeps = {
      now: () => NOW,
      sleep: async () => {},
      loadScan: (scanId) => loadSecurityModelScan(env.db, scanId),
      readPolicy: () => readSecurityPolicyLenient(env.db),
      admit: async () => ({ ok: true, sessionCalls: null }),
      recordFailure: async () => {},
      lastFailure: async () => null,
      rateLimited: async () => {},
      hold: (input) => holdSecurityModelCall(env.db, input),
      settle: (input) => settleSecurityModelCall(env.db, input),
      scanTag: async (scanId) => `${scanId}.tag`,
      providerKey: (host) => loadSecurityProviderKey(bindings, env.db, host),
      gatewayId: 'void-gw',
      accountId: 'acct',
      apiToken: 'cf-runtime-token',
      ai: (bindings as unknown as ApiEnv['Bindings']).AI,
      fetch: vi.fn(async () => Response.json({})),
    };
    const request = new Request('http://model.void.internal/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        // The runner's own credentials never pass.
        'x-api-key': 'container-placeholder',
        authorization: 'Bearer container-placeholder',
      },
      body: JSON.stringify({
        model: 'claude-opus-5.5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: 'scan' }],
      }),
    });
    expect((await handleSecurityModelRequest(proxy, 'ss_byok', 1, request)).status).toBe(200);
    const call = gatewayCall();
    expect(call).toMatchObject({ provider: 'anthropic', endpoint: 'v1/messages' });
    expect(call.headers['x-api-key']).toBe(KEY);
    expect(call.headers).not.toHaveProperty('authorization');
    expect(JSON.stringify(call.headers)).not.toContain('container-placeholder');

    const expected = securityModelCostNanoUsd(OPUS, 5000, 300)!;
    const [scan] = await env.db.select().from(securityScans).where(eq(securityScans.id, 'ss_byok'));
    expect(scan).toMatchObject({ model_calls: 1, metered_nano_usd: expected });
    const [platform] = await env.db.select().from(securityPlatformSpend);
    expect(platform.spent_nano_usd).toBe(expected);
  });
});
