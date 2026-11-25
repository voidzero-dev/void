import { getSecurityModel, securityModelCostNanoUsd } from '@void/platform/security-models';
import type { SecurityEntitlement, SecurityPolicy } from '@void/platform/security-policy';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test';
import { getPlatformCapabilities } from '../../src/capabilities.ts';
import type { ApiEnv } from '../../src/env.ts';
import { getPlatformSetting, setPlatformSetting } from '../../src/platform-settings.ts';
import { securityScannerNames } from '../../src/provisioning/security-scanner.ts';
import {
  operatorEvents,
  projectSecuritySettings,
  securityPlatformSpend,
  securityScans,
} from '../../src/schema.ts';
import { holdSecurityModelCall, settleSecurityModelCall } from '../../src/security/budget.ts';
import { changeSecurityProviderKey } from '../../src/security/byok.ts';
import {
  handleSecurityModelRequest,
  loadSecurityModelScan,
} from '../../src/security/model-proxy.ts';
import type { SecurityModelProxyDeps } from '../../src/security/model-proxy.ts';
import { changeSecurityPolicy, readSecurityPolicyLenient } from '../../src/security/policy.ts';
import {
  probeAndRecord,
  runSecurityProbe,
  SECURITY_PROBE_COPY,
  securityProbeDeps,
} from '../../src/security/probe.ts';
import type { SecurityProbeDeps } from '../../src/security/probe.ts';
import {
  loadSecurityProviderKey,
  loadSecurityProviderKeySlots,
  NO_SECURITY_PROVIDER_KEYS,
  SECURITY_PROVIDER_KEY_MALFORMED_ID,
  SECURITY_PROVIDER_KEYS_SETTINGS_KEY,
  securityProviderModelName,
} from '../../src/security/provider-keys.ts';
import type { SecurityProviderKeySlots } from '../../src/security/provider-keys.ts';
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

// BYOK (design doc 0095 M33): an installation's own OpenAI / Anthropic key, stored
// encrypted, added server-side by the model proxy, checked by probe check 5, and still
// metered and counted toward the caps (R14).

const OPUS = 'anthropic/claude-opus-5.5';
const TERRA = 'openai/gpt-6.1-terra';
const KEY = 'sk-ant-test-0123456789abcdef';
const NEW_KEY = 'sk-ant-test-fedcba9876543210';
const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const LEASE = '2026-11-18T13:00:00.000Z';

let env: TestEnv;
let bindings: TestEnv;
let token: string;
let adminId: string;
let gatewayRun: ReturnType<typeof vi.fn>;
let gatewayIds: Array<string>;

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
  adminId = admin.id;
  token = await createOperatorToken(env.db, admin);
  gatewayIds = [];
  gatewayRun = vi.fn(async () => Response.json({ id: 'msg', usage: {} }));
  bindings = {
    ...securityOn(env),
    PLATFORM_INSTALLATION_ID: 'inst_byok',
    AI_GATEWAY_ID: 'void-gw',
    AI: {
      run: vi.fn(),
      gateway: (id: string) => {
        gatewayIds.push(id);
        return { run: gatewayRun };
      },
    } as unknown as Ai,
  } as TestEnv;
});

function savePolicy(changes: Partial<SecurityPolicy> = {}) {
  return saveSecurityPolicy(env, { entitlement: PASSED, ...changes });
}

async function policy(): Promise<SecurityPolicy> {
  return readSecurityPolicyLenient(env.db);
}

const post = (path: string, body: Record<string, unknown>) =>
  operatorFetch(bindings, token, path, body);
const get = (path: string) => operatorFetch(bindings, token, path);

/** Answers read in tests. */
async function json(response: Response) {
  return await response.json<{ message: string; preview: Array<string> }>();
}

/** The bindings as the API code types them. */
function apiEnv(): ApiEnv['Bindings'] {
  return bindings as unknown as ApiEnv['Bindings'];
}

