import { describe, expect, it, vi } from 'vite-plus/test';
import { CloudflareApiError } from '../../src/provisioning/cloudflare-api.ts';
import {
  buildProxyTokenBindingsPatch,
  CloudflareRateLimitError,
  createRotationCloudflareClient,
  RotationBudgetExhaustedError,
  type ScriptBinding,
} from '../../src/proxy-token-rotation-cloudflare.ts';
import type { RotationBudget } from '../../src/proxy-token-rotation.ts';

const ACCOUNT = 'acc_test';
const API_TOKEN = 'cf-token';
const NAMESPACE = 'void-tenants';
const SCRIPT = 'user-demo-dep_000000000001';
const SCRIPT_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/dispatch/namespaces/${NAMESPACE}/scripts/${SCRIPT}`;

const BINDINGS: ReadonlyArray<ScriptBinding> = [
  { name: 'DB', type: 'd1' },
  { name: '__VOID_PROXY', type: 'service' },
  { name: '__VOID_PROXY_TOKEN', type: 'plain_text', text: 'old' },
  { name: 'S', type: 'secret_text' },
];

function budget(cfCallsRemaining = 10): RotationBudget {
  return { cfCallsRemaining, deadline: Date.now() + 60_000 };
}

function client(fetchMock: typeof fetch, runBudget: RotationBudget = budget()) {
  return createRotationCloudflareClient({
    accountId: ACCOUNT,
    apiToken: API_TOKEN,
    dispatchNamespace: NAMESPACE,
    budget: runBudget,
    fetch: fetchMock,
  });
}

function cfSuccess(result: unknown): Response {
  return Response.json({ success: true, errors: [], result });
}

describe('buildProxyTokenBindingsPatch', () => {
  it('inherits every other binding in order and sets the token', () => {
    expect(buildProxyTokenBindingsPatch(BINDINGS, 'new')).toStrictEqual([
      { type: 'inherit', name: 'DB' },
      { type: 'inherit', name: '__VOID_PROXY' },
      { type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: 'new' },
      { type: 'inherit', name: 'S' },
    ]);
  });

  it('throws when the script has no token binding', () => {
    expect(() =>
      buildProxyTokenBindingsPatch(
        BINDINGS.filter((binding) => binding.name !== '__VOID_PROXY_TOKEN'),
        'new',
      ),
    ).toThrow(/__VOID_PROXY_TOKEN/);
  });
});

describe('createRotationCloudflareClient', () => {
  it('reads script bindings', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => cfSuccess(BINDINGS));
    await expect(client(fetchMock).getScriptBindings(SCRIPT)).resolves.toStrictEqual(BINDINGS);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${SCRIPT_URL}/bindings`);
    expect(init?.method).toBe('GET');
    expect(init?.headers).toStrictEqual({ Authorization: `Bearer ${API_TOKEN}` });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends the settings PATCH as one multipart settings part', async () => {
    const patched: ReadonlyArray<ScriptBinding> = [
      { name: '__VOID_PROXY_TOKEN', type: 'plain_text', text: 'new' },
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => cfSuccess({ bindings: patched }));
    const bindings = buildProxyTokenBindingsPatch(BINDINGS, 'new');

    await expect(client(fetchMock).patchScriptBindings(SCRIPT, bindings)).resolves.toStrictEqual(
      patched,
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${SCRIPT_URL}/settings`);
    expect(init?.method).toBe('PATCH');
    expect(init?.headers).toStrictEqual({ Authorization: `Bearer ${API_TOKEN}` });
    const form = init?.body;
    expect(form).toBeInstanceOf(FormData);
    expect([...(form as FormData).keys()]).toStrictEqual(['settings']);
    const part = (form as FormData).get('settings') as Blob;
    expect(part.type).toBe('application/json');
    expect(JSON.parse(await part.text())).toStrictEqual({ bindings });
  });

  it('returns null when the PATCH result has no bindings', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => cfSuccess({ compatibility_date: 'x' }));
    await expect(
      client(fetchMock).patchScriptBindings(SCRIPT, [{ type: 'inherit', name: 'DB' }]),
    ).resolves.toBeNull();
  });

  it.each([
    ['HTTP 404', () => Response.json({ success: false, errors: [] }, { status: 404 })],
    [
      'code 10007',
      () =>
        Response.json(
          {
            success: false,
            errors: [{ code: 10_007, message: 'workers.api.error.script_not_found' }],
          },
          { status: 400 },
        ),
    ],
  ])('returns null for a missing script (%s)', async (_label, response) => {
    const fetchMock = vi.fn<typeof fetch>(async () => response());
    await expect(client(fetchMock).getScriptBindings(SCRIPT)).resolves.toBeNull();
  });

  it('throws other Cloudflare errors with their status and codes', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        { success: false, errors: [{ code: 10_000, message: 'boom' }] },
        { status: 500 },
      ),
    );
    const error = await client(fetchMock)
      .getScriptBindings(SCRIPT)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect(error).toMatchObject({ status: 500, codes: [10_000], message: /boom/ });
  });

  it('throws a rate limit with the Retry-After seconds and makes one call', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '3' } }),
    );
    const error = await client(fetchMock)
      .getScriptBindings(SCRIPT)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudflareRateLimitError);
    expect((error as CloudflareRateLimitError).retryAfterSeconds).toBe(3);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('defaults the rate limit wait to 60 seconds', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('', { status: 429 }));
    await expect(client(fetchMock).getScriptBindings(SCRIPT)).rejects.toMatchObject({
      retryAfterSeconds: 60,
    });
  });

  it('counts each call against the budget and stops before fetch when it is spent', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => cfSuccess(BINDINGS));
    const runBudget = budget(1);
    const rotation = client(fetchMock, runBudget);

    await rotation.getScriptBindings(SCRIPT);
    expect(runBudget.cfCallsRemaining).toBe(0);
    await expect(rotation.getScriptBindings(SCRIPT)).rejects.toBeInstanceOf(
      RotationBudgetExhaustedError,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('stops before fetch when the deadline has passed', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => cfSuccess(BINDINGS));
    const runBudget = { cfCallsRemaining: 5, deadline: Date.now() - 1 };
    await expect(client(fetchMock, runBudget).getScriptBindings(SCRIPT)).rejects.toBeInstanceOf(
      RotationBudgetExhaustedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runBudget.cfCallsRemaining).toBe(5);
  });

  it('stops before fetch when less than five seconds are left', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => cfSuccess(BINDINGS));
    const runBudget = { cfCallsRemaining: 5, deadline: Date.now() + 4000 };
    await expect(client(fetchMock, runBudget).getScriptBindings(SCRIPT)).rejects.toBeInstanceOf(
      RotationBudgetExhaustedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('times a call out at the run deadline when it comes before the request timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn<typeof fetch>(async () => cfSuccess(BINDINGS));
    const runBudget = { cfCallsRemaining: 5, deadline: Date.now() + 20_000 };
    await client(fetchMock, runBudget).getScriptBindings(SCRIPT);
    const [ms] = timeout.mock.calls[0] ?? [];
    expect(ms).toBeGreaterThan(15_000);
    expect(ms).toBeLessThanOrEqual(20_000);
    timeout.mockRestore();
  });
});
