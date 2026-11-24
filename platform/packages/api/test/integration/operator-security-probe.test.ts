import { getSecurityModel, SECURITY_MODEL_IDS } from '@void/platform/security-models';
import { SECURITY_POLICY_SETTINGS_KEY } from '@void/platform/security-policy';
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

// The release pins: tests publish fake engine images (or none) through this.
const pinState = vi.hoisted(() => ({
  digests: {} as Partial<Record<'agent_sdk' | 'codex_sdk', string>>,
}));
vi.mock('../../src/security/scanner-images.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/security/scanner-images.ts')>();
  return {
    ...actual,
    securityScannerImagePins: () =>
      actual
        .securityScannerImagePins()
        .map((pin) => ({ ...pin, digest: pinState.digests[pin.engine] ?? null })),
  };
});
import { getPlatformCapabilities } from '../../src/capabilities.ts';
import { app } from '../../src/index.ts';
import {
  SecurityScannerError,
  securityScannerNames,
} from '../../src/provisioning/security-scanner.ts';
import { platformSettings } from '../../src/schema.ts';
import type { SelfTestResult } from '../../src/security-scanner-controller-runtime.ts';
import {
  judgeSelfTest,
  SECURITY_CREDITS_LINK,
  SECURITY_PROBE_COPY,
  securityProvisionMessage,
} from '../../src/security/probe.ts';
import type { SecurityProbeCheck } from '../../src/security/probe.ts';
import { createFakeRegistry, fakeImage } from '../__mocks__/image-registry.ts';
import type { FakeRegistry } from '../__mocks__/image-registry.ts';
import {
  clearTables,
  createOperatorToken,
  createTestUser,
  mockCfApiRealDispatchScripts as mockCfApi,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { MockCfApiHandle, TestEnv } from './helpers.ts';

// The entitlement probe, checks 1–6 (spec §5.2), against fakes: the Cloudflare API
// (mockCfApi), the dispatch gate (the controller's self-test answer), Workers AI and
// the AI Gateway REST routes.

let env: TestEnv;
let token: string;

type Fakes = {
  cf: MockCfApiHandle;
  selfTest: ReturnType<typeof vi.fn>;
  gates: Array<string>;
  ai: ReturnType<typeof vi.fn>;
  rest: Array<{ url: string; headers: Headers; body: Record<string, unknown> }>;
  registry: FakeRegistry;
  /** The engine of each self-test, in call order. */
  selfTestEngines: Array<string>;
};

const PASSING_REPORT = (probeId: string) => ({
  selfTest: 1,
  uid: 999,
  node: 'v24.0.0',
  model: { ok: true, status: 200, probe: probeId, ms: 3 },
  egress: {
    httpExample: { blocked: true, ms: 2, status: 403 },
    httpsExample: { blocked: true, ms: 1, error: 'ECONNRESET' },
    httpsBareIp: { blocked: true, ms: 1, error: 'ECONNRESET' },
    httpUnknownHost: { blocked: true, ms: 2, status: 403 },
  },
  envSuspicious: [],
});

let fakes: Fakes;
let bindings: TestEnv;
let restStatus: { messages: number; responses: number };
let selfTestAnswer: (probeId: string, engine: string) => SelfTestResult;
const ENGINE_A_IMAGE = fakeImage({ layers: 2 });
const ENGINE_C_IMAGE = fakeImage({ layers: 3 });

function stubFetch(cf: MockCfApiHandle, rest: Fakes['rest'], registry: FakeRegistry) {
  const next = registry.fetch(cf as unknown as typeof fetch);
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/ai/v1/')) {
      rest.push({
        url,
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json(
        {},
        { status: url.endsWith('/messages') ? restStatus.messages : restStatus.responses },
      );
    }
    return next(input, init);
  });
}

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  const admin = await createTestUser(env.db, 'probe-admin', 'github', undefined, 'free', 'admin');
  token = await createOperatorToken(env.db, admin);
  restStatus = { messages: 200, responses: 200 };
  selfTestAnswer = (probeId) => ({
    started: true,
    coldStartMs: 4200,
    report: PASSING_REPORT(probeId),
  });
  pinState.digests = { agent_sdk: ENGINE_A_IMAGE.digest, codex_sdk: ENGINE_C_IMAGE.digest };
  const cf = mockCfApi();
  const rest: Fakes['rest'] = [];
  const registry = createFakeRegistry({
    published: {
      'voidzero-dev/void-security-scanner-engine-a': ENGINE_A_IMAGE,
      'voidzero-dev/void-security-scanner-engine-c': ENGINE_C_IMAGE,
    },
  });
  stubFetch(cf, rest, registry);
  const selfTestEngines: Array<string> = [];
  const selfTest = vi.fn(async (_url: string, init: RequestInit) => {
    const { probeId, engine } = JSON.parse(String(init.body)) as {
      probeId: string;
      engine: string;
    };
    selfTestEngines.push(engine);
    return Response.json(selfTestAnswer(probeId, engine));
  });
  const gates: Array<string> = [];
  const ai = vi.fn(async () => ({ response: 'ok' }));
  fakes = { cf, selfTest, gates, ai, rest, registry, selfTestEngines };
  bindings = {
    ...env,
    PLATFORM_INSTALLATION_ID: 'inst_probe',
    PLATFORM_CAPABILITIES: JSON.stringify({
      ...getPlatformCapabilities(env),
      securityAudits: true,
    }),
    DISPATCH: {
      get: (name: string) => {
        gates.push(name);
        return { fetch: selfTest };
      },
    } as unknown as DispatchNamespace,
    AI: { run: ai } as unknown as Ai,
  } as TestEnv;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type ProbeBody = {
  probeId: string;
  ok: boolean;
  saved: boolean;
  revision: number | null;
  checks: Array<SecurityProbeCheck>;
  entitlement: { ok: boolean; missing: Array<string>; hosts: Record<string, boolean> };
};