/** The one gateway `run` request the binding got, by call index. */
function gatewayCall(index = 0) {
  const [request] = gatewayRun.mock.calls[index] as [
    {
      provider: string;
      endpoint: string;
      headers: Record<string, string>;
      query: Record<string, unknown>;
    },
  ];
  return request;
}

describe('saving and removing a provider key', () => {
  test('a preview makes no call and stores nothing; a save checks the key, then stores it encrypted', async () => {
    await savePolicy();
    const preview = await post('/security/provider-keys', {
      host: 'anthropic',
      key: KEY,
      dryRun: true,
    });
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect(previewBody).toMatchObject({
      dryRun: true,
      action: 'security.provider-key',
      target: 'anthropic',
      providerKey: null,
      preview: expect.arrayContaining([
        'Save: your own Anthropic key for anthropic/* scans.',
        expect.stringContaining('count toward the monthly caps'),
      ]),
    });
    expect(JSON.stringify(previewBody)).not.toContain(KEY);
    expect(gatewayRun).not.toHaveBeenCalled();
    expect(await getPlatformSetting(env.db, SECURITY_PROVIDER_KEYS_SETTINGS_KEY)).toBeNull();

    const saved = await post('/security/provider-keys', { host: 'anthropic', key: KEY });
    expect(saved.status).toBe(200);
    const result = await saved.json();
    expect(result).toMatchObject({
      ok: true,
      host: 'anthropic',
      providerKey: { setAt: expect.any(String) },
      // The host passed the last probe and the key just passed its test call.
      probeNeeded: false,
    });
    expect(JSON.stringify(result)).not.toContain(KEY);

    // The test call: the provider-native route through the binding, on the key.
    expect(gatewayIds).toEqual(['void-gw']);
    const call = gatewayCall();
    expect(call).toMatchObject({
      provider: 'anthropic',
      endpoint: 'v1/messages',
      query: { model: 'claude-opus-5-5', max_tokens: 1 },
    });
    expect(call.headers).toMatchObject({
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
      'cf-aig-no-wholesale': 'true',
      'cf-aig-collect-log-payload': 'false',
    });
    expect(call.headers).not.toHaveProperty('authorization');

    // Stored encrypted: the row never holds the key; it opens to the key for this host.
    const row = await getPlatformSetting(env.db, SECURITY_PROVIDER_KEYS_SETTINGS_KEY);
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(await loadSecurityProviderKey(bindings, env.db, 'anthropic')).toMatchObject({
      host: 'anthropic',
      key: KEY,
    });
    expect(await loadSecurityProviderKey(bindings, env.db, 'openai')).toBeNull();
    // Bound to its installation: another installation id cannot open it.
    await expect(
      loadSecurityProviderKey(
        { ...bindings, PLATFORM_INSTALLATION_ID: 'other' },
        env.db,
        'anthropic',
      ),
    ).rejects.toThrow('Failed to decrypt');

    // Reads name the date only.
    const policyView = await (await get('/security/policy')).text();
    expect(JSON.parse(policyView).providerKeys).toEqual({
      openai: null,
      anthropic: { setAt: expect.any(String) },
    });
    const status = await (await get('/security/status')).text();
    expect(JSON.parse(status).providerKeys.anthropic).toEqual({ setAt: expect.any(String) });
    expect(policyView + status).not.toContain(KEY);

    // Audited by host and action, never the key.
    const events = await env.db.select().from(operatorEvents);
    const audited = events.filter((event) => event.action === 'security/provider-keys');
    expect(audited.map((event) => [JSON.parse(event.target) as unknown, event.status])).toEqual([
      [{ installation: 'platform', host: 'anthropic', key: 'set' }, 'success'],
    ]);
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  test('a key the provider refuses is not saved', async () => {
    await savePolicy();
    gatewayRun.mockResolvedValue(Response.json({ error: 'invalid x-api-key' }, { status: 401 }));
    const response = await post('/security/provider-keys', { host: 'anthropic', key: KEY });
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ error: 'security provider key rejected' });
    expect(JSON.parse(body).message).toContain('Anthropic refused the key (HTTP 401)');
    expect(body).not.toContain(KEY);
    expect(await getPlatformSetting(env.db, SECURITY_PROVIDER_KEYS_SETTINGS_KEY)).toBeNull();

    // A gateway that cannot be reached: the same refusal, still nothing saved.
    gatewayRun.mockRejectedValue(new Error('network down'));
    const unreachable = await post('/security/provider-keys', { host: 'anthropic', key: KEY });
    expect(unreachable.status).toBe(422);
    expect((await json(unreachable)).message).toContain('test call with the key failed');
    expect(await getPlatformSetting(env.db, SECURITY_PROVIDER_KEYS_SETTINGS_KEY)).toBeNull();
  });

  test('the OpenAI test call uses the Responses route, a bearer key and the access program', async () => {
    await savePolicy({ entitlement: { ...PASSED, hosts: { openai: false, anthropic: true } } });
    const saved = await post('/security/provider-keys', {
      host: 'openai',
      key: 'sk-openai-0123456789',
    });
    expect(saved.status).toBe(200);
    // The host never passed the probe (no image copied yet): run it next.
    expect(await saved.json()).toMatchObject({ probeNeeded: true });
    const call = gatewayCall();
    expect(call).toMatchObject({
      provider: 'openai',
      endpoint: 'responses',
      query: {
        model: 'gpt-6.1-terra',
        max_output_tokens: 16,
        access_programs: { cyber: 'standard' },
      },
    });
    expect(call.headers.authorization).toBe('Bearer sk-openai-0123456789');
    expect(call.headers).not.toHaveProperty('x-api-key');
  });

  test('removing a key clears the host probe result; removing none changes nothing', async () => {
    await savePolicy();
    await post('/security/provider-keys', { host: 'anthropic', key: KEY });
    const preview = await post('/security/provider-keys', {
      host: 'anthropic',
      key: null,
      dryRun: true,
    });
    expect((await json(preview)).preview).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Remove: your own Anthropic key/)]),
    );
    const removed = await post('/security/provider-keys', { host: 'anthropic', key: null });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({
      ok: true,
      providerKey: null,
      probeNeeded: true,
    });
    expect(await loadSecurityProviderKey(bindings, env.db, 'anthropic')).toBeNull();
    // Scans go back to Unified Billing, which the probe has not checked.
    expect((await policy()).entitlement?.hosts).toEqual({ openai: true, anthropic: false });

    const nothing = await post('/security/provider-keys', {
      host: 'openai',
      key: null,
      dryRun: true,
    });
    expect((await json(nothing)).preview).toEqual(['No OpenAI key is saved. Nothing changes.']);
    expect((await post('/security/provider-keys', { host: 'openai', key: null })).status).toBe(200);
    expect((await policy()).entitlement?.hosts.openai).toBe(true);
  });

  test('refuses a bad request before any call', async () => {
    await savePolicy();
    for (const body of [
      { host: 'google', key: KEY },
      { host: 'anthropic' },
      { host: 'anthropic', key: 'short' },
      { host: 'anthropic', key: 'has a space in it' },
      { host: 'anthropic', key: KEY, extra: true },
    ]) {
      const response = await post('/security/provider-keys', body);
      expect([JSON.stringify(body), response.status]).toEqual([JSON.stringify(body), 400]);
    }
    expect(gatewayRun).not.toHaveBeenCalled();
  });

  test('needs the capability', async () => {
    bindings = { ...bindings, PLATFORM_CAPABILITIES: JSON.stringify(getPlatformCapabilities(env)) };
    const response = await post('/security/provider-keys', { host: 'anthropic', key: KEY });
    expect(response.status).toBe(501);
    expect(gatewayRun).not.toHaveBeenCalled();
  });
});

