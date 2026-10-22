import { vi } from 'vite-plus/test';
import { cfError, cfSuccess } from './helpers.ts';

// ---------------------------------------------------------------------------
// Customer-side Cloudflare and DNS fetch stub
// ---------------------------------------------------------------------------

export type StubFailTag =
  | 'verifyToken'
  | 'zones'
  | 'mxLookup'
  | 'routingDns'
  | 'onboardSending'
  | 'sendingPreview'
  | 'sendingSubdomainsGet'
  | 'scriptGet'
  | 'scriptPut'
  | 'workersSubdomain'
  | 'scriptSubdomain'
  | 'relayProbe'
  | 'gatewayProbe'
  | 'secretPut'
  | 'catchAll'
  | 'catchAllGet'
  | 'routingRulesGet'
  | 'routingSettingsGet'
  | 'subaddressing'
  | 'literalRuleCreate'
  | 'literalRuleUpdate'
  | 'literalRuleGet'
  | 'literalRuleDelete'
  | 'scriptDelete';

export type RecordedCall = {
  tag: StubFailTag;
  method: string;
  url: string;
  /** Parsed JSON body for string bodies; parsed metadata for the script PUT. */
  body?: unknown;
  /** Secrets PUT shape: name/type/text shape — never the text itself. */
  secret?: { name: string; type: string; textShape: string };
};

