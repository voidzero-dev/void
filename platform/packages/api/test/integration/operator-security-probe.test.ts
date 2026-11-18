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
  type SecurityProbeCheck,
} from '../../src/security/probe.ts';
import {
  clearTables,
  createOperatorToken,
  createTestUser,
  mockCfApi,
  setupEnv,
  teardownEnv,
  type MockCfApiHandle,
  type TestEnv,
} from './helpers.ts';

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
let selfTestAnswer: (probeId: string) => SelfTestResult;

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
  const cf = mockCfApi();
  const rest: Fakes['rest'] = [];
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
    return (cf as unknown as typeof fetch)(input, init);
  });
  const selfTest = vi.fn(async (_url: string, init: RequestInit) => {
    const { probeId } = JSON.parse(String(init.body)) as { probeId: string };
    return Response.json(selfTestAnswer(probeId));
  });
  const gates: Array<string> = [];
  const ai = vi.fn(async () => ({ response: 'ok' }));
  fakes = { cf, selfTest, gates, ai, rest };
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
  return (await response.json()) as ProbeBody;
}

function check(body: ProbeBody, name: SecurityProbeCheck['name'], host?: string) {
  return body.checks.find(
    (entry) => entry.name === name && (host === undefined || entry.host === host),
  );
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
    expect(body.checks.map((entry) => [entry.check, entry.status])).toEqual([
      [1, 'ok'],
      [2, 'ok'],
      [3, 'ok'],
      [4, 'ok'],
      [5, 'ok'],
      [5, 'ok'],
      [6, 'off'],
    ]);
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

    // Check 2 provisioned the scanner and ran the self-test through its gate.
    const names = await securityScannerNames('inst_probe');
    expect(fakes.cf.state.hostScripts.has(names.worker)).toBe(true);
    expect(fakes.gates).toEqual([names.gate]);
    expect(fakes.selfTest).toHaveBeenCalledTimes(1);

    // Check 4: a 1-token call with payload logging and the cache off.
    expect(fakes.ai).toHaveBeenCalledWith(
      '@cf/zai-org/glm-5.3',
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
    expect(body.checks.filter((entry) => entry.status === 'skipped')).toHaveLength(5);
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
          { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
          { status: 403 },
        ),
    });
    const cf = fakes.cf;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes('/ai/v1/')
        ? Response.json({})
        : (cf as unknown as typeof fetch)(input, init),
    );
    const body = await probe();
    expect(check(body, 'container')).toMatchObject({
      status: 'fail',
      message:
        'Scans run in a Cloudflare Container. They need Workers Paid, and the runtime token needs Account → Containers → Edit and Account → Cloudchamber → Edit.',
    });
    expect(check(body, 'egress')?.status).toBe('skipped');
    expect(body.entitlement).toMatchObject({ ok: false, missing: ['container', 'egress'] });
    expect(fakes.selfTest).not.toHaveBeenCalled();
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
      message: 'Could not run @cf/zai-org/glm-5.3. It needs Workers Paid or prepaid AI credits.',
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
    const refusedBody = (await refused.json()) as {
      message: string;
      details: { probeId: string; checks: Array<Record<string, unknown>> };
    };
    expect(refusedBody).toMatchObject({
      error: 'security entitlement missing',
      details: {
        missing: ['workers_ai'],
        checks: [
          { name: 'workers_ai', message: SECURITY_PROBE_COPY.workersAi('@cf/zai-org/glm-5.3') },
        ],
      },
    });
    expect(refusedBody.details.probeId).toMatch(/^pr_/);
    expect(refusedBody.message).toContain(`probe ${refusedBody.details.probeId}`);
    expect(await storedPolicy()).toMatchObject({
      mode: 'disabled',
      revision: 1,
      entitlement: { ok: false, missing: ['workers_ai'] },
    });
    expect(fakes.selfTest).toHaveBeenCalledTimes(1);

    const accepted = await policyRequest({ expectedRevision: 1, mode: 'public' });
    expect(accepted.status).toBe(200);
    expect(await storedPolicy()).toMatchObject({
      mode: 'public',
      revision: 2,
      entitlement: { ok: true },
    });
    expect(fakes.selfTest).toHaveBeenCalledTimes(2);
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