describe('model proxy on a saved key', () => {
  async function runningScan(model: string) {
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
      lease_until: LEASE,
      model_used: model,
      engine: getSecurityModel(model as typeof OPUS).engine,
    });
    await env.db.insert(projectSecuritySettings).values({
      project_id: project.id,
      provider_notice_version: 1,
      provider_notice_by_user_id: owner.id,
      provider_notice_at: new Date(NOW).toISOString(),
    });
    return project;
  }

  function deps(overrides: Partial<SecurityModelProxyDeps> = {}): SecurityModelProxyDeps {
    return {
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
      ai: apiEnv().AI,
      fetch: vi.fn(async () => Response.json({})),
      ...overrides,
    };
  }

  function messages(): Request {
    return new Request('http://model.void.internal/v1/messages', {
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
  }

  test('adds the key server-side and meters the call like any other (R14)', async () => {
    await savePolicy();
    await runningScan(OPUS);
    await post('/security/provider-keys', { host: 'anthropic', key: KEY });
    gatewayRun.mockClear();
    gatewayRun.mockResolvedValue(
      Response.json({ id: 'msg', usage: { input_tokens: 5000, output_tokens: 300 } }),
    );
    const proxy = deps();
    const response = await handleSecurityModelRequest(proxy, 'ss_byok', 1, messages());
    expect(response.status).toBe(200);
    expect(proxy.fetch).not.toHaveBeenCalled();
    const call = gatewayCall();
    expect(call).toMatchObject({
      provider: 'anthropic',
      endpoint: 'v1/messages',
      query: { model: securityProviderModelName(OPUS) },
    });
    expect(call.headers).toMatchObject({
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
      'cf-aig-metadata': JSON.stringify({ securityScan: 'ss_byok.tag' }),
      'cf-aig-collect-log-payload': 'false',
      'cf-aig-skip-cache': 'true',
      'cf-aig-no-wholesale': 'true',
    });
    // Neither the Cloudflare token nor the container's placeholder goes upstream.
    expect(call.headers).not.toHaveProperty('authorization');
    expect(JSON.stringify(call.headers)).not.toContain('container-placeholder');
    expect(JSON.stringify(call.headers)).not.toContain('cf-runtime-token');

    const expected = securityModelCostNanoUsd(OPUS, 5000, 300)!;
    const [scan] = await env.db.select().from(securityScans).where(eq(securityScans.id, 'ss_byok'));
    expect(scan).toMatchObject({ model_calls: 1, tokens_in: 5000, tokens_out: 300 });
    expect(scan.metered_nano_usd).toBe(expected);
    const [platform] = await env.db.select().from(securityPlatformSpend);
    expect(platform.spent_nano_usd).toBe(expected);
  });

  test('without a key the call stays on the REST route with the Cloudflare token', async () => {
    await savePolicy();
    await runningScan(TERRA);
    const fetch = vi.fn(async () =>
      Response.json({ id: 'resp', usage: { input_tokens: 10, output_tokens: 2 } }),
    );
    const response = await handleSecurityModelRequest(
      deps({ fetch: fetch as unknown as typeof globalThis.fetch }),
      'ss_byok',
      1,
      new Request('http://model.void.internal/v1/responses', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-6.1-terra', input: 'scan' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(gatewayRun).not.toHaveBeenCalled();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/ai/v1/responses');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer cf-runtime-token');
  });

  test('a saved key that cannot be read fails the call; it never moves to Unified Billing', async () => {
    await savePolicy();
    await runningScan(OPUS);
    await post('/security/provider-keys', { host: 'anthropic', key: KEY });
    gatewayRun.mockClear();
    const proxy = deps({
      providerKey: (host) =>
        loadSecurityProviderKey({ ...bindings, PLATFORM_INSTALLATION_ID: 'moved' }, env.db, host),
    });
    const response = await handleSecurityModelRequest(proxy, 'ss_byok', 1, messages());
    expect(response.status).toBe(503);
    expect(gatewayRun).not.toHaveBeenCalled();
    expect(proxy.fetch).not.toHaveBeenCalled();
    const [scan] = await env.db.select().from(securityScans).where(eq(securityScans.id, 'ss_byok'));
    expect(scan).toMatchObject({ model_calls: 0, metered_nano_usd: 0 });
  });

  test('a key removed during a call never sends that call to Unified Billing', async () => {
    await savePolicy();
    await runningScan(OPUS);
    await post('/security/provider-keys', { host: 'anthropic', key: KEY });
    gatewayRun.mockClear();
    gatewayRun.mockResolvedValue(Response.json({ id: 'msg', usage: {} }));
    const proxy = deps({
      // The removal lands right after the policy read.
      readPolicy: async () => {
        const read = await readSecurityPolicyLenient(env.db);
        await changeSecurityProviderKey(
          apiEnv(),
          env.db,
          { host: 'anthropic', key: null },
          { userId: adminId, now: NOW },
        );
        return read;
      },
    });
    const response = await handleSecurityModelRequest(proxy, 'ss_byok', 1, messages());
    // The key was read first, so the call ran on it.
    expect(response.status).toBe(200);
    expect(proxy.fetch).not.toHaveBeenCalled();
    expect(gatewayCall().headers['x-api-key']).toBe(KEY);
  });

  test('a malformed saved entry is a key that cannot be used, never "no key"', async () => {
    await savePolicy();
    await runningScan(OPUS);
    // A saved entry with its key version missing.
    await setPlatformSetting(env.db, SECURITY_PROVIDER_KEYS_SETTINGS_KEY, {
      anthropic: {
        key: { ciphertext: 'c2VjcmV0', iv: 'aXY=' },
        keyId: 'pk_old',
        setAt: '2026-11-18T10:00:00.000Z',
        setByUserId: adminId,
      },
    });
    const proxy = deps();
    const response = await handleSecurityModelRequest(proxy, 'ss_byok', 1, messages());
    expect(response.status).toBe(503);
    // Neither the saved-key route nor Unified Billing.
    expect(gatewayRun).not.toHaveBeenCalled();
    expect(proxy.fetch).not.toHaveBeenCalled();

    // The probe reports it, status names it, and a save replaces it.
    const slots = await loadSecurityProviderKeySlots(bindings, env.db);
    expect(slots.anthropic).toEqual({
      host: 'anthropic',
      keyId: SECURITY_PROVIDER_KEY_MALFORMED_ID,
      unreadable: true,
    });
    const status = await (
      await get('/security/status')
    ).json<{
      providerKeys: Record<string, unknown>;
    }>();
    expect(status.providerKeys.anthropic).toEqual({ setAt: null, unreadable: true });
    const preview = await post('/security/provider-keys', {
      host: 'anthropic',
      key: KEY,
      dryRun: true,
    });
    expect((await json(preview)).preview[0]).toBe(
      'Replace: your own Anthropic key (cannot be read).',
    );
    expect((await post('/security/provider-keys', { host: 'anthropic', key: KEY })).status).toBe(
      200,
    );
    expect(await loadSecurityProviderKey(bindings, env.db, 'anthropic')).toMatchObject({
      key: KEY,
    });
  });
});

describe('probe check 5 on a saved key', () => {
  const PASSING = (probeId: string) => ({
    started: true,
    coldStartMs: 100,
    report: {
      selfTest: 1,
      uid: 999,
      model: { ok: true, status: 200, probe: probeId },
      egress: { httpExample: { blocked: true } },
      envSuspicious: [],
    },
  });

  async function fakeDeps(
    keys: SecurityProviderKeySlots,
    thirdParty: SecurityProbeDeps['thirdParty'],
  ): Promise<SecurityProbeDeps> {
    const names = await securityScannerNames('inst_byok');
    return {
      keys,
      image: async (engine) => ({ ok: true, ref: `registry/${engine}@sha256:1`, copied: false }),
      provision: async (ready) => ({ names, deployed: ready }),
      selfTest: async (_names, probeId) => PASSING(probeId),
      workersAi: async () => {},
      thirdParty,
    };
  }

  test('the real call goes out on the saved key through the binding', async () => {
    await savePolicy();
    await post('/security/provider-keys', { host: 'anthropic', key: KEY });
    gatewayRun.mockClear();
    const slots = await loadSecurityProviderKeySlots(bindings, env.db);
    const status = await securityProbeDeps(apiEnv(), slots).thirdParty('anthropic', OPUS);
    expect(status).toBe(200);
    expect(gatewayCall()).toMatchObject({
      provider: 'anthropic',
      query: { model: 'claude-opus-5-5', max_tokens: 1 },
      headers: { 'x-api-key': KEY, 'cf-aig-metadata': JSON.stringify({ securityScan: 'probe' }) },
    });
  });

  test('names the saved key in its line and copy, and reports the key ids it ran with', async () => {
    await savePolicy();
    await post('/security/provider-keys', { host: 'anthropic', key: KEY });
    const slots = await loadSecurityProviderKeySlots(bindings, env.db);
    const passed = await runSecurityProbe(
      apiEnv(),
      env.db,
      await policy(),
      await fakeDeps(slots, async () => 200),
    );
    const line = (report: typeof passed, host: string) =>
      report.checks.find((check) => check.name === 'credits' && check.host === host);
    expect(line(passed, 'anthropic')).toMatchObject({
      label: 'Own key     anthropic/*',
      status: 'ok',
    });
    expect(line(passed, 'openai')).toMatchObject({ label: 'Credits     openai/*', status: 'ok' });
    expect(passed.keyIds).toEqual({ openai: null, anthropic: slots.anthropic!.keyId });
    expect(passed.entitlement.hosts).toEqual({ openai: true, anthropic: true });

    const refused = await runSecurityProbe(
      apiEnv(),
      env.db,
      await policy(),
      await fakeDeps(slots, async (host) => (host === 'anthropic' ? 401 : 200)),
    );
    expect(line(refused, 'anthropic')).toMatchObject({
      status: 'fail',
      message: SECURITY_PROBE_COPY.ownKeyRefused('anthropic', 401),
    });
    expect(line(refused, 'anthropic')).not.toHaveProperty('link');
    expect(refused.entitlement.hosts.anthropic).toBe(false);

    const quota = await runSecurityProbe(
      apiEnv(),
      env.db,
      await policy(),
      await fakeDeps(slots, async (host) => (host === 'anthropic' ? 429 : 200)),
    );
    expect(line(quota, 'anthropic')?.message).toBe(
      SECURITY_PROBE_COPY.ownKeyFailed('anthropic', 'HTTP 429'),
    );
  });

  test('a saved key that cannot be read fails its host only', async () => {
    await savePolicy();
    await post('/security/provider-keys', { host: 'anthropic', key: KEY });
    const slots = await loadSecurityProviderKeySlots(
      { ...bindings, PLATFORM_INSTALLATION_ID: 'moved' },
      env.db,
    );
    expect(slots.anthropic).toMatchObject({ unreadable: true });
    const report = await runSecurityProbe(
      apiEnv(),
      env.db,
      await policy(),
      // The real deps: an unreadable key makes no call.
      {
        ...(await fakeDeps(slots, async () => 200)),
        thirdParty: securityProbeDeps(apiEnv(), slots).thirdParty,
      },
    );
    const line = report.checks.find(
      (check) => check.name === 'credits' && check.host === 'anthropic',
    );
    expect(line).toMatchObject({
      status: 'fail',
      message: SECURITY_PROBE_COPY.ownKeyUnreadable('anthropic'),
    });
    expect(report.ok).toBe(true);
  });

  test('a key changed while the probe ran is stored as not passed', async () => {
    await savePolicy({ mode: 'disabled', entitlement: null });
    await post('/security/provider-keys', { host: 'anthropic', key: KEY });
    const slots = await loadSecurityProviderKeySlots(bindings, env.db);
    const deps = await fakeDeps(slots, async (host) => {
      if (host === 'anthropic') {
        // The operator replaces the key while this probe still runs on the old one.
        await changeSecurityProviderKey(
          apiEnv(),
          env.db,
          { host: 'anthropic', key: NEW_KEY },
          { userId: adminId, now: Date.now(), test: async () => 200 },
        );
      }
      return 200;
    });
    const report = await probeAndRecord(apiEnv(), env.db, deps);
    expect(report.entitlement.hosts).toEqual({ openai: true, anthropic: true });
    expect(report.saved).toBe(true);
    // Stored: the new key is not covered by this probe.
    expect((await policy()).entitlement?.hosts).toEqual({ openai: true, anthropic: false });
  });

  test('a host that passed keeps its result when a key is saved while the probe runs', async () => {
    await savePolicy();
    let save: Awaited<ReturnType<typeof changeSecurityProviderKey>> | undefined;
    const saving = await fakeDeps(NO_SECURITY_PROVIDER_KEYS, async (host) => {
      if (host === 'anthropic') {
        save = await changeSecurityProviderKey(
          apiEnv(),
          env.db,
          { host: 'anthropic', key: KEY },
          { userId: adminId, now: Date.now(), test: async () => 200 },
        );
        // This probe's own call (no key) fails: it must not undo the save.
        return 402;
      }
      return 200;
    });
    const report = await probeAndRecord(apiEnv(), env.db, saving);
    expect(report.entitlement.hosts.anthropic).toBe(false);
    expect(save).toMatchObject({ ok: true, probeNeeded: false });
    expect((await policy()).entitlement?.hosts).toEqual({ openai: true, anthropic: true });

    // A removal while a probe runs: the removal stored false, and it stays false.
    const slots = await loadSecurityProviderKeySlots(bindings, env.db);
    const removing = await fakeDeps(slots, async (host) => {
      if (host === 'anthropic') {
        await changeSecurityProviderKey(
          apiEnv(),
          env.db,
          { host: 'anthropic', key: null },
          { userId: adminId, now: Date.now() },
        );
      }
      return 200;
    });
    expect((await probeAndRecord(apiEnv(), env.db, removing)).entitlement.hosts.anthropic).toBe(
      true,
    );
    expect((await policy()).entitlement?.hosts).toEqual({ openai: true, anthropic: false });
  });

  test('turning the policy on stores the key-write value for a host whose key changed', async () => {
    const turnOn = async (stored: SecurityEntitlement['hosts'], thirdParty: number) => {
      await savePolicy({ mode: 'disabled', entitlement: { ...PASSED, hosts: stored } });
      await setPlatformSetting(env.db, SECURITY_PROVIDER_KEYS_SETTINGS_KEY, {});
      const deps = await fakeDeps(NO_SECURITY_PROVIDER_KEYS, async (host) => {
        if (host === 'anthropic') {
          // The operator saves a key while the turn-on probe runs without one.
          await changeSecurityProviderKey(
            apiEnv(),
            env.db,
            { host: 'anthropic', key: KEY },
            { userId: adminId, now: Date.now(), test: async () => 200 },
          );
          return thirdParty;
        }
        return 200;
      });
      const result = await changeSecurityPolicy(
        env.db,
        { mode: 'all', expectedRevision: 1 },
        {
          userId: adminId,
          preview: false,
          probe: async () => runSecurityProbe(apiEnv(), env.db, await policy(), deps),
        },
      );
      expect(result).toMatchObject({ ok: true, policy: { mode: 'all' } });
      return (await policy()).entitlement?.hosts;
    };
    // Never passed: the probe passed on no key, which does not cover the new key.
    expect(await turnOn({ openai: true, anthropic: false }, 200)).toEqual({
      openai: true,
      anthropic: false,
    });
    // Passed before: the save kept it, and this probe's failed call on no key does not undo it.
    expect(await turnOn({ openai: true, anthropic: true }, 402)).toEqual({
      openai: true,
      anthropic: true,
    });
  });
});
