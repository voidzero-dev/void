import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { CF_CUSTOMER_API_BASE, createCfCustomerClient } from '../../src/email/cf-customer.ts';
import { CloudflareApiError } from '../../src/provisioning/cloudflare-api.ts';

// Dummy stand-ins — never real token material, per the no-secrets rule.
const CREDENTIAL = 'cf-credential-dummy';
const ACCOUNT = 'acct_1';
const ZONE = 'zone_1';
const RELAY = 'void-email-relay';

function cfSuccess(result: unknown): Response {
  return Response.json({ success: true, errors: [], result });
}

function cfError(message: string, status = 400): Response {
  return Response.json({ success: false, errors: [{ code: 100, message }] }, { status });
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1)!;
  return { url: call[0] as string, init: (call[1] ?? {}) as RequestInit };
}

describe('cf-customer client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('verifyToken', () => {
    it('GETs /user/tokens/verify with the bearer and returns the result', async () => {
      fetchMock.mockResolvedValueOnce(
        cfSuccess({ id: 'tok_1', status: 'active', expires_on: '2027-01-01T00:00:00Z' }),
      );
      const client = createCfCustomerClient(CREDENTIAL);

      const result = await client.verifyToken(ACCOUNT);

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/user/tokens/verify`);
      expect(init.method).toBeUndefined();
      expect(Object.fromEntries(new Headers(init.headers))).toEqual({
        authorization: `Bearer ${CREDENTIAL}`,
        'content-type': 'application/json',
      });
      expect(init.body).toBeUndefined();
      expect(result).toEqual({ id: 'tok_1', status: 'active', expires_on: '2027-01-01T00:00:00Z' });
    });

    it('throws CloudflareApiError carrying the HTTP status on envelope failure', async () => {
      fetchMock.mockImplementation(async () => cfError('invalid token', 401));
      const client = createCfCustomerClient(CREDENTIAL);

      const error = await client.verifyToken(ACCOUNT).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(CloudflareApiError);
      expect((error as CloudflareApiError).status).toBe(401);
      expect((error as CloudflareApiError).message).toContain('invalid token');
    });

    it('verifies an account token when the user endpoint rejects it', async () => {
      fetchMock
        .mockResolvedValueOnce(cfError('invalid user token', 401))
        .mockResolvedValueOnce(cfSuccess({ id: 'account-token', status: 'active' }));

      await expect(createCfCustomerClient(CREDENTIAL).verifyToken(ACCOUNT)).resolves.toEqual({
        id: 'account-token',
        status: 'active',
      });
      expect(lastCall(fetchMock).url).toBe(
        `${CF_CUSTOMER_API_BASE}/accounts/${ACCOUNT}/tokens/verify`,
      );
    });

    it('does not retry a provider outage as another token type', async () => {
      fetchMock.mockResolvedValueOnce(cfError('unavailable', 503));
      await expect(createCfCustomerClient(CREDENTIAL).verifyToken(ACCOUNT)).rejects.toMatchObject({
        status: 503,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retains an inactive user-token result without trying the account endpoint', async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess({ id: 'expired-token', status: 'expired' }));
      await expect(createCfCustomerClient(CREDENTIAL).verifyToken(ACCOUNT)).resolves.toMatchObject({
        status: 'expired',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('findZone', () => {
    it('GETs /zones?name= and returns the exact-name match with its account', async () => {
      fetchMock.mockResolvedValueOnce(
        cfSuccess([
          { id: 'zone_9', name: 'acme.com.evil.example', account: { id: 'acct_9' } },
          { id: ZONE, name: 'acme.com', account: { id: ACCOUNT } },
        ]),
      );
      const client = createCfCustomerClient(CREDENTIAL);

      const zone = await client.findZone('acme.com');

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/zones?name=acme.com`);
      expect(init.method).toBeUndefined();
      expect(zone).toEqual({ id: ZONE, name: 'acme.com', account: { id: ACCOUNT } });
    });

    it('returns null when the credential sees no such zone', async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess([]));
      const client = createCfCustomerClient(CREDENTIAL);

      await expect(client.findZone('acme.com')).resolves.toBeNull();
    });
  });

  describe('enableRouting', () => {
    it('POSTs an empty body for the apex', async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess({}));
      const client = createCfCustomerClient(CREDENTIAL);

      await client.enableRouting(ZONE);

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/zones/${ZONE}/email/routing/dns`);
      expect(init.method).toBe('POST');
      expect(init.body).toBeUndefined();
    });

    it('POSTs { name } for a subdomain', async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess({}));
      const client = createCfCustomerClient(CREDENTIAL);

      await client.enableRouting(ZONE, 'mail.acme.com');

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/zones/${ZONE}/email/routing/dns`);
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ name: 'mail.acme.com' });
    });
  });

  describe('onboardSending', () => {
    it('POSTs /zones/{z}/email/sending/subdomains with { name }', async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess({}));
      const client = createCfCustomerClient(CREDENTIAL);

      await client.onboardSending(ZONE, 'mail.acme.com');

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/zones/${ZONE}/email/sending/subdomains`);
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ name: 'mail.acme.com' });
    });
  });

  describe('listSendingSubdomains', () => {
    it('GETs the list and parses name + enabled, dropping malformed entries', async () => {
      fetchMock.mockResolvedValueOnce(
        cfSuccess([
          { name: 'mail.acme.com', enabled: true, tag: 'sub_1' },
          { name: 'alerts.acme.com' }, // enabled missing → false
          'not-an-object',
          { enabled: true }, // no name → dropped
        ]),
      );
      const client = createCfCustomerClient(CREDENTIAL);

      const result = await client.listSendingSubdomains(ZONE);

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(
        `${CF_CUSTOMER_API_BASE}/zones/${ZONE}/email/sending/subdomains?page=1&per_page=50`,
      );
      expect(init.method).toBeUndefined();
      // A short page (<50 rows) is the last page — exactly one request.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual([
        { name: 'mail.acme.com', enabled: true },
        { name: 'alerts.acme.com', enabled: false },
      ]);
    });

    it('paginates: a full page is followed by the next until a short page', async () => {
      const pageOne = Array.from({ length: 50 }, (_, index) => ({
        name: `sub-${String(index + 1).padStart(2, '0')}.acme.com`,
        enabled: index % 2 === 0,
      }));
      fetchMock.mockResolvedValueOnce(cfSuccess(pageOne));
      fetchMock.mockResolvedValueOnce(cfSuccess([{ name: 'mail.acme.com', enabled: true }]));
      const client = createCfCustomerClient(CREDENTIAL);

      const result = await client.listSendingSubdomains(ZONE);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe(
        `${CF_CUSTOMER_API_BASE}/zones/${ZONE}/email/sending/subdomains?page=1&per_page=50`,
      );
      expect(fetchMock.mock.calls[1][0]).toBe(
        `${CF_CUSTOMER_API_BASE}/zones/${ZONE}/email/sending/subdomains?page=2&per_page=50`,
      );
      expect(result).toHaveLength(51);
      expect(result[0]).toEqual({ name: 'sub-01.acme.com', enabled: true });
      expect(result.at(-1)).toEqual({ name: 'mail.acme.com', enabled: true });
    });

    it('returns [] when the result is not an array', async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess({}));
      const client = createCfCustomerClient(CREDENTIAL);

      await expect(client.listSendingSubdomains(ZONE)).resolves.toEqual([]);
    });
  });

  describe('putRelayScript', () => {
    it('PUTs multipart FormData with metadata (main_module, compat date, plain-text vars) and the module', async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess({ id: 'script_1' }));
      const client = createCfCustomerClient(CREDENTIAL);

      await client.putRelayScript(ACCOUNT, RELAY, {
        source: 'export default {};\n',
        compatibilityDate: '2026-09-01',
        gatewayOrigin: 'https://gateway.example.test',
        accountId: ACCOUNT,
        zoneId: ZONE,
        ingressName: RELAY,
      });

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/accounts/${ACCOUNT}/workers/scripts/${RELAY}`);
      expect(init.method).toBe('PUT');
      // The multipart boundary belongs to fetch — the client must not pin a
      // Content-Type on a FormData body.
      expect(Object.fromEntries(new Headers(init.headers))).toEqual({
        authorization: `Bearer ${CREDENTIAL}`,
      });

      const formData = init.body as FormData;
      expect(formData).toBeInstanceOf(FormData);
      const metadataPart = formData.get('metadata') as File;
      const metadata = JSON.parse(await metadataPart.text());
      expect(metadata).toEqual({
        main_module: 'index.js',
        compatibility_date: '2026-09-01',
        bindings: [
          {
            type: 'plain_text',
            name: 'VOID_EMAIL_GATEWAY_ORIGIN',
            text: 'https://gateway.example.test',
          },
          { type: 'plain_text', name: 'VOID_EMAIL_ACCOUNT', text: ACCOUNT },
          { type: 'plain_text', name: 'VOID_EMAIL_ZONE', text: ZONE },
          { type: 'plain_text', name: 'VOID_EMAIL_INGRESS', text: RELAY },
        ],
      });
      const modulePart = formData.get('index.js') as File;
      expect(modulePart.name).toBe('index.js');
      expect(await modulePart.text()).toBe('export default {};\n');
    });
  });

  describe('putRelaySecret', () => {
    it('PUTs { name: VOID_RELAY_SECRET, text, type: secret_text } to .../secrets', async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess({}));
      const client = createCfCustomerClient(CREDENTIAL);

      await client.putRelaySecret(ACCOUNT, RELAY, 'relay-secret-dummy');

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(
        `${CF_CUSTOMER_API_BASE}/accounts/${ACCOUNT}/workers/scripts/${RELAY}/secrets`,
      );
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body as string)).toEqual({
        name: 'VOID_RELAY_SECRET',
        text: 'relay-secret-dummy',
        type: 'secret_text',
      });
    });
  });

  describe('catch-all rules', () => {
    it('setCatchAll PUTs the all-matcher + one worker action naming the relay, enabled', async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess({}));
      const client = createCfCustomerClient(CREDENTIAL);

      await client.setCatchAll(ZONE, RELAY);

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/zones/${ZONE}/email/routing/rules/catch_all`);
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body as string)).toEqual({
        matchers: [{ type: 'all' }],
        actions: [{ type: 'worker', value: [RELAY] }],
        enabled: true,
      });
    });

    it("resetCatchAll PUTs wrangler's reset shape: one drop action, disabled", async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess({}));
      const client = createCfCustomerClient(CREDENTIAL);

      await client.resetCatchAll(ZONE);

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/zones/${ZONE}/email/routing/rules/catch_all`);
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body as string)).toEqual({
        matchers: [{ type: 'all' }],
        actions: [{ type: 'drop' }],
        enabled: false,
      });
    });
  });

  describe('getCatchAll', () => {
    it('returns the enabled flag and the worker target of the first action', async () => {
      fetchMock.mockResolvedValueOnce(
        cfSuccess({
          enabled: true,
          matchers: [{ type: 'all' }],
          actions: [{ type: 'worker', value: [RELAY] }],
        }),
      );
      const client = createCfCustomerClient(CREDENTIAL);

      const result = await client.getCatchAll(ZONE);

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/zones/${ZONE}/email/routing/rules/catch_all`);
      expect(init.method).toBeUndefined();
      expect(result).toEqual({ enabled: true, workerName: RELAY });
    });

    it('returns workerName null for a non-worker action shape', async () => {
      fetchMock.mockResolvedValueOnce(
        cfSuccess({
          enabled: true,
          matchers: [{ type: 'all' }],
          actions: [{ type: 'forward', value: ['dest@example.net'] }],
        }),
      );
      const client = createCfCustomerClient(CREDENTIAL);

      await expect(client.getCatchAll(ZONE)).resolves.toEqual({
        enabled: true,
        workerName: null,
      });
    });

    it('maps a 404 to null (no rule configured)', async () => {
      fetchMock.mockResolvedValueOnce(cfError('rule not found', 404));
      const client = createCfCustomerClient(CREDENTIAL);

      await expect(client.getCatchAll(ZONE)).resolves.toBeNull();
    });

    it('rethrows a non-404 failure', async () => {
      fetchMock.mockResolvedValueOnce(cfError('forbidden', 403));
      const client = createCfCustomerClient(CREDENTIAL);

      const error = await client.getCatchAll(ZONE).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(CloudflareApiError);
      expect((error as CloudflareApiError).status).toBe(403);
    });
  });

  describe('getRoutingSettings', () => {
    it('GETs /zones/{z}/email/routing and returns the raw result', async () => {
      const settings = { id: ZONE, name: 'acme.com', enabled: true, status: 'ready' };
      fetchMock.mockResolvedValueOnce(cfSuccess(settings));
      const client = createCfCustomerClient(CREDENTIAL);

      const result = await client.getRoutingSettings(ZONE);

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/zones/${ZONE}/email/routing`);
      expect(init.method).toBeUndefined();
      expect(result).toEqual(settings);
    });
  });

  describe('relayScriptExists', () => {
    it('is false on 404 and true on 200, without parsing an envelope', async () => {
      fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));
      fetchMock.mockResolvedValueOnce(new Response('export default {};', { status: 200 }));
      const client = createCfCustomerClient(CREDENTIAL);

      await expect(client.relayScriptExists(ACCOUNT, RELAY)).resolves.toBe(false);
      await expect(client.relayScriptExists(ACCOUNT, RELAY)).resolves.toBe(true);

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/accounts/${ACCOUNT}/workers/scripts/${RELAY}`);
      expect(init.method).toBeUndefined();
      expect(init.headers).toEqual({ Authorization: `Bearer ${CREDENTIAL}` });
    });

    it('throws CloudflareApiError on other statuses', async () => {
      fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
      const client = createCfCustomerClient(CREDENTIAL);

      const error = await client.relayScriptExists(ACCOUNT, RELAY).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(CloudflareApiError);
      expect((error as CloudflareApiError).status).toBe(403);
    });
  });

  describe('deleteRelayScript', () => {
    it('DELETEs the script and tolerates a 404 (customer deleted it first)', async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess({}));
      fetchMock.mockResolvedValueOnce(cfError('not found', 404));
      const client = createCfCustomerClient(CREDENTIAL);

      await client.deleteRelayScript(ACCOUNT, RELAY);
      await client.deleteRelayScript(ACCOUNT, RELAY);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/accounts/${ACCOUNT}/workers/scripts/${RELAY}`);
      expect(init.method).toBe('DELETE');
    });

    it('throws on other envelope failures', async () => {
      fetchMock.mockResolvedValueOnce(cfError('boom', 500));
      const client = createCfCustomerClient(CREDENTIAL);

      await expect(client.deleteRelayScript(ACCOUNT, RELAY)).rejects.toThrow('boom');
    });
  });
  describe('owned literal recipient rules', () => {
    const wire = {
      id: 'rule-1',
      name: 'owned-name',
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: 'project@mail.example.com' }],
      actions: [{ type: 'worker', value: ['gateway'] }],
    };
    it('PATCHes only the per-zone subaddress flag', async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess({ support_subaddress: true }));
      await createCfCustomerClient(CREDENTIAL).enableSubaddressing(ZONE);
      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(CF_CUSTOMER_API_BASE + '/zones/' + ZONE + '/email/routing');
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body as string)).toEqual({ support_subaddress: true });
    });
    it.each([null, 'rule-1'])(
      'creates or updates one exact literal rule without a catch-all: %s',
      async (id) => {
        fetchMock.mockResolvedValueOnce(cfSuccess(wire));
        const rule = await createCfCustomerClient(CREDENTIAL).putLiteralRule(ZONE, id, {
          name: wire.name,
          address: 'project@mail.example.com',
          workerName: 'gateway',
        });
        expect(rule).toMatchObject({
          id: wire.id,
          name: wire.name,
          literalWorker: true,
          workerName: 'gateway',
          addresses: ['project@mail.example.com'],
        });
        const { url, init } = lastCall(fetchMock);
        expect(url).toBe(
          CF_CUSTOMER_API_BASE + '/zones/' + ZONE + '/email/routing/rules' + (id ? '/' + id : ''),
        );
        expect(init.method).toBe(id ? 'PUT' : 'POST');
        expect(JSON.parse(init.body as string)).toEqual({
          name: wire.name,
          enabled: true,
          matchers: wire.matchers,
          actions: wire.actions,
        });
      },
    );
    it.each([
      { matchers: [{ type: 'all' }] },
      { matchers: [...wire.matchers, ...wire.matchers] },
      { actions: [{ type: 'worker', value: ['gateway', 'foreign'] }] },
      { actions: [{ type: 'forward', value: ['foreign@example.com'] }] },
    ])(
      'does not claim malformed or broader provider rules as a literal Worker rule',
      async (change) => {
        fetchMock.mockResolvedValueOnce(cfSuccess({ ...wire, ...change }));
        expect(
          await createCfCustomerClient(CREDENTIAL).getRoutingRule(ZONE, 'rule-1'),
        ).toMatchObject({ literalWorker: false });
      },
    );
    it('treats exact GET/DELETE 404 as absent, and preserves permission errors', async () => {
      fetchMock
        .mockResolvedValueOnce(cfError('not found', 404))
        .mockResolvedValueOnce(cfError('not found', 404))
        .mockResolvedValueOnce(cfError('denied', 403));
      const client = createCfCustomerClient(CREDENTIAL);
      expect(await client.getRoutingRule(ZONE, 'rule-1')).toBeNull();
      await expect(client.deleteRoutingRule(ZONE, 'rule-1')).resolves.toBeUndefined();
      await expect(client.deleteRoutingRule(ZONE, 'rule-1')).rejects.toMatchObject({ status: 403 });
    });
  });
});