async function probe(overrides: Partial<TestEnv> = {}): Promise<ProbeBody> {
  const response = await app.fetch(
    new Request('http://localhost/operator/v1/security/probe', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    }),
    { ...bindings, ...overrides },
  );
  expect(response.status).toBe(200);
  return await response.json<ProbeBody>();
}

function check(body: ProbeBody, name: SecurityProbeCheck['name'], host?: string) {
  return body.checks.find(
    (entry) => entry.name === name && (host === undefined || entry.host === host),
  );
}

/** Controller uploads so far (each one is a code deploy that restarts its Durable Objects). */
async function controllerUploads(): Promise<number> {
  const names = await securityScannerNames('inst_probe');
  return (fakes.cf.mock.calls as Array<[string, RequestInit | undefined]>).filter(
    ([url, init]) =>
      init?.method === 'PUT' && String(url).endsWith(`/workers/scripts/${names.worker}`),
  ).length;
}

async function containerNames(): Promise<Array<string>> {
  const names = await securityScannerNames('inst_probe');
  const metadata = fakes.cf.state.hostScripts.get(names.worker)?.metadata as
    | { containers: Array<{ name: string }> }
    | undefined;
  return (metadata?.containers ?? []).map((entry) => entry.name);
}

async function storedPolicy() {
  const [row] = await env.db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.key, SECURITY_POLICY_SETTINGS_KEY));
  return row?.value as Record<string, unknown> | undefined;
}