export function stubCustomerCf(
  config: {
    zones?: Record<string, { id: string; name: string; accountId: string }>;
    verifyStatus?: string;
    verifyExpiresOn?: string | null;
    mx?: Record<string, Array<string>>;
    dnsStatus?: number;
    existingScripts?: ReadonlyArray<string>;
    /**
     * Initial catch-all state, applied to every zone. Absent → CF's real
     * default for a zone that never had a rule written: a DISABLED drop
     * rule (live probes). `null` → no rule at all (CF 404). GET/PUT then
     * keep mutating the per-zone state.
     */
    catchAllRule?: { enabled: boolean; workerName: string | null } | null;
    /** GET email/routing's result; default { enabled: true }. */
    routingSettings?: Record<string, unknown>;
    routingRules?: Array<{
      enabled: boolean;
      addresses: Array<string>;
      id?: string;
      name?: string;
      workerName?: string;
    }>;
    /** GET sending/subdomains entries; default []. */
    sendingSubdomains?: ReadonlyArray<{ name: string; enabled: boolean }>;
    /** POST sending/subdomains/preview `errors`; default []. */
    sendingPreviewErrors?: ReadonlyArray<{ code: string; existing?: { name: string } }>;
    failOn?: Partial<Record<StubFailTag, { message: string; status: number; code?: number }>>;
    /** Tags whose configured failure is returned before the provider-side mutation occurs. */
    failBeforeEffect?: ReadonlyArray<StubFailTag>;
    /** Side-effect hook fired right after a call is recorded (mid-request seams). */
    on?: Partial<Record<StubFailTag, () => void | Promise<void>>>;
  } = {},
) {
  const calls: Array<RecordedCall> = [];
  const publishedMx = new Map<string, Array<string>>();
  const fail = (tag: StubFailTag): Response | null => {
    const failure = config.failOn?.[tag];
    return failure ? cfError(failure.message, failure.status, failure.code) : null;
  };
  const record = async (call: RecordedCall): Promise<void> => {
    calls.push(call);
    await config.on?.[call.tag]?.();
  };

  // Per-zone catch-all rule state, lazily seeded from the config.
  const catchAllStates = new Map<string, { enabled: boolean; workerName: string | null } | null>();
  // Per-script sha256 of the last secret PUT text (never the text).
  const secretHashes = new Map<string, string>();
  const relaySecrets = new Map<string, string>();
  const scriptSubdomains = new Map<string, boolean>();
  const routingSettingsStates = new Map<string, Record<string, unknown>>();
  const routingRuleStates = new Map<string, Map<string, Record<string, unknown>>>();
  const rulesFor = (zoneId: string) => {
    if (!routingRuleStates.has(zoneId)) {
      routingRuleStates.set(zoneId, new Map());
    }
    // Seeds configured rules on first access; status tests may also add a
    // foreign rule after setup to model drift.
    for (const [index, rule] of (config.routingRules ?? []).entries()) {
      const id = rule.id ?? `foreign-rule-${index}`;
      if (!routingRuleStates.get(zoneId)!.has(id)) {
        routingRuleStates.get(zoneId)!.set(id, {
          id,
          name: rule.name ?? null,
          enabled: rule.enabled,
          matchers: rule.addresses.map((value) => ({ type: 'literal', field: 'to', value })),
          actions: [{ type: 'worker', value: [rule.workerName ?? 'foreign-ingress'] }],
        });
      }
    }
    return routingRuleStates.get(zoneId)!;
  };
  const settingsFor = (zoneId: string) => {
    if (!routingSettingsStates.has(zoneId)) {
      routingSettingsStates.set(zoneId, {
        enabled: true,
        support_subaddress: false,
        ...config.routingSettings,
      });
    }
    return routingSettingsStates.get(zoneId)!;
  };
  const catchAllStateFor = (zoneId: string) => {
    if (!catchAllStates.has(zoneId)) {
      catchAllStates.set(
        zoneId,
        config.catchAllRule === undefined || config.catchAllRule === null
          ? config.catchAllRule === null
            ? null
            : { enabled: false, workerName: null }
          : { ...config.catchAllRule },
      );
    }
    return catchAllStates.get(zoneId)!;
  };

  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';

    if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
      await record({ tag: 'mxLookup', method, url });
      const failure = fail('mxLookup');
      if (failure) {
        return failure;
      }
      const name = new URL(url).searchParams.get('name') ?? '';
      const exchanges = config.mx?.[name] ?? publishedMx.get(name) ?? [];
      return Response.json({
        Status: config.dnsStatus ?? 0,
        Answer: exchanges.map((exchange) => ({ type: 15, data: `10 ${exchange}.` })),
      });
    }

    if (url.endsWith('.workers.dev/__void/email/probe')) {
      await record({ tag: 'relayProbe', method, url });
      const failure = fail('relayProbe');
      if (failure) {
        return failure;
      }
      const name = new URL(url).hostname.split('.')[0]!;
      const secret = relaySecrets.get(name);
      if (!secret || !scriptSubdomains.get(name)) {
        return new Response(null, { status: 404 });
      }
      const challenge = new Headers(init?.headers).get('X-Void-Probe-Challenge') ?? '';
      const generation = Number(new Headers(init?.headers).get('X-Void-Probe-Generation'));
      const metadata = [...calls]
        .reverse()
        .find((call) => call.tag === 'scriptPut' && call.url.includes(`/scripts/${name}`))?.body as
        | { bindings?: Array<{ name: string; text: string }> }
        | undefined;
      const binding = (name: string) =>
        metadata?.bindings?.find((row) => row.name === name)?.text ?? '';
      const accountId = binding('VOID_EMAIL_ACCOUNT'),
        zoneId = binding('VOID_EMAIL_ZONE'),
        ingressName = binding('VOID_EMAIL_INGRESS');
      const data = [
        'email-relay-proof-v1',
        accountId,
        zoneId,
        ingressName,
        String(generation),
        challenge,
      ].join('\n');
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const proof = Array.from(
        new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('');
      return Response.json({ accountId, zoneId, ingressName, generation, challenge, proof });
    }

    if (url === 'https://email-gateway.example.test/email/probe') {
      await record({ tag: 'gatewayProbe', method, url });
      const failure = fail('gatewayProbe');
      if (failure) {
        return failure;
      }
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as { ingressName?: string }) : {};
      const bearer = new Headers(init?.headers).get('Authorization')?.replace(/^Bearer /, '');
      if (
        !bearer ||
        (relaySecrets.has(body.ingressName ?? '') &&
          relaySecrets.get(body.ingressName ?? '') !== bearer)
      ) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204 });
    }

    if (!url.startsWith('https://api.cloudflare.com/client/v4/')) {
      throw new Error(`Unmocked fetch: ${method} ${url}`);
    }
    const path = url.slice('https://api.cloudflare.com/client/v4'.length);

    if (/\/accounts\/[^/]+\/workers\/subdomain$/.test(path) && method === 'GET') {
      await record({ tag: 'workersSubdomain', method, url });
      return fail('workersSubdomain') ?? cfSuccess({ subdomain: 'customer' });
    }
    const scriptSubdomainMatch = /\/accounts\/[^/]+\/workers\/scripts\/([^/]+)\/subdomain$/.exec(
      path,
    );
    if (scriptSubdomainMatch) {
      await record({ tag: 'scriptSubdomain', method, url });
      const failure = fail('scriptSubdomain');
      if (failure) {
        return failure;
      }
      if (method === 'POST') {
        scriptSubdomains.set(scriptSubdomainMatch[1]!, true);
        return cfSuccess({ enabled: true, previews_enabled: false });
      }
      return cfSuccess({
        enabled: scriptSubdomains.get(scriptSubdomainMatch[1]!) ?? false,
        previews_enabled: false,
      });
    }

    if (path === '/user/tokens/verify') {
      await record({ tag: 'verifyToken', method, url });
      const failure = fail('verifyToken');
      if (failure) {
        return failure;
      }
      return cfSuccess({
        id: 'tok_dummy',
        status: config.verifyStatus ?? 'active',
        expires_on: config.verifyExpiresOn ?? null,
      });
    }

    if (path.startsWith('/zones?')) {
      await record({ tag: 'zones', method, url });
      const failure = fail('zones');
      if (failure) {
        return failure;
      }
      const name = new URL(url).searchParams.get('name') ?? '';
      const zone = config.zones?.[name];
      return cfSuccess(
        zone ? [{ id: zone.id, name: zone.name, account: { id: zone.accountId } }] : [],
      );
    }

    if (path.includes('/email/routing/dns') && method === 'POST') {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      await record({ tag: 'routingDns', method, url, body });
      const failure = fail('routingDns');
      if (failure) {
        return failure;
      }
      const zoneId = path.split('/')[2];
      const name =
        body?.name ?? Object.values(config.zones ?? {}).find((zone) => zone.id === zoneId)?.name;
      if (name) {
        publishedMx.set(name, ['route1.mx.cloudflare.net']);
      }
      return cfSuccess({});
    }

    if (path.endsWith('/email/sending/subdomains/preview') && method === 'POST') {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      await record({ tag: 'sendingPreview', method, url, body });
      return fail('sendingPreview') ?? cfSuccess({ errors: config.sendingPreviewErrors ?? [] });
    }

    if (path.includes('/email/sending/subdomains') && method === 'POST') {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      await record({ tag: 'onboardSending', method, url, body });
      return fail('onboardSending') ?? cfSuccess({});
    }

    if (path.includes('/email/sending/subdomains') && method === 'GET') {
      await record({ tag: 'sendingSubdomainsGet', method, url });
      const failure = fail('sendingSubdomainsGet');
      if (failure) {
        return failure;
      }
      return cfSuccess(config.sendingSubdomains ?? []);
    }

    // The settings GET is anchored at the exact path — /email/routing/dns
    // and /email/routing/rules/... must not match it.
    if (/\/zones\/[^/]+\/email\/routing$/.test(path) && method === 'GET') {
      await record({ tag: 'routingSettingsGet', method, url });
      const failure = fail('routingSettingsGet');
      if (failure) {
        return failure;
      }
      return cfSuccess(settingsFor(path.split('/')[2]!));
    }

    if (/\/zones\/[^/]+\/email\/routing$/.test(path) && method === 'PATCH') {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      await record({ tag: 'subaddressing', method, url, body });
      if (config.failBeforeEffect?.includes('subaddressing')) {
        return fail('subaddressing') ?? cfSuccess({});
      }
      Object.assign(settingsFor(path.split('/')[2]!), body);
      return fail('subaddressing') ?? cfSuccess(settingsFor(path.split('/')[2]!));
    }

    if (/\/zones\/[^/]+\/email\/routing\/rules\?/.test(path) && method === 'GET') {
      await record({ tag: 'routingRulesGet', method, url });
      const params = new URL(url).searchParams;
      const page = Number(params.get('page') ?? 1),
        perPage = Number(params.get('per_page') ?? 50);
      return (
        fail('routingRulesGet') ??
        cfSuccess(
          [...rulesFor(path.split('/')[2]!).values()].slice((page - 1) * perPage, page * perPage),
        )
      );
    }

    const literal = /^\/zones\/([^/]+)\/email\/routing\/rules(?:\/([^/?]+))?$/.exec(path);
    if (literal && literal[2] !== 'catch_all') {
      const rules = rulesFor(literal[1]!);
      if (method === 'GET' && literal[2]) {
        await record({ tag: 'literalRuleGet', method, url });
        return (
          fail('literalRuleGet') ??
          (rules.has(literal[2]) ? cfSuccess(rules.get(literal[2])) : cfError('not found', 404))
        );
      }
      if (method === 'POST' || method === 'PUT') {
        const tag = method === 'POST' ? 'literalRuleCreate' : 'literalRuleUpdate';
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        await record({ tag, method, url, body });
        if (config.failBeforeEffect?.includes(tag)) {
          return fail(tag) ?? cfSuccess({});
        }
        const id = literal[2] ?? `owned-rule-${rules.size + 1}`;
        rules.set(id, { ...body, id });
        return fail(tag) ?? cfSuccess(rules.get(id));
      }
      if (method === 'DELETE' && literal[2]) {
        await record({ tag: 'literalRuleDelete', method, url });
        if (config.failBeforeEffect?.includes('literalRuleDelete')) {
          return fail('literalRuleDelete') ?? cfSuccess({});
        }
        rules.delete(literal[2]);
        return fail('literalRuleDelete') ?? cfSuccess({});
      }
    }

    const catchAllMatch = /\/zones\/([^/]+)\/email\/routing\/rules\/catch_all$/.exec(path);
    if (catchAllMatch && method === 'GET') {
      await record({ tag: 'catchAllGet', method, url });
      const failure = fail('catchAllGet');
      if (failure) {
        return failure;
      }
      const state = catchAllStateFor(catchAllMatch[1]!);
      if (state === null) {
        return cfError('rule not found', 404);
      }
      return cfSuccess({
        enabled: state.enabled,
        matchers: [{ type: 'all' }],
        actions:
          state.workerName === null
            ? [{ type: 'drop', value: [] }]
            : [{ type: 'worker', value: [state.workerName] }],
      });
    }

    if (catchAllMatch && method === 'PUT') {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      await record({ tag: 'catchAll', method, url, body });
      const failure = fail('catchAll');
      if (failure) {
        return failure;
      }
      // The write mutates the zone's rule: a worker action names the worker,
      // anything else (the reset's drop) is a disabled non-worker rule.
      const actions = (body as { actions?: Array<{ type: string; value?: Array<string> }> })
        ?.actions;
      const worker = actions?.find((action) => action.type === 'worker');
      catchAllStates.set(catchAllMatch[1]!, {
        enabled: Boolean((body as { enabled?: unknown })?.enabled),
        workerName: worker?.value?.[0] ?? null,
      });
      return cfSuccess({});
    }

    const secretsMatch = /\/workers\/scripts\/([^/]+)\/secrets$/.exec(path);
    if (secretsMatch && method === 'PUT') {
      const parsed = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const text = typeof parsed.text === 'string' ? parsed.text : '';
      await record({
        tag: 'secretPut',
        method,
        url,
        secret: {
          name: String(parsed.name),
          type: String(parsed.type),
          // Shape, never the value: length class + alphabet.
          textShape: `len=${text.length} ${/^[A-Za-z0-9_-]+$/.test(text) ? 'base64url' : 'other'}`,
        },
      });
      if (config.failBeforeEffect?.includes('secretPut')) {
        return fail('secretPut') ?? cfSuccess({});
      }
      // The worker's CURRENT secret, tracked by sha256 only — the same
      // form the ROUTING mirror stores — so a test can prove worker, row
      // and mirror carry ONE secret without the value ever being recorded.
      secretHashes.set(secretsMatch[1]!, await sha256Hex(text));
      relaySecrets.set(secretsMatch[1]!, text);
      return fail('secretPut') ?? cfSuccess({});
    }

    const scriptMatch = /\/accounts\/[^/]+\/workers\/scripts\/([^/?#]+)$/.exec(path);
    if (scriptMatch && method === 'GET') {
      await record({ tag: 'scriptGet', method, url });
      const failure = fail('scriptGet');
      if (failure) {
        return failure;
      }
      if (config.existingScripts?.includes(scriptMatch[1]!)) {
        // The raw script GET answers source bytes, not a v4 envelope.
        return new Response('export default {}', { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }
    if (scriptMatch && method === 'PUT') {
      let metadata: unknown;
      if (init?.body instanceof FormData) {
        const metaEntry = init.body.get('metadata');
        if (metaEntry instanceof Blob) {
          metadata = JSON.parse(await metaEntry.text());
        }
      }
      await record({ tag: 'scriptPut', method, url, body: metadata });
      return fail('scriptPut') ?? cfSuccess({});
    }
    if (scriptMatch && method === 'DELETE') {
      await record({ tag: 'scriptDelete', method, url });
      return fail('scriptDelete') ?? cfSuccess({});
    }

    // Project teardown also deletes deployment Workers in the platform's
    // dispatch namespace. These email tests never create one.
    if (
      method === 'DELETE' &&
      /\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+$/.test(path)
    ) {
      return new Response(null, { status: 404 });
    }

    throw new Error(`Unmocked customer fetch: ${method} ${url}`);
  });

  vi.stubGlobal('fetch', fn);
  return { calls, fn, catchAllStates, secretHashes, routingRuleStates, routingSettingsStates };
}

export function callsByTag(calls: Array<RecordedCall>, tag: StubFailTag): Array<RecordedCall> {
  return calls.filter((call) => call.tag === tag);
}

async function sha256Hex(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