describe('security probe', () => {
  test('reports all six checks and stores the result', async () => {
    const body = await probe();
    expect(body.probeId.startsWith('pr_')).toBe(true);
    expect(body.checks.map((entry) => [entry.check, entry.name, entry.host, entry.status])).toEqual(
      [
        [1, 'capability', undefined, 'ok'],
        [2, 'container', undefined, 'ok'],
        [3, 'egress', undefined, 'ok'],
        [4, 'workers_ai', undefined, 'ok'],
        [5, 'credits', 'openai', 'ok'],
        [5, 'image', 'openai', 'ok'],
        [5, 'credits', 'anthropic', 'ok'],
        [5, 'image', 'anthropic', 'ok'],
        [6, 'email', undefined, 'off'],
      ],
    );
    expect(check(body, 'email')?.message).toBe(SECURITY_PROBE_COPY.email);
    expect(body).toMatchObject({
      ok: true,
      saved: true,
      revision: 1,
      entitlement: { ok: true, missing: [], hosts: { openai: true, anthropic: true } },
    });
    expect(await storedPolicy()).toMatchObject({
      mode: 'disabled',
      revision: 1,
      entitlement: { ok: true, hosts: { openai: true, anthropic: true } },
    });

    // Check 2 provisioned the scanner and ran the self-test through its gate, once for
    // Engine B and once in each engine image (check 5), after copying both images.
    const names = await securityScannerNames('inst_probe');
    expect(fakes.cf.state.hostScripts.has(names.worker)).toBe(true);
    expect(fakes.gates).toEqual([names.gate, names.gate, names.gate]);
    expect([...fakes.selfTestEngines].sort()).toEqual(['agent_sdk', 'codex_sdk', 'void_loop']);
    for (const [engine, image] of [
      ['agent_sdk', ENGINE_A_IMAGE],
      ['codex_sdk', ENGINE_C_IMAGE],
    ] as const) {
      const repository = `${env.CF_ACCOUNT_ID}/${names.engines[engine].repository}`;
      expect(fakes.registry.hasManifest(repository, image.digest)).toBe(true);
      expect(fakes.registry.prepared).toContain(
        `registry.cloudflare.com/${repository}@${image.digest}`,
      );
    }
    const metadata = fakes.cf.state.hostScripts.get(names.worker)?.metadata as
      | { containers: Array<{ name: string }> }
      | undefined;
    const containers = metadata?.containers ?? [];
    expect(containers.map((entry) => entry.name)).toEqual([
      names.application,
      names.engines.agent_sdk.application,
      names.engines.codex_sdk.application,
    ]);

    // Check 4: a 1-token call with payload logging and the cache off.
    expect(fakes.ai).toHaveBeenCalledWith(
      '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
      expect.objectContaining({ max_tokens: 1 }),
      expect.objectContaining({
        gateway: expect.objectContaining({ id: 'void', skipCache: true }),
        extraHeaders: { 'cf-aig-collect-log-payload': 'false', 'cf-aig-skip-cache': 'true' },
      }),
    );
    // Check 5: the engines' own routes; openai/* carries the cyber access program.
    const messages = fakes.rest.find((call) => call.url.endsWith('/ai/v1/messages'))!;
    const responses = fakes.rest.find((call) => call.url.endsWith('/ai/v1/responses'))!;
    expect(messages.body).toMatchObject({ model: 'anthropic/claude-opus-5.5', max_tokens: 1 });
    expect(responses.body).toMatchObject({
      model: 'openai/gpt-6.1-terra',
      access_programs: { cyber: 'standard' },
    });
    for (const call of [messages, responses]) {
      expect(call.headers.get('cf-aig-gateway-id')).toBe('void');
      expect(call.headers.get('cf-aig-collect-log-payload')).toBe('false');
      expect(call.headers.get('cf-aig-skip-cache')).toBe('true');
    }
  });

  test('capability off: check 1 copy, nothing else runs, nothing is stored', async () => {
    const body = await probe({ PLATFORM_CAPABILITIES: env.PLATFORM_CAPABILITIES });
    expect(check(body, 'capability')).toMatchObject({
      status: 'fail',
      message: 'Security audits are not installed. Run: void platform upgrade --security-audits',
    });
    expect(body.checks.filter((entry) => entry.status === 'skipped')).toHaveLength(7);
    expect(body).toMatchObject({ ok: false, saved: false });
    expect(fakes.cf).not.toHaveBeenCalled();
    expect(fakes.rest).toEqual([]);
    expect(fakes.ai).not.toHaveBeenCalled();
    expect(fakes.gates).toEqual([]);
    expect(await storedPolicy()).toBeUndefined();
  });

  test('check 2: no Containers access fails with the permission copy and skips check 3', async () => {
    fakes.cf = mockCfApi({
      listContainerApps: () =>
        Response.json(
          { success: false, errors: [{ code: 10_000, message: 'Authentication error' }] },
          { status: 403 },
        ),
    });
    stubFetch(fakes.cf, fakes.rest, fakes.registry);
    const body = await probe();
    expect(check(body, 'container')).toMatchObject({
      status: 'fail',
      message:
        'Scans run in a Cloudflare Container. They need Workers Paid, and the runtime token needs Account → Containers → Edit and Account → Cloudchamber → Edit.',
    });
    expect(check(body, 'egress')?.status).toBe('skipped');
    expect(body.entitlement).toMatchObject({ ok: false, missing: ['container', 'egress'] });
    expect(fakes.selfTest).not.toHaveBeenCalled();
    // No image is copied into an account that cannot run containers.
    expect(fakes.registry.calls).toEqual([]);
    expect(check(body, 'image', 'openai')).toMatchObject({
      status: 'skipped',
      message: SECURITY_PROBE_COPY.imageSkipped,
    });
  });

  test('check 2: a container that does not start, or runs as root, fails', async () => {
    selfTestAnswer = () => ({
      started: false,
      coldStartMs: null,
      report: null,
      error: 'no capacity',
    });
    const notStarted = await probe();
    expect(check(notStarted, 'container')).toMatchObject({ status: 'fail', detail: 'no capacity' });
    expect(notStarted.entitlement.missing).toEqual(['container', 'egress']);

    selfTestAnswer = (probeId) => ({
      started: true,
      coldStartMs: 1,
      report: { ...PASSING_REPORT(probeId), uid: 0 },
    });
    const root = await probe();
    expect(check(root, 'container')).toMatchObject({
      status: 'fail',
      detail: 'the scanner ran as root',
    });
  });

  test('check 3: a reachable host fails with the probe id in the copy and in the log', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    selfTestAnswer = (probeId) => {
      const report = PASSING_REPORT(probeId);
      return {
        started: true,
        coldStartMs: 1,
        report: {
          ...report,
          egress: { ...report.egress, httpsExample: { blocked: false, ms: 40, status: 200 } },
        },
      };
    };
    const body = await probe();
    expect(check(body, 'egress')).toMatchObject({
      status: 'fail',
      message: `Scanner network lock failed (probe ${body.probeId}). The scanner could reach the internet, so scans stay off to keep code private. Run void platform security probe again; if it keeps failing, report probe ${body.probeId} with void platform logs.`,
      detail: 'httpsExample was reachable',
    });
    expect(body.entitlement).toMatchObject({ ok: false, missing: ['egress'] });
    expect(errors).toHaveBeenCalledWith(
      '[security-probe] egress lock failed',
      expect.objectContaining({ probeId: body.probeId }),
    );
  });

  test('check 4: a failed Workers AI call names the model and the plan', async () => {
    fakes.ai.mockRejectedValueOnce(new Error('3036: account has no credits'));
    const body = await probe();
    expect(check(body, 'workers_ai')).toMatchObject({
      status: 'fail',
      message:
        'Could not run @cf/deepseek-ai/deepseek-v4.1-flash-1017. It needs Workers Paid or prepaid AI credits.',
    });
    expect(body.entitlement).toMatchObject({ ok: false, missing: ['workers_ai'] });
  });

  test('check 5: a host without credits or permission only blocks its own models', async () => {
    restStatus = { messages: 402, responses: 403 };
    const body = await probe();
    expect(check(body, 'credits', 'anthropic')).toMatchObject({
      status: 'fail',
      message:
        'No AI Gateway credits for anthropic/*. Load Unified Billing credits to let projects pick these models.',
      link: SECURITY_CREDITS_LINK,
    });
    expect(check(body, 'credits', 'openai')).toMatchObject({
      status: 'fail',
      message: SECURITY_PROBE_COPY.creditsPermission('openai'),
    });
    // Checks 1–4 passed, so the feature can still turn on.
    expect(body.entitlement).toEqual(
      expect.objectContaining({
        ok: true,
        missing: [],
        hosts: { openai: false, anthropic: false },
      }),
    );
    // A host that cannot be called gets no image copy and no image self-test.
    for (const host of ['openai', 'anthropic'] as const) {
      expect(check(body, 'image', host)).toMatchObject({
        status: 'skipped',
        message: SECURITY_PROBE_COPY.imageNoCredits(host),
      });
    }
    expect(fakes.registry.calls.filter((call) => call.includes('ghcr'))).toEqual([]);
    expect(fakes.selfTestEngines).toEqual(['void_loop']);
  });

  test('check 5 image: a release with no image for an engine keeps only that host off', async () => {
    pinState.digests = { codex_sdk: ENGINE_C_IMAGE.digest };
    const body = await probe();
    expect(check(body, 'image', 'anthropic')).toMatchObject({
      status: 'fail',
      message: SECURITY_PROBE_COPY.imageUnpublished('anthropic'),
    });
    expect(check(body, 'image', 'openai')?.status).toBe('ok');
    expect(body.entitlement).toMatchObject({ ok: true, hosts: { openai: true, anthropic: false } });
    expect([...fakes.selfTestEngines].sort()).toEqual(['codex_sdk', 'void_loop']);
    const names = await securityScannerNames('inst_probe');
    const metadata = fakes.cf.state.hostScripts.get(names.worker)?.metadata as {
      containers: Array<{ name: string }>;
    };
    expect(metadata.containers.map((entry) => entry.name)).toEqual([
      names.application,
      names.engines.codex_sdk.application,
    ]);
  });

  test('check 5 image: an engine image that fails its self-test keeps only that host off', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    selfTestAnswer = (probeId, engine) => ({
      started: true,
      coldStartMs: 1,
      report: { ...PASSING_REPORT(probeId), ...(engine === 'agent_sdk' ? { uid: 0 } : {}) },
    });
    const body = await probe();
    expect(check(body, 'container')?.status).toBe('ok');
    expect(check(body, 'image', 'anthropic')).toMatchObject({
      status: 'fail',
      message: SECURITY_PROBE_COPY.imageSelfTest('anthropic', body.probeId),
      detail: 'the scanner ran as root',
    });
    expect(body.entitlement).toMatchObject({ ok: true, hosts: { openai: true, anthropic: false } });
    expect(errors).toHaveBeenCalledWith(
      '[security-probe] engine image self-test failed',
      expect.objectContaining({ probeId: body.probeId, host: 'anthropic' }),
    );
  });

  test('check 5 image: a copy the registry refuses names the token permission', async () => {
    fakes.registry = createFakeRegistry({ credentialsStatus: 403 });
    stubFetch(fakes.cf, fakes.rest, fakes.registry);
    const body = await probe();
    for (const host of ['openai', 'anthropic'] as const) {
      expect(check(body, 'image', host)).toMatchObject({
        status: 'fail',
        message: SECURITY_PROBE_COPY.imageCredentials(host),
      });
    }
    // Engine B is not affected.
    expect(body.entitlement).toMatchObject({
      ok: true,
      hosts: { openai: false, anthropic: false },
    });
  });

  test('check 5 image: a later failed call or copy never takes a deployed engine off', async () => {
    const first = await probe();
    expect(first.entitlement.hosts).toEqual({ openai: true, anthropic: true });
    const uploads = await controllerUploads();
    const deployed = await containerNames();
    expect(deployed).toHaveLength(3);

    // No credits for anthropic/* this time: no copy and no self-test for it, but the
    // controller is not uploaded again and keeps the engine's container.
    restStatus = { messages: 429, responses: 200 };
    fakes.selfTestEngines.length = 0;
    const noCredits = await probe();
    expect(check(noCredits, 'image', 'anthropic')).toMatchObject({
      status: 'skipped',
      message: SECURITY_PROBE_COPY.imageNoCredits('anthropic'),
    });
    expect(noCredits.entitlement.hosts).toEqual({ openai: true, anthropic: false });
    expect([...fakes.selfTestEngines].sort()).toEqual(['codex_sdk', 'void_loop']);
    expect(await controllerUploads()).toBe(uploads);
    expect(await containerNames()).toEqual(deployed);

    // Registry credentials fail once: the deployed images still run their self-test.
    restStatus = { messages: 200, responses: 200 };
    fakes.registry = createFakeRegistry({ credentialsStatus: 503 });
    stubFetch(fakes.cf, fakes.rest, fakes.registry);
    const noRegistry = await probe();
    expect(check(noRegistry, 'image', 'anthropic')?.status).toBe('ok');
    expect(check(noRegistry, 'image', 'openai')?.status).toBe('ok');
    expect(noRegistry.entitlement.hosts).toEqual({ openai: true, anthropic: true });
    expect(await controllerUploads()).toBe(uploads);
    expect(await containerNames()).toEqual(deployed);
  });

  test('check 5 image: a host whose models are all blocked gets no copy and no self-test', async () => {
    const blockedModels = SECURITY_MODEL_IDS.filter(
      (id) => getSecurityModel(id).host === 'anthropic',
    );
    await env.db.insert(platformSettings).values({
      key: SECURITY_POLICY_SETTINGS_KEY,
      value: {
        mode: 'disabled',
        defaultModel: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
        blockedModels,
        thirdPartyNotice: null,
        limits: {
          concurrency: 2,
          timeoutMinutes: 20,
          maxInputTokens: 600_000,
          maxOutputTokens: 60_000,
          modelCallsPerScan: 80,
        },
        budgets: {
          platformCapOn: false,
          platformMonthlyUsd: 1000,
          projectCapsOn: false,
          projectDefaultMonthlyUsd: 100,
        },
        entitlement: null,
        publicGate: false,
        revision: 1,
      },
    });
    const body = await probe();
    expect(body.saved).toBe(true);
    expect(check(body, 'image', 'anthropic')).toMatchObject({
      status: 'skipped',
      message: SECURITY_PROBE_COPY.imageBlocked('anthropic'),
    });
    expect(check(body, 'image', 'openai')?.status).toBe('ok');
    expect(
      fakes.registry.calls.filter((call) => call.includes('void-security-scanner-engine-a')),
    ).toEqual([]);
    expect([...fakes.selfTestEngines].sort()).toEqual(['codex_sdk', 'void_loop']);
    const names = await securityScannerNames('inst_probe');
    expect(await containerNames()).toEqual([
      names.application,
      names.engines.codex_sdk.application,
    ]);
  });

  test('check 6: an email binding is reported on', async () => {
    const body = await probe({ EMAIL: { send: vi.fn() } as unknown as SendEmail });
    expect(check(body, 'email')).toMatchObject({ status: 'ok' });
    expect(check(body, 'email')?.message).toBeUndefined();
  });

  test('a stored policy that cannot be read is left alone', async () => {
    await env.db
      .insert(platformSettings)
      .values({ key: SECURITY_POLICY_SETTINGS_KEY, value: { mode: 'sideways', revision: 7 } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await probe();
    expect(body).toMatchObject({ ok: true, saved: false, revision: null });
    expect(await storedPolicy()).toEqual({ mode: 'sideways', revision: 7 });
  });

  test('Off → on runs the probe; a failing check refuses the change', async () => {
    const policyRequest = (body: Record<string, unknown>) =>
      app.fetch(
        new Request('http://localhost/operator/v1/security/policy', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        bindings,
      );
    fakes.ai.mockRejectedValueOnce(new Error('no credits'));
    const refused = await policyRequest({ expectedRevision: 0, mode: 'public' });
    expect(refused.status).toBe(409);
    const refusedBody = await refused.json<{
      message: string;
      details: { probeId: string; checks: Array<Record<string, unknown>> };
    }>();
    expect(refusedBody).toMatchObject({
      error: 'security entitlement missing',
      details: {
        missing: ['workers_ai'],
        checks: [
          {
            name: 'workers_ai',
            message: SECURITY_PROBE_COPY.workersAi('@cf/deepseek-ai/deepseek-v4.1-flash-1017'),
          },
        ],
      },
    });
    expect(refusedBody.details.probeId).toMatch(/^pr_/);
    expect(refusedBody.message).toContain(`probe ${refusedBody.details.probeId}`);
    // Engine B and both engine images ran their self-test.
    expect(await storedPolicy()).toMatchObject({
      mode: 'disabled',
      revision: 1,
      entitlement: { ok: false, missing: ['workers_ai'] },
    });
    expect(fakes.selfTest).toHaveBeenCalledTimes(3);

    const accepted = await policyRequest({ expectedRevision: 1, mode: 'public' });
    expect(accepted.status).toBe(200);
    expect(await storedPolicy()).toMatchObject({
      mode: 'public',
      revision: 2,
      entitlement: { ok: true },
    });
    expect(fakes.selfTest).toHaveBeenCalledTimes(6);
  });
});

describe('securityProvisionMessage', () => {
  test('gives the plan and token copy only to plan and token problems', () => {
    for (const kind of ['containers_unavailable', 'application', 'upload'] as const) {
      expect(securityProvisionMessage(new SecurityScannerError(kind, 'x'))).toBe(
        SECURITY_PROBE_COPY.container,
      );
    }
    expect(securityProvisionMessage(new Error('network'))).toBe(SECURITY_PROBE_COPY.container);
    for (const kind of ['ownership', 'outdated', 'missing', 'gate'] as const) {
      const message = `the ${kind} problem`;
      expect(securityProvisionMessage(new SecurityScannerError(kind, message))).toBe(message);
    }
  });
});

describe('judgeSelfTest', () => {
  const passing = (probeId: string): SelfTestResult => ({
    started: true,
    coldStartMs: 1,
    report: PASSING_REPORT(probeId),
  });

  test('passes a non-root self-test that saw this probe id and no internet', () => {
    expect(judgeSelfTest(passing('pr_1'), 'pr_1')).toEqual({
      container: { ok: true },
      egress: { ok: true },
    });
  });

  test('fails egress for another probe id, a token-like env name or no targets', () => {
    expect(judgeSelfTest(passing('pr_other'), 'pr_1').egress.ok).toBe(false);
    const report = PASSING_REPORT('pr_1');
    expect(
      judgeSelfTest(
        { ...passing('pr_1'), report: { ...report, envSuspicious: ['CF_API_TOKEN'] } },
        'pr_1',
      ).egress,
    ).toEqual({ ok: false, detail: 'credential-like env names: CF_API_TOKEN' });
    expect(
      judgeSelfTest({ ...passing('pr_1'), report: { ...report, egress: {} } }, 'pr_1').egress.ok,
    ).toBe(false);
  });
});
