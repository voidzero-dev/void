import type { CloudflareOperation } from '@void/deploy-cloudflare';
import { describe, expect, it } from 'vite-plus/test';
import {
  applyEmailSetup,
  deriveAddresses,
  emailFromDomain,
  fetchWithSessionBearer,
  findEmailConfigConflicts,
  formatSendingOnlyPaidHint,
  isAwaitingSendingOnboarding,
  readRoutingRules,
  readRoutingSettings,
  readSendingSettings,
  parseWhoamiJson,
  preflightEmail,
  renderAddressMap,
  renderEmailChecklist,
  subdomainDashboardFallback,
  SENDING_FREE_PLAN_HINT,
  type EmailCloudflareInputs,
  type EmailDns,
  type EmailPreflight,
  type EmailWranglerRunResult,
} from '../../src/cli/email-cloudflare.ts';
import type { EmailHandlersScan } from '../../src/router/email.ts';
import { compileEmailPattern } from '../../src/shared/email-pattern.ts';

// ── Structured command fakes ───────────────────────────────────────────────────

function whoamiResult(): EmailWranglerRunResult {
  return {
    status: 0,
    stdout: '',
    data: {
      loggedIn: true,
      authType: 'OAuth Token',
      email: 'dev@example.com',
      accounts: [{ id: ACCOUNT, name: 'Acme' }],
      tokenPermissions: ['account:read', 'email_routing:write', 'email_sending:write'],
    },
    stderr: '',
  };
}

const emptyRules = [{ enabled: false, matchers: [{ type: 'all' }], actions: [{ type: 'drop' }] }];

function routingRules(
  options: {
    supportDomain?: string;
    salesDomain?: string;
    supportEnabled?: boolean;
    supportAction?: { type: string; value?: string | Array<string> };
    catchAllWorker?: string;
    extra?: Array<unknown>;
  } = {},
): Array<unknown> {
  return [
    {
      id: '1a2b3c',
      name: 'support',
      enabled: options.supportEnabled ?? true,
      matchers: [
        { type: 'literal', field: 'to', value: 'support@' + (options.supportDomain ?? 'acme.com') },
      ],
      actions: [options.supportAction ?? { type: 'worker', value: ['acme-support'] }],
    },
    {
      id: '4d5e6f',
      name: '(none)',
      enabled: true,
      matchers: [
        { type: 'literal', field: 'to', value: 'sales@' + (options.salesDomain ?? 'acme.com') },
      ],
      actions: [{ type: 'forward', value: ['sales@gmail.com'] }],
    },
    ...(options.extra ?? []),
    {
      enabled: true,
      matchers: [{ type: 'all' }],
      actions: [{ type: 'worker', value: [options.catchAllWorker ?? 'acme-support'] }],
    },
  ];
}

const BETA_WARNING =
  '\u001b[33m▲ \u001b[43;33m[\u001b[43;30mWARNING\u001b[43;33m]\u001b[0m \u001b[1m🚧 `wrangler email x` is an open beta command.\u001b[0m\n';

function routingSettings(
  name: string,
  enabled: boolean,
  status: string,
  tag: string,
): EmailWranglerRunResult {
  return {
    status: 0,
    stdout: '',
    data: { name, enabled: enabled, status, tag: tag },
    stderr: BETA_WARNING,
  };
}

function zoneNotFound(_name: string): EmailWranglerRunResult {
  return { status: 0, stdout: '', stderr: '', data: null };
}

function sendingNotFound(_name: string): EmailWranglerRunResult {
  return { status: 0, stdout: '', stderr: '', data: null };
}

function apiFailure(code: number, resource: string): EmailWranglerRunResult {
  return { status: 1, stdout: '', stderr: `Provider failure: ${resource}`, errorCode: code };
}

// ── Scan builders ────────────────────────────────────────────────────────────────

function scan(files: Array<string>, defaultHandler?: string): EmailHandlersScan {
  return {
    addresses: files.map((filePath) => {
      const basename = filePath.replace(/\.[^.]+$/, '');
      return { address: basename.toLowerCase(), filePath, pattern: compileEmailPattern(basename)! };
    }),
    defaultHandler,
  };
}

// ── Fake seams ───────────────────────────────────────────────────────────────────

const ZONE_ID = '5b66f5cb84fd7dcfdd0170515e622181';
const ACCOUNT = 'f721b8e5f721b8e5f721b8e5f721b8e5';
const BEARER = 'cfoa-SECRET-BEARER-TOKEN-0123456789';

type Call = { args: Array<string>; operation: CloudflareOperation; capture: boolean };

function operationWords(operation: CloudflareOperation): Array<string> {
  if (operation.type === 'auth.whoami') {
    return ['whoami', '--json'];
  }
  if (operation.type === 'auth.token') {
    return ['auth', 'token', '--json'];
  }
  if ('domain' in operation) {
    return [...operation.type.split('.'), operation.domain];
  }
  throw new Error(`Unexpected operation: ${operation.type}`);
}
type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

function fakeDns(overrides: {
  mx?: Record<string, Array<string>>;
  txt?: Record<string, Array<string>>;
  mxError?: Record<string, string>;
}): EmailDns {
  const noData = (): Error => Object.assign(new Error('queryMx ENODATA'), { code: 'ENODATA' });
  return {
    resolveMx: async (name) => {
      if (overrides.mxError?.[name]) {
        throw Object.assign(new Error(overrides.mxError[name]), { code: overrides.mxError[name] });
      }
      const list = overrides.mx?.[name];
      if (!list || list.length === 0) {
        throw noData();
      }
      return list.map((exchange, i) => ({ exchange, priority: (i + 1) * 10 }));
    },
    resolveTxt: async (name) => {
      const list = overrides.txt?.[name];
      if (!list || list.length === 0) {
        throw noData();
      }
      return list.map((v) => [v]);
    },
  };
}

function fakeRunner(
  table: Record<string, EmailWranglerRunResult | (() => EmailWranglerRunResult)>,
  calls: Array<Call>,
): EmailCloudflareInputs['runWrangler'] {
  return (operation, opts) => {
    const args = operationWords(operation);
    calls.push({ args, operation, capture: opts.capture });
    const key = args.join(' ');
    const hit = table[key];
    if (!hit) {
      throw new Error(`unexpected wrangler call: ${key}`);
    }
    return typeof hit === 'function' ? hit() : hit;
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(
  table: Record<string, (call: FetchCall) => Response | Promise<Response>>,
  calls: Array<FetchCall>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k] = v;
    }
    const call: FetchCall = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    // Key on the API path after the base (`/client/v4`), so the table reads like the docs.
    const key = `${call.method} ${url.slice(url.indexOf('/zones'))}`;
    const hit = table[key];
    if (!hit) {
      throw new Error(`unexpected fetch: ${key}`);
    }
    return hit(call);
  }) as typeof fetch;
}

function zonesOk(name: string, extra: Partial<{ type: string; account: string }> = {}) {
  return () =>
    jsonResponse(200, {
      success: true,
      result: [
        {
          id: ZONE_ID,
          name,
          type: extra.type ?? 'full',
          account: { id: extra.account ?? ACCOUNT },
        },
      ],
    });
}

function routingGet(supportSubaddress: boolean) {
  return () =>
    jsonResponse(200, {
      success: true,
      result: { enabled: true, support_subaddress: supportSubaddress },
    });
}

/**
 * The sample scenario: `email/support+[ticket].ts` + `email/_default.ts`,
 * `email.from = noreply@mail.acme.com`, zone `acme.com` (routing ready on the apex,
 * Google MX there), nothing yet on `mail.acme.com`.
 */
function transcriptInputs(
  overrides: Partial<EmailCloudflareInputs> & {
    runnerTable?: Record<string, EmailWranglerRunResult | (() => EmailWranglerRunResult)>;
    fetchTable?: Record<string, (call: FetchCall) => Response | Promise<Response>>;
    calls?: Array<Call>;
    fetchCalls?: Array<FetchCall>;
    dns?: EmailDns;
  } = {},
): { inputs: EmailCloudflareInputs; calls: Array<Call>; fetchCalls: Array<FetchCall> } {
  const calls = overrides.calls ?? [];
  const fetchCalls = overrides.fetchCalls ?? [];
  const whoami = whoamiResult();
  const runnerTable = {
    'whoami --json': whoami,
    'email routing settings mail.acme.com': zoneNotFound('mail.acme.com'),
    'email routing settings acme.com': routingSettings('acme.com', true, 'ready', ZONE_ID),
    'email routing rules list acme.com': { status: 0, stdout: '', data: emptyRules, stderr: '' },
    'email sending settings mail.acme.com': sendingNotFound('mail.acme.com'),
    ...overrides.runnerTable,
  };
  const fetchTable = {
    'GET /zones?name=acme.com': zonesOk('acme.com'),
    [`GET /zones/${ZONE_ID}/email/routing`]: routingGet(false),
    ...overrides.fetchTable,
  };
  const rest: Partial<EmailCloudflareInputs> = { ...overrides };
  delete (rest as Record<string, unknown>).runnerTable;
  delete (rest as Record<string, unknown>).fetchTable;
  delete (rest as Record<string, unknown>).calls;
  delete (rest as Record<string, unknown>).fetchCalls;
  const inputs: EmailCloudflareInputs = {
    handlers: scan(['support+[ticket].ts'], '_default.ts'),
    from: 'noreply@mail.acme.com',
    workerName: 'acme-support',
    accountId: ACCOUNT,
    runWrangler: fakeRunner(runnerTable, calls),
    getSessionBearer: async () => BEARER,
    fetchImpl: fakeFetch(fetchTable, fetchCalls),
    dns: fakeDns({ mx: { 'acme.com': ['aspmx.l.google.com', 'alt1.aspmx.l.google.com'] } }),
    ...rest,
  };
  return { inputs, calls, fetchCalls };
}

/** The "second deploy" account state, with the committed config overridable per case. */
function readyAccount(
  overrides: Partial<EmailCloudflareInputs> & {
    runnerTable?: Record<string, EmailWranglerRunResult | (() => EmailWranglerRunResult)>;
    calls?: Array<Call>;
    fetchCalls?: Array<FetchCall>;
    rules?: Array<unknown>;
  } = {},
) {
  const { rules, runnerTable, ...rest } = overrides;
  return transcriptInputs({
    runnerTable: {
      'email routing rules list acme.com': {
        status: 0,
        stdout: '',
        data: rules ?? routingRules({ supportDomain: 'mail.acme.com' }),
        stderr: BETA_WARNING,
      },
      'email sending settings mail.acme.com': {
        status: 0,
        stdout: '',
        data: {
          name: 'mail.acme.com',
          enabled: true,
          tag: '19af4fdbee924a92916afea0de5a8fdd',
        },
        stderr: BETA_WARNING,
      },
      ...runnerTable,
    },
    fetchTable: { [`GET /zones/${ZONE_ID}/email/routing`]: routingGet(true) },
    dns: fakeDns({
      mx: {
        'acme.com': ['aspmx.l.google.com'],
        'mail.acme.com': ['route1.mx.cloudflare.net', 'route2.mx.cloudflare.net'],
      },
    }),
    handlers: scan(['support+[ticket].ts']),
    existingSendEmail: [{ name: 'SEND_EMAIL' }],
    existingAddresses: ['support@mail.acme.com'],
    existingVars: { __VOID_EMAIL_FROM: 'noreply@mail.acme.com' },
    ...rest,
  });
}

// ── Derivation ───────────────────────────────────────────────────────────────────

describe('deriveAddresses', () => {
  it('maps literal and literal+[tag] handlers to <literal>@<domain>', () => {
    const out = deriveAddresses(
      scan(['support+[ticket].ts', 'sales.ts', 'Support.ts']),
      'mail.acme.com',
      'subdomain',
    );
    expect(out.addresses).toEqual(['support@mail.acme.com', 'sales@mail.acme.com']);
    expect(out.refused).toEqual([]);
    expect(out.routes).toEqual([
      { address: 'support@mail.acme.com', handler: 'email/support+[ticket].ts' },
      { address: 'sales@mail.acme.com', handler: 'email/sales.ts' },
      { address: 'support@mail.acme.com', handler: 'email/Support.ts' },
    ]);
  });

  it('_default.ts becomes *@<apex> on the apex only', () => {
    const apex = deriveAddresses(scan(['support.ts'], '_default.ts'), 'acme.com', 'apex');
    expect(apex.addresses).toEqual(['support@acme.com', '*@acme.com']);
    expect(apex.refused).toEqual([]);

    const sub = deriveAddresses(scan(['support.ts'], '_default.ts'), 'mail.acme.com', 'subdomain');
    expect(sub.addresses).toEqual(['support@mail.acme.com']);
    expect(sub.refused).toEqual([
      {
        handler: 'email/_default.ts',
        reason: 'a catch-all exists only on an apex; other @mail.acme.com mail bounces',
      },
    ]);
  });

  it('[name].ts and [name]+[tag].ts need the catch-all: allowed on the apex, refused on a subdomain', () => {
    const apex = deriveAddresses(scan(['[name].ts', '[user]+[tag].ts']), 'acme.com', 'apex');
    expect(apex.addresses).toEqual(['*@acme.com']);
    expect(apex.refused).toEqual([]);

    const sub = deriveAddresses(
      scan(['[name].ts', '[user]+[tag].ts']),
      'mail.acme.com',
      'subdomain',
    );
    expect(sub.addresses).toEqual([]);
    expect(sub.refused.map((r) => r.handler)).toEqual(['email/[name].ts', 'email/[user]+[tag].ts']);
    for (const r of sub.refused) {
      expect(r.reason).toContain('catch-all');
      expect(r.reason).toContain('mail.acme.com');
    }
  });

  it('emits the catch-all once even when several handlers need it', () => {
    const out = deriveAddresses(scan(['[name].ts'], '_default.ts'), 'acme.com', 'apex');
    expect(out.addresses).toEqual(['*@acme.com']);
    expect(out.routes).toEqual([
      { address: '*@acme.com', handler: 'email/[name].ts' },
      { address: '*@acme.com', handler: 'email/_default.ts' },
    ]);
  });
});

describe('emailFromDomain', () => {
  it('extracts and lowercases the host', () => {
    expect(emailFromDomain('NoReply@Mail.Acme.com')).toBe('mail.acme.com');
    expect(emailFromDomain('bad')).toBeNull();
    expect(emailFromDomain('@acme.com')).toBeNull();
    expect(emailFromDomain('a@')).toBeNull();
    expect(emailFromDomain('a@localhost')).toBeNull();
  });

  it('validates per label: a leading `-` (a yargs flag), an empty label, a trailing `-` are refused', () => {
    // The host is handed to wrangler as a positional; `--config.evil` would be parsed as an
    // option and the domain positional would go missing.
    expect(emailFromDomain('a@--config.evil')).toBeNull();
    expect(emailFromDomain('a@-foo.evil')).toBeNull();
    expect(emailFromDomain('a@..acme.com')).toBeNull();
    expect(emailFromDomain('a@.acme.com')).toBeNull();
    expect(emailFromDomain('a@foo-.evil')).toBeNull();
    expect(emailFromDomain('a@acme.com.')).toBeNull();
    expect(emailFromDomain('a@my-mail.acme.com')).toBe('my-mail.acme.com');
  });

  it('reads the address inside a display-name form (the shape void.json accepts)', () => {
    expect(emailFromDomain('Acme Support <NoReply@Mail.Acme.com>')).toBe('mail.acme.com');
    expect(emailFromDomain('"Acme, Inc" <noreply@acme.com> ')).toBe('acme.com');
    expect(emailFromDomain('Acme <bad>')).toBeNull();
    expect(emailFromDomain('Acme <>')).toBeNull();
  });
});

describe('structured email results', () => {
  it('reads routing and sending settings', () => {
    const value = { name: 'acme.com', enabled: true, status: 'ready', tag: ZONE_ID };
    expect(readRoutingSettings(value)).toEqual(value);
    expect(readSendingSettings(value)).toEqual({
      name: 'acme.com',
      enabled: true,
      tag: ZONE_ID,
    });
    expect(readSendingSettings({ name: 'acme.com', enabled: false, id: ZONE_ID })).toEqual({
      name: 'acme.com',
      enabled: false,
      tag: ZONE_ID,
    });
  });

  it('reads empty rules and disabled catch-all', () => {
    expect(readRoutingRules([])).toEqual({ rules: [], catchAll: null });
    expect(readRoutingRules(emptyRules)).toEqual({
      rules: [],
      catchAll: { enabled: false, actions: ['drop'] },
    });
  });

  it.each(['acme-support', ['acme-support']].map((value) => ({ value })))(
    'reads Worker action values $value',
    ({ value }) => {
      const result = readRoutingRules(routingRules({ supportAction: { type: 'worker', value } }));
      expect(result?.rules[0]?.actions).toEqual(['worker:acme-support']);
      expect(result?.catchAll?.actions).toEqual(['worker:acme-support']);
    },
  );

  it('does not claim ownership of a multi-Worker action', () => {
    const result = readRoutingRules(
      routingRules({ supportAction: { type: 'worker', value: ['acme-support', 'other-worker'] } }),
    );
    expect(result?.rules[0]?.actions).toEqual(['worker:acme-support,other-worker']);
    expect(result?.rules[0]?.actions).not.toContain('worker:acme-support');
  });

  it.each(
    [
      null,
      {},
      [{ enabled: 'false', matchers: [{ type: 'all' }], actions: [{ type: 'drop' }] }],
      [{ enabled: true, matchers: [{ type: 'all' }], actions: [] }],
      [{ enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: [] }] }],
      [{ enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: [42] }] }],
      [
        {
          enabled: true,
          matchers: [{ type: 'all' }],
          actions: [{ type: 'unrecognized', value: ['acme-support'] }],
        },
      ],
      [
        {
          enabled: true,
          matchers: [{ type: 'literal', field: 'from', value: 'support@acme.com' }],
          actions: [{ type: 'drop' }],
        },
      ],
      [
        {
          enabled: true,
          matchers: [{ type: 'all' }, { type: 'literal', field: 'to', value: 'support@acme.com' }],
          actions: [{ type: 'drop' }],
        },
      ],
    ].map((value) => ({ value })),
  )('fails closed on malformed or unsupported rules $value', ({ value }) => {
    expect(readRoutingRules(value)).toBeNull();
  });

  it('fails closed on malformed JSON and settings', () => {
    expect(readRoutingSettings('not json')).toBeNull();
    expect(readRoutingRules('not json')).toBeNull();
    expect(readSendingSettings('not json')).toBeNull();
    expect(
      readRoutingSettings({ name: 'acme.com', enabled: 'true', status: 'ready', tag: ZONE_ID }),
    ).toBeNull();
    expect(readSendingSettings({ name: 'acme.com', enabled: true, tag: 'invalid' })).toBeNull();
    expect(parseWhoamiJson('not json')).toBeNull();
    expect(parseWhoamiJson({ loggedIn: true, tokenPermissions: 'email_routing:write' })).toBeNull();
    expect(parseWhoamiJson({ loggedIn: true, accounts: 'invalid' })).toBeNull();
  });
});

// ── Preflight ────────────────────────────────────────────────────────────────────

describe('preflightEmail', () => {
  it('first deploy on a subdomain: every row pending, no blocker, exact read-only provider operations', async () => {
    const { inputs, calls, fetchCalls } = transcriptInputs();
    const pre = await preflightEmail(inputs);

    expect(pre.mode).toBe('subdomain');
    expect(pre.apex).toBe('acme.com');
    expect(pre.zone).toEqual({ state: 'found', zoneId: ZONE_ID, type: 'full' });
    expect(pre.session).toMatchObject({
      state: 'ok',
      email: 'dev@example.com',
      accountName: 'Acme',
    });
    expect(pre.apexMx).toEqual({
      state: 'foreign',
      exchanges: ['aspmx.l.google.com', 'alt1.aspmx.l.google.com'],
    });
    expect(pre.domainMx).toEqual({ state: 'empty', exchanges: [] });
    expect(pre.routing.state).toBe('pending');
    expect(pre.subaddressing.state).toBe('off');
    expect(pre.sending).toEqual({ state: 'pending', dnsConflicts: [] });
    expect(pre.rules).toEqual({
      state: 'pending',
      mine: [],
      foreign: [],
      absent: ['support@mail.acme.com'],
    });
    expect(pre.binding).toEqual({ state: 'absent' });
    expect(pre.addresses).toEqual(['support@mail.acme.com']);
    expect(pre.derived.refused).toHaveLength(1);
    expect(pre.blockers).toEqual([]);
    expect(pre.ready).toBe(false);

    expect(calls.map((c) => c.args)).toEqual([
      ['whoami', '--json'],
      ['email', 'routing', 'settings', 'mail.acme.com'],
      ['email', 'routing', 'settings', 'acme.com'],
      ['email', 'routing', 'rules', 'list', 'acme.com'],
      ['email', 'sending', 'settings', 'mail.acme.com'],
    ]);
    expect(calls.every((c) => c.capture)).toBe(true);
    expect(fetchCalls.map((c) => `${c.method} ${c.url.slice(c.url.indexOf('/zones'))}`)).toEqual([
      'GET /zones?name=acme.com',
      `GET /zones/${ZONE_ID}/email/routing`,
    ]);
  });

  it('second deploy, everything set up: ready, zero changes', async () => {
    const { inputs } = readyAccount();
    const pre = await preflightEmail(inputs);
    expect(pre.routing.state).toBe('ready');
    expect(pre.subaddressing.state).toBe('on');
    expect(pre.sending.state).toBe('ready');
    expect(pre.rules).toEqual({
      state: 'ready',
      mine: ['support@mail.acme.com'],
      foreign: [],
      absent: [],
    });
    expect(pre.binding.state).toBe('present');
    expect(pre.sender.state).toBe('ready');
    expect(pre.addressesOwnership).toEqual({ state: 'mine', foreign: [] });
    expect(pre.addressesStale).toBe(false);
    expect(pre.rulesPending).toEqual([]);
    expect(pre.blockers).toEqual([]);
    expect(pre.ready).toBe(true);
    expect(renderEmailChecklist(pre)).toContain('Nothing to change — email is set up.');
  });

  it('an API-token session (CLOUDFLARE_API_TOKEN) is not gated on `tokenPermissions`: reads run, ready reads ready', async () => {
    // wrangler fills `tokenPermissions` from the stored login file only, so under an API token
    // it is absent (or describes a stale login file, never the token). The gate is the reads.
    const calls: Array<Call> = [];
    const fetchCalls: Array<FetchCall> = [];
    const { inputs } = readyAccount({
      calls,
      fetchCalls,
      runnerTable: {
        'whoami --json': {
          status: 0,
          stdout: '',
          data: {
            loggedIn: true,
            authType: 'User API Token',
            email: 'dev@example.com',
            accounts: [{ id: ACCOUNT, name: 'Acme' }],
          },
          stderr: '',
        },
      },
    });
    const pre = await preflightEmail(inputs);
    expect(pre.session).toMatchObject({
      state: 'ok',
      authType: 'User API Token',
      missingScopes: [],
    });
    expect(calls.map((c) => c.args.join(' '))).toEqual([
      'whoami --json',
      'email routing settings mail.acme.com',
      'email routing settings acme.com',
      'email routing rules list acme.com',
      'email sending settings mail.acme.com',
    ]);
    expect(fetchCalls).toHaveLength(2);
    expect(pre.blockers).toEqual([]);
    expect(pre.ready).toBe(true);
    expect(renderEmailChecklist(pre)).toContain('session dev@example.com (User API Token)');
  });

  it('an API-token session whose read is refused fails closed with the token-permission hint', async () => {
    const { inputs } = transcriptInputs({
      runnerTable: {
        'whoami --json': {
          status: 0,
          stdout: '',
          data: { loggedIn: true, authType: 'Account API Token' },
          stderr: '',
        },
        'email routing settings mail.acme.com': apiFailure(10_000, '/zones'),
      },
    });
    const pre = await preflightEmail(inputs);
    expect(pre.session.state).toBe('ok');
    expect(pre.blockers).toEqual([
      {
        scope: 'all',
        message: expect.stringContaining(
          'an API token needs Email Routing Edit + Email Sending Edit',
        ),
      },
    ]);
    expect(pre.ready).toBe(false);
  });

  it('a committed config whose rules wrangler has not created yet still reads ready (rules are `wrangler deploy` work)', async () => {
    // Right after `void email setup`, before the first deploy: the array is committed, the
    // rule is absent. Apply has nothing to do; the deploy creates the rule.
    const { inputs } = readyAccount({ rules: emptyRules });
    const pre = await preflightEmail(inputs);
    expect(pre.rules.state).toBe('pending');
    expect(pre.rules.absent).toEqual(['support@mail.acme.com']);
    expect(pre.rulesPending).toEqual(['support@mail.acme.com']);
    expect(pre.addressesStale).toBe(false);
    expect(pre.ready).toBe(true);
    const text = renderEmailChecklist(pre);
    expect(text).not.toContain('+ Cloudflare config');
    expect(text).toContain('+ routing rule (created on deploy)');
  });

  it('flags a committed `addresses` array that is not the pruned set as stale, without losing ready', async () => {
    // A rule Void created was later re-pointed at a forward: the entry is pruned, and the
    // committed array still listing it would reach wrangler's plan as a `conflict`.
    const forwarded = routingRules({
      supportDomain: 'mail.acme.com',
      salesDomain: 'mail.acme.com',
    });
    const retarget = await preflightEmail(
      readyAccount({
        rules: forwarded,
        handlers: scan(['support.ts', 'sales.ts']),
        existingAddresses: ['support@mail.acme.com', 'sales@mail.acme.com'],
      }).inputs,
    );
    expect(retarget.ready).toBe(true);
    expect(retarget.addresses).toEqual(['support@mail.acme.com']);
    expect(retarget.addressesStale).toBe(true);

    // Worker rename: every rule now belongs to the old name, so nothing is Void's to list.
    const renamed = await preflightEmail(
      readyAccount({ workerName: 'acme-mail', existingAddresses: ['support@mail.acme.com'] })
        .inputs,
    );
    expect(renamed.ready).toBe(true);
    expect(renamed.addresses).toEqual([]);
    expect(renamed.addressesStale).toBe(true);
    expect(renderEmailChecklist(renamed)).toContain('addresses: (removed)');

    // A hand-emptied array with a derived address, and an absent array, are stale too.
    expect(
      (await preflightEmail(readyAccount({ existingAddresses: [] }).inputs)).addressesStale,
    ).toBe(true);
    expect(
      (await preflightEmail(readyAccount({ existingAddresses: undefined }).inputs)).addressesStale,
    ).toBe(true);
    // Equal to the pruned set (order-insensitive): not stale.
    expect(
      (await preflightEmail(readyAccount({ existingAddresses: ['SUPPORT@mail.acme.com'] }).inputs))
        .addressesStale,
    ).toBe(false);
  });

  it('reads the sender var as ready / stale / absent, as a config row that does not gate ready', async () => {
    const stale = await preflightEmail(
      readyAccount({ existingVars: { __VOID_EMAIL_FROM: 'hello@mail.acme.com' } }).inputs,
    );
    expect(stale.sender.state).toBe('stale');
    expect(stale.ready).toBe(true);
    expect(renderEmailChecklist(stale)).toContain(
      '    + Cloudflare config                           vars.__VOID_EMAIL_FROM: "noreply@mail.acme.com"',
    );
    const absent = await preflightEmail(readyAccount({ existingVars: undefined }).inputs);
    expect(absent.sender.state).toBe('absent');
    expect(absent.ready).toBe(true);
    expect(renderEmailChecklist(absent)).toContain(
      '    sender    noreply@mail.acme.com  (vars.__VOID_EMAIL_FROM absent)',
    );
  });

  it('turns a writer refusal the caller precomputed into an `all` blocker', async () => {
    const { inputs } = transcriptInputs({
      configConflicts: findEmailConfigConflicts({ vars: { SEND_EMAIL: 'x' } }),
    });
    const pre = await preflightEmail(inputs);
    expect(pre.blockers).toEqual([
      {
        scope: 'all',
        message:
          'Cloudflare config already uses SEND_EMAIL as a Environment Variable binding; rename it in void.config.ts (Void writes SEND_EMAIL into send_email)',
      },
    ]);
  });

  it('refuses the apex when foreign MX already receives mail there', async () => {
    const { inputs } = transcriptInputs({
      from: 'noreply@acme.com',
      runnerTable: {
        'email routing settings acme.com': routingSettings(
          'acme.com',
          false,
          'unconfigured',
          ZONE_ID,
        ),
        'email sending settings acme.com': sendingNotFound('acme.com'),
      },
    });
    const pre = await preflightEmail(inputs);
    expect(pre.mode).toBe('apex');
    expect(pre.blockers).toEqual([
      {
        scope: 'all',
        message:
          'acme.com already receives mail (aspmx.l.google.com, alt1.aspmx.l.google.com). Void never enables routing over live mail. Use something@mail.acme.com.',
      },
    ]);
    expect(pre.ready).toBe(false);
  });

  it('allows the apex with an empty MX (decision 10), catch-all included', async () => {
    const { inputs } = transcriptInputs({
      from: 'noreply@acme.com',
      runnerTable: {
        'email routing settings acme.com': routingSettings(
          'acme.com',
          false,
          'unconfigured',
          ZONE_ID,
        ),
        'email sending settings acme.com': sendingNotFound('acme.com'),
      },
      dns: fakeDns({}),
    });
    const pre = await preflightEmail(inputs);
    expect(pre.blockers).toEqual([]);
    expect(pre.addresses).toEqual(['support@acme.com', '*@acme.com']);
    expect(pre.derived.refused).toEqual([]);
    expect(pre.rules.absent).toEqual(['support@acme.com', '*@acme.com']);
  });

  it('every session blocker routes Cloudflare login through Void, never through wrangler', async () => {
    // AGENTS.md: user-facing output never asks for a wrangler command. These rows print raw
    // from `void email setup` / `status`, and through `formatCloudflareUserMessage` on the
    // deploy path, where a `wrangler …` command would render as "the underlying Cloudflare
    // operation" — no guidance at all.
    const who = structuredClone(whoamiResult().data) as { tokenPermissions: Array<string> };
    who.tokenPermissions = who.tokenPermissions.filter((s) => !s.startsWith('email_'));
    const unreadable = 'could not read the Cloudflare session — run `void cloudflare login`';
    const sessions: Array<{
      state: EmailPreflight['session']['state'];
      whoami: EmailWranglerRunResult;
      message: string;
    }> = [
      {
        state: 'unknown',
        whoami: { status: 1, stdout: '', data: '', stderr: '✘ [ERROR] boom\n' },
        message: unreadable,
      },
      {
        state: 'unknown',
        whoami: { status: 0, stdout: '', data: 'not json', stderr: '' },
        message: unreadable,
      },
      {
        state: 'not-logged-in',
        whoami: { status: 0, stdout: '', data: { loggedIn: false }, stderr: '' },
        message: 'not logged in to Cloudflare — run `void cloudflare login`',
      },
      {
        state: 'api-key',
        whoami: {
          status: 0,
          stdout: '',
          data: { loggedIn: true, authType: 'Global API Key' },
          stderr: '',
        },
        // A Global API Key wins over both an OAuth session and CLOUDFLARE_API_TOKEN in
        // wrangler's env precedence, so neither alternative works until the key is unset.
        message:
          'the Cloudflare session is a Global API Key (CLOUDFLARE_API_KEY), which has no bearer to borrow for the subaddressing calls — unset CLOUDFLARE_API_KEY, then run `void cloudflare login` or set CLOUDFLARE_API_TOKEN to a token with Email Routing Edit + Email Sending Edit',
      },
      {
        state: 'missing-scopes',
        whoami: { status: 0, stdout: '', data: who, stderr: '' },
        message:
          'the Cloudflare session lacks email_routing:write + email_sending:write — run `void cloudflare logout`, then `void cloudflare login` (one browser Allow)',
      },
    ];
    for (const session of sessions) {
      const calls: Array<Call> = [];
      const fetchCalls: Array<FetchCall> = [];
      const { inputs } = transcriptInputs({
        calls,
        fetchCalls,
        runnerTable: { 'whoami --json': session.whoami },
      });
      const pre = await preflightEmail(inputs);
      expect(pre.session.state).toBe(session.state);
      expect(pre.blockers).toEqual([{ scope: 'all', message: session.message }]);
      const message = pre.blockers[0]!.message;
      expect(message).toContain('`void cloudflare login`');
      expect(message).not.toMatch(/wrangler/i);
      // The checklist carries the row verbatim on both printing paths.
      expect(renderEmailChecklist(pre)).toContain(`    ✘ ${message}`);
      // A session that cannot do the work gets no other read and lends no bearer.
      expect(calls.map((c) => c.args.join(' '))).toEqual(['whoami --json']);
      expect(fetchCalls).toEqual([]);
    }
  });

  it('keeps apex-mode routing status unlocked / misconfigured blocked — never re-locks', async () => {
    for (const status of ['unlocked', 'misconfigured', 'misconfigured_locked']) {
      const { inputs } = transcriptInputs({
        from: 'noreply@acme.com',
        dns: fakeDns({}),
        runnerTable: {
          'email routing settings acme.com': routingSettings('acme.com', true, status, ZONE_ID),
          'email sending settings acme.com': sendingNotFound('acme.com'),
        },
      });
      const pre = await preflightEmail(inputs);
      expect(
        pre.blockers.some(
          (b) => b.message.includes(status) && b.message.includes('never re-locks'),
        ),
      ).toBe(true);
    }
  });

  it('keeps an explicitly unlocked apex blocked for subdomain setup', async () => {
    const { inputs } = transcriptInputs({
      runnerTable: {
        'email routing settings acme.com': routingSettings('acme.com', true, 'unlocked', ZONE_ID),
      },
    });
    const pre = await preflightEmail(inputs);
    expect(pre.blockers).toContainEqual({
      scope: 'all',
      message:
        'Email Routing on acme.com is unlocked — fix it in the Cloudflare dashboard; Void never re-locks records you unlocked',
    });
  });

  it('uses the subdomain MX as authoritative when apex routing is misconfigured', async () => {
    const { inputs } = readyAccount({
      runnerTable: {
        'email routing settings acme.com': routingSettings(
          'acme.com',
          true,
          'misconfigured',
          ZONE_ID,
        ),
      },
    });
    const pre = await preflightEmail(inputs);
    expect(pre.mode).toBe('subdomain');
    expect(pre.routing).toEqual({
      state: 'ready',
      status: 'misconfigured',
      enabled: true,
    });
    expect(pre.blockers).toEqual([]);
    expect(pre.ready).toBe(true);
  });

  it('still blocks foreign MX on the subdomain when apex routing is misconfigured', async () => {
    const { inputs } = transcriptInputs({
      runnerTable: {
        'email routing settings acme.com': routingSettings(
          'acme.com',
          true,
          'misconfigured',
          ZONE_ID,
        ),
      },
      dns: fakeDns({ mx: { 'mail.acme.com': ['mx.example.net'] } }),
    });
    const pre = await preflightEmail(inputs);
    expect(pre.routing.state).toBe('pending');
    expect(pre.blockers).toContainEqual({
      scope: 'all',
      message:
        'mail.acme.com already receives mail (mx.example.net). Void never enables routing over live mail.',
    });
  });

  it('refuses sending onboarding when _dmarc / cf-bounce TXT already exist (sending-scoped)', async () => {
    const { inputs } = transcriptInputs({
      dns: fakeDns({
        mx: { 'acme.com': ['aspmx.l.google.com'] },
        txt: {
          '_dmarc.mail.acme.com': ['v=DMARC1; p=none'],
          'cf-bounce.mail.acme.com': ['v=spf1'],
        },
      }),
    });
    const pre = await preflightEmail(inputs);
    expect(pre.sending.dnsConflicts).toEqual(['_dmarc.mail.acme.com', 'cf-bounce.mail.acme.com']);
    expect(pre.blockers).toEqual([
      {
        scope: 'sending',
        message: expect.stringContaining(
          '_dmarc.mail.acme.com, cf-bounce.mail.acme.com already exists',
        ),
      },
    ]);
    // Routing is still on the table — the sending blocker is not an `all` blocker.
    expect(pre.addresses).toEqual(['support@mail.acme.com']);
  });

  it('prunes an address already routed elsewhere and reports the owner (decision 12)', async () => {
    const { inputs } = transcriptInputs({
      handlers: scan(['support.ts', 'sales.ts']),
      runnerTable: {
        'email routing rules list acme.com': {
          status: 0,
          stdout: '',
          data: routingRules({ supportDomain: 'mail.acme.com', salesDomain: 'mail.acme.com' }),
          stderr: BETA_WARNING,
        },
      },
    });
    const pre = await preflightEmail(inputs);
    expect(pre.rules.mine).toEqual(['support@mail.acme.com']);
    expect(pre.rules.foreign).toEqual([
      { address: 'sales@mail.acme.com', owner: 'forward:sales@gmail.com' },
    ]);
    expect(pre.addresses).toEqual(['support@mail.acme.com']);
    expect(pre.blockers).toEqual([]);
    expect(renderEmailChecklist(pre)).toContain(
      `    ! ${'sales@mail.acme.com'.padEnd(44)}already routed to forward:sales@gmail.com; left alone, not in addresses`,
    );
  });

  it('treats a disabled custom rule as absent, like the disabled catch-all', async () => {
    // A rule to this worker that Cloudflare has switched off routes no mail: the row is
    // `absent`, so the deploy's `addresses` entry stays and wrangler's plan turns it back on.
    const disabled = routingRules({ supportDomain: 'mail.acme.com', supportEnabled: false });
    const pre = await preflightEmail(readyAccount({ rules: disabled }).inputs);
    expect(pre.rules.mine).toEqual([]);
    expect(pre.rules.absent).toEqual(['support@mail.acme.com']);
    expect(pre.rules.state).toBe('pending');
    expect(pre.rulesPending).toEqual(['support@mail.acme.com']);
    expect(pre.addresses).toEqual(['support@mail.acme.com']);
    const text = renderEmailChecklist(pre);
    expect(text).toContain('support@mail.acme.com → acme-support   (absent)');
    expect(text).toContain('+ routing rule (created on deploy)');

    // A disabled rule is skipped, not matched: an enabled sibling on the same address still
    // decides the row — here a forward that owns the address, so it is pruned (decision 12).
    const sibling = routingRules({
      supportDomain: 'mail.acme.com',
      supportEnabled: false,
      extra: [
        {
          id: '7g8h9i',
          name: '(none)',
          enabled: true,
          matchers: [{ type: 'literal', field: 'to', value: 'support@mail.acme.com' }],
          actions: [{ type: 'forward', value: ['support@gmail.com'] }],
        },
      ],
    });
    const preSibling = await preflightEmail(readyAccount({ rules: sibling }).inputs);
    expect(preSibling.rules.absent).toEqual([]);
    expect(preSibling.rules.foreign).toEqual([
      { address: 'support@mail.acme.com', owner: 'forward:support@gmail.com' },
    ]);

    // A disabled FOREIGN rule is still somebody else's matcher: the row stays `foreign`
    // and the address is pruned, exactly as when the rule is enabled — Void does not
    // take over another owner's rule because it is switched off.
    const disabledForeign = routingRules({
      supportDomain: 'mail.acme.com',
      supportEnabled: false,
      supportAction: { type: 'forward', value: ['support@gmail.com'] },
    });
    const preForeign = await preflightEmail(readyAccount({ rules: disabledForeign }).inputs);
    expect(preForeign.rules.absent).toEqual([]);
    expect(preForeign.rules.mine).toEqual([]);
    expect(preForeign.rules.foreign).toEqual([
      { address: 'support@mail.acme.com', owner: 'forward:support@gmail.com' },
    ]);
    expect(preForeign.addresses).toEqual([]);
  });

  it('treats a catch-all owned by another worker as foreign, by this worker as mine', async () => {
    const base = {
      from: 'noreply@acme.com',
      runnerTable: {
        'email sending settings acme.com': sendingNotFound('acme.com'),
      },
      dns: fakeDns({ mx: { 'acme.com': ['route1.mx.cloudflare.net'] } }),
      handlers: scan([], '_default.ts'),
    };
    const foreign = transcriptInputs({
      ...base,
      runnerTable: {
        ...base.runnerTable,
        'email routing rules list acme.com': {
          status: 0,
          stdout: '',
          data: routingRules({ catchAllWorker: 'other-worker' }),
          stderr: BETA_WARNING,
        },
      },
    });
    const preForeign = await preflightEmail(foreign.inputs);
    expect(preForeign.rules.foreign).toEqual([
      { address: '*@acme.com', owner: 'worker:other-worker' },
    ]);
    expect(preForeign.addresses).toEqual([]);

    const mine = transcriptInputs({
      ...base,
      runnerTable: {
        ...base.runnerTable,
        'email routing rules list acme.com': {
          status: 0,
          stdout: '',
          data: routingRules(),
          stderr: BETA_WARNING,
        },
      },
    });
    const preMine = await preflightEmail(mine.inputs);
    expect(preMine.rules.mine).toEqual(['*@acme.com']);
  });

  it('refuses a hand-written `addresses` array holding entries Void did not derive', async () => {
    const { inputs } = transcriptInputs({
      existingAddresses: ['support@mail.acme.com', 'billing@mail.acme.com'],
    });
    const pre = await preflightEmail(inputs);
    expect(pre.addressesOwnership).toEqual({
      state: 'foreign',
      foreign: ['billing@mail.acme.com'],
    });
    expect(pre.blockers).toEqual([
      { scope: 'all', message: expect.stringContaining('billing@mail.acme.com') },
    ]);
    expect(pre.blockers[0]?.message).toContain('skipping email setup this deploy');
    // The exact edit is named, so the developer does not have to guess which entries.
    expect(pre.blockers[0]?.message).toContain(
      'remove "billing@mail.acme.com" from cloudflare.addresses',
    );
  });

  it('refuses an existing send_email binding not named SEND_EMAIL, with the rename', async () => {
    const { inputs } = transcriptInputs({ existingSendEmail: [{ name: 'EMAIL' }] });
    const pre = await preflightEmail(inputs);
    expect(pre.binding).toEqual({ state: 'foreign', foreignName: 'EMAIL' });
    expect(pre.blockers[0]?.message).toBe(
      'Cloudflare config already has a send_email binding named "EMAIL"; rename it to SEND_EMAIL in void.config.ts (a second binding would be silent)',
    );
  });

  it('zone not on Cloudflare in this account: blocker, no rules/sending reads', async () => {
    const calls: Array<Call> = [];
    const { inputs } = transcriptInputs({
      calls,
      runnerTable: { 'email routing settings acme.com': zoneNotFound('acme.com') },
      fetchTable: {
        'GET /zones?name=mail.acme.com': () => jsonResponse(200, { success: true, result: [] }),
        'GET /zones?name=acme.com': () => jsonResponse(200, { success: true, result: [] }),
      },
    });
    const pre = await preflightEmail(inputs);
    expect(pre.zone.state).toBe('not-found');
    expect(pre.blockers).toEqual([
      { scope: 'all', message: expect.stringContaining('no zone for mail.acme.com') },
    ]);
    expect(calls.map((c) => c.args.join(' '))).toEqual([
      'whoami --json',
      'email routing settings mail.acme.com',
      'email routing settings acme.com',
    ]);
  });

  it('zone in another account is told apart from not-on-Cloudflare via GET /zones?name= without account.id', async () => {
    const fetchCalls: Array<FetchCall> = [];
    const { inputs } = transcriptInputs({
      fetchCalls,
      runnerTable: { 'email routing settings acme.com': zoneNotFound('acme.com') },
      fetchTable: {
        'GET /zones?name=mail.acme.com': () => jsonResponse(200, { success: true, result: [] }),
        'GET /zones?name=acme.com': zonesOk('acme.com', {
          account: '00000000000000000000000000000000',
        }),
      },
    });
    const pre = await preflightEmail(inputs);
    expect(pre.zone.state).toBe('other-account');
    expect(pre.blockers[0]?.message).toContain('different Cloudflare account');
    for (const call of fetchCalls) {
      expect(call.url).not.toContain('account.id');
    }
  });

  it('refuses a partial (CNAME-setup) zone', async () => {
    const { inputs } = transcriptInputs({
      fetchTable: { 'GET /zones?name=acme.com': zonesOk('acme.com', { type: 'partial' }) },
    });
    const pre = await preflightEmail(inputs);
    expect(pre.zone).toEqual({ state: 'partial', zoneId: ZONE_ID, type: 'partial' });
    expect(pre.blockers[0]?.message).toContain('partial zone');
  });

  it('a parser miss fails closed: unknown row + `run void email setup`', async () => {
    const { inputs } = transcriptInputs({
      runnerTable: {
        'email routing rules list acme.com': {
          status: 0,
          stdout: '',
          data: '{broken json',
          stderr: '',
        },
      },
    });
    const pre = await preflightEmail(inputs);
    expect(pre.rules.state).toBe('unknown');
    expect(pre.blockers).toEqual([
      {
        scope: 'all',
        message:
          'could not read Email Routing rules — unknown — run `void email setup --platform cloudflare`',
      },
    ]);
  });

  it('works without a bearer: subaddressing unknown, zone from the settings Tag, no fetch', async () => {
    const fetchCalls: Array<FetchCall> = [];
    const { inputs } = transcriptInputs({ fetchCalls, getSessionBearer: async () => null });
    const pre = await preflightEmail(inputs);
    expect(fetchCalls).toEqual([]);
    expect(pre.zone).toEqual({ state: 'found', zoneId: ZONE_ID });
    expect(pre.subaddressing.state).toBe('unknown');
    expect(pre.blockers).toEqual([]);
  });

  it('a refused handler or a DMARC conflict does not keep a set-up deploy from reading ready', async () => {
    const { inputs } = transcriptInputs({
      runnerTable: {
        'email routing rules list acme.com': {
          status: 0,
          stdout: '',
          data: routingRules({ supportDomain: 'mail.acme.com' }),
          stderr: BETA_WARNING,
        },
      },
      fetchTable: { [`GET /zones/${ZONE_ID}/email/routing`]: routingGet(true) },
      dns: fakeDns({
        mx: { 'acme.com': ['aspmx.l.google.com'], 'mail.acme.com': ['route1.mx.cloudflare.net'] },
        txt: { '_dmarc.mail.acme.com': ['v=DMARC1; p=none'] },
      }),
      // `_default.ts` stays refused on the subdomain; sending stays blocked by the TXT.
      existingSendEmail: [{ name: 'SEND_EMAIL' }],
      existingAddresses: ['support@mail.acme.com'],
    });
    const pre = await preflightEmail(inputs);
    expect(pre.derived.refused).toHaveLength(1);
    expect(pre.blockers.map((b) => b.scope)).toEqual(['sending']);
    expect(pre.ready).toBe(true);
  });

  it('remembers a refused sending onboarding by the committed binding: pending + binding present reads ready, retry on offer', async () => {
    // Workers Free after `void email setup`: routing + subaddressing on, the binding,
    // `addresses` and the sender var committed, and `sending settings` still answering
    // not-found — the same answer a Paid account that never onboarded gives. The binding
    // is written only by a run that already attempted `sending enable`, so it is the
    // memory of the refusal: settled, never asked again by the deploy, and the retry is
    // what `void email setup` offers.
    const notOnboarded = {
      'email sending settings mail.acme.com': sendingNotFound('mail.acme.com'),
    };
    const remembered = await preflightEmail(readyAccount({ runnerTable: notOnboarded }).inputs);
    expect(remembered.sending.state).toBe('pending');
    expect(remembered.binding.state).toBe('present');
    expect(remembered.blockers).toEqual([]);
    expect(remembered.ready).toBe(true);
    expect(remembered.sendingRetryable).toBe(true);
    const text = renderEmailChecklist(remembered);
    expect(text).toContain(
      '    sending   mail.acme.com  not onboarded — verified destinations only; after upgrading to Workers Paid run void email setup --platform cloudflare',
    );
    // The onboarding stays listed as the one account change — the retry prompt's row.
    expect(text).toContain('    + onboard mail.acme.com for Email Sending');
    expect(text).not.toContain('Nothing to change');

    // No binding: nothing has attempted the onboarding yet, so the row is plain work.
    const untried = await preflightEmail(
      readyAccount({ runnerTable: notOnboarded, existingSendEmail: undefined }).inputs,
    );
    expect(untried.binding.state).toBe('absent');
    expect(untried.ready).toBe(false);
    expect(untried.sendingRetryable).toBe(true);
    expect(renderEmailChecklist(untried)).toContain('    sending   mail.acme.com  not onboarded\n');

    // A sending-scoped blocker settles the row on its own and leaves nothing to retry:
    // the ✘ row carries the reason, the sending row keeps the bare word.
    const conflict = await preflightEmail(
      readyAccount({
        runnerTable: notOnboarded,
        dns: fakeDns({
          mx: {
            'acme.com': ['aspmx.l.google.com'],
            'mail.acme.com': ['route1.mx.cloudflare.net', 'route2.mx.cloudflare.net'],
          },
          txt: { '_dmarc.mail.acme.com': ['v=DMARC1; p=none'] },
        }),
      }).inputs,
    );
    expect(conflict.blockers.map((b) => b.scope)).toEqual(['sending']);
    expect(conflict.ready).toBe(true);
    expect(conflict.sendingRetryable).toBe(false);
    expect(renderEmailChecklist(conflict)).toContain(
      '    sending   mail.acme.com  not onboarded\n',
    );

    // Onboarded: nothing to retry.
    const onboarded = await preflightEmail(readyAccount().inputs);
    expect(onboarded.sending.state).toBe('ready');
    expect(onboarded.sendingRetryable).toBe(false);
  });

  it('an MX lookup that fails outright is unknown, and blocks (fail closed)', async () => {
    const { inputs } = transcriptInputs({
      dns: fakeDns({
        mx: { 'acme.com': ['aspmx.l.google.com'] },
        mxError: { 'mail.acme.com': 'ETIMEOUT' },
      }),
    });
    const pre = await preflightEmail(inputs);
    expect(pre.domainMx.state).toBe('unknown');
    expect(pre.blockers).toEqual([
      {
        scope: 'all',
        message:
          'could not read the MX records of mail.acme.com — unknown — run `void email setup --platform cloudflare`',
      },
    ]);
  });

  it('rejects an email.from that is not an address', async () => {
    const { inputs } = transcriptInputs({ from: 'nope' });
    await expect(preflightEmail(inputs)).rejects.toThrow('email.from must be an address');
  });
});

describe('sending-only Cloudflare email', () => {
  const SUBDOMAINS = `/zones/${ZONE_ID}/email/sending/subdomains`;
  const listed = (domain: string) => () =>
    jsonResponse(200, {
      success: true,
      result: [{ name: domain, enabled: true, tag: '19af4fdbee924a92916afea0de5a8fdd' }],
    });
  const notListed = () => jsonResponse(200, { success: true, result: [] });
  const refused = (code: number) => () =>
    jsonResponse(403, { success: false, errors: [{ code, message: 'Forbidden' }], result: null });

  /**
   * Email Sending is read and onboarded through the bearer on the zone preflight resolved.
   * The runner knows no Email operation, so any provider Email call fails the test.
   */
  function sendingOnly(
    domain = 'mail.acme.com',
    account: { list?: () => Response; enable?: () => Response } = {},
  ) {
    const fixture = transcriptInputs({
      handlers: scan([]),
      from: `Pocket Folio <noreply@${domain}>`,
      existingSendEmail: [{ name: 'SEND_EMAIL' }],
      existingVars: { __VOID_EMAIL_FROM: `Pocket Folio <noreply@${domain}>` },
      fetchTable: {
        'GET /zones?name=mail.acme.com': () => jsonResponse(200, { success: true, result: [] }),
        [`GET ${SUBDOMAINS}`]: account.list ?? listed(domain),
        [`POST ${SUBDOMAINS}`]:
          account.enable ??
          (() =>
            jsonResponse(200, {
              success: true,
              result: { name: domain, enabled: true, tag: '19af4fdbee924a92916afea0de5a8fdd' },
            })),
      },
      dns: {
        resolveMx: async () => {
          throw new Error('Sending-only apps must not inspect inbound MX');
        },
        resolveTxt: async () => [],
      },
    });
    const whoami: EmailWranglerRunResult = {
      status: 0,
      stdout: '',
      stderr: '',
      data: { loggedIn: true, authType: 'OAuth Token', tokenPermissions: ['email_sending:write'] },
    };
    fixture.inputs.runWrangler = fakeRunner({ 'whoami --json': whoami }, fixture.calls);
    return fixture;
  }
  const paths = (fetchCalls: Array<FetchCall>) =>
    fetchCalls.map(({ method, url }) => `${method} ${url.slice(url.indexOf('/zones'))}`);

  it.each(['acme.com', 'mail.acme.com'])(
    'accepts onboarded sending on %s without routing scopes or probes',
    async (domain) => {
      const { inputs, calls, fetchCalls } = sendingOnly(domain);
      const pre = await preflightEmail(inputs);
      expect(pre.ready).toBe(true);
      expect(pre.blockers).toEqual([]);
      expect(pre.session.missingScopes).toEqual([]);
      expect(pre.sender.state).toBe('ready');
      expect(calls.map(({ operation }) => operation.type)).toEqual(['auth.whoami']);
      expect(paths(fetchCalls)).toEqual([
        ...(domain === 'acme.com' ? [] : ['GET /zones?name=mail.acme.com']),
        'GET /zones?name=acme.com',
        `GET ${SUBDOMAINS}`,
      ]);
      const printed = renderEmailChecklist(pre);
      expect(printed).toContain('sending only');
      expect(printed).toContain('inbound   not required');
      expect(printed).toContain('email sending is configured');
      expect(printed).not.toMatch(/enable Email Routing|subaddressing|apex MX|This changes/);
    },
  );

  it('matches the listed subdomain by name and treats an absent one as not onboarded', async () => {
    const other = sendingOnly('mail.acme.com', { list: listed('news.acme.com') });
    const pre = await preflightEmail(other.inputs);
    expect(pre.sending.state).toBe('pending');
    expect(pre.ready).toBe(false);
  });

  it('writes the binding and sender without touching inbound configuration', async () => {
    const { inputs, calls, fetchCalls } = sendingOnly();
    inputs.existingSendEmail = undefined;
    inputs.existingVars = undefined;
    const pre = await preflightEmail(inputs);
    expect(pre.ready).toBe(false);
    calls.length = 0;
    fetchCalls.length = 0;
    const out = await applyEmailSetup(pre, inputs);
    expect(out.ready).toBe(true);
    expect(out.inboundReady).toBe(false);
    expect(out.patch).toEqual({
      sendEmail: { name: 'SEND_EMAIL' },
      vars: { __VOID_EMAIL_FROM: inputs.from },
      addresses: null,
    });
    expect(calls).toEqual([]);
    expect(fetchCalls).toEqual([]);
  });

  it('onboards through the bearer on the resolved zone, and never enables routing or subaddressing', async () => {
    const { inputs, calls, fetchCalls } = sendingOnly('mail.acme.com', { list: notListed });
    const pre = await preflightEmail(inputs);
    expect(pre.ready).toBe(false);
    calls.length = 0;
    fetchCalls.length = 0;
    const out = await applyEmailSetup(pre, inputs);
    expect(out.ready).toBe(true);
    expect(out.lines).toContain('  ✔ sending   mail.acme.com onboarded');
    expect(calls).toEqual([]);
    expect(paths(fetchCalls)).toEqual([`POST ${SUBDOMAINS}`]);
    expect(fetchCalls[0]!.body).toBe(JSON.stringify({ name: 'mail.acme.com' }));
    expect(fetchCalls[0]!.headers.Authorization).toBe(`Bearer ${BEARER}`);
  });

  it('names a missing session bearer instead of the Workers Paid plan when onboarding cannot start', async () => {
    const { inputs, fetchCalls } = sendingOnly('mail.acme.com', { list: notListed });
    const pre = await preflightEmail(inputs);
    fetchCalls.length = 0;
    inputs.getSessionBearer = async () => {
      throw new Error('session expired');
    };
    const out = await applyEmailSetup(pre, inputs);
    expect(out.ready).toBe(false);
    expect(out.lines).toContain(
      '  ! sending   mail.acme.com not onboarded (session bearer unavailable); rerun void email setup --platform cloudflare',
    );
    expect(out.lines.some((line) => line.includes('Workers Paid'))).toBe(false);
    expect(fetchCalls).toEqual([]);
  });

  it('treats code 2040 (already onboarded) as onboarded', async () => {
    const { inputs } = sendingOnly('mail.acme.com', { list: notListed, enable: refused(2040) });
    const out = await applyEmailSetup(await preflightEmail(inputs), inputs);
    expect(out.sendingReady).toBe(true);
    expect(out.ready).toBe(true);
  });

  it.each([notListed, refused(10_000)])(
    'does not mistake a binding for verified sending',
    async (list) => {
      const { inputs } = sendingOnly('mail.acme.com', { list, enable: refused(10_105) });
      const pre = await preflightEmail(inputs);
      expect(pre.ready).toBe(false);
      const out = await applyEmailSetup(pre, inputs);
      expect(out.ready).toBe(false);
      expect(out.lines.join('\n')).not.toContain('Inbound works');
      expect(renderEmailChecklist(pre)).not.toContain('email sending is configured');
    },
  );

  it('names Workers Paid, its link and the token permissions when onboarding is refused', async () => {
    const { inputs } = sendingOnly('mail.acme.com', { list: notListed, enable: refused(10_105) });
    const pre = await preflightEmail(inputs);
    expect(isAwaitingSendingOnboarding(pre)).toBe(true);
    const checklist = renderEmailChecklist(pre);
    expect(checklist).toContain(
      'sending   mail.acme.com  not onboarded — needs Workers Paid; after upgrading run void email setup --platform cloudflare',
    );
    expect(checklist).not.toContain('verified destinations only');
    const out = await applyEmailSetup(pre, inputs);
    expect(out.ready).toBe(false);
    expect(out.patch).toEqual({ addresses: null });
    const printed = out.lines.join('\n');
    expect(printed).toContain('[code: 10105]');
    for (const line of formatSendingOnlyPaidHint('mail.acme.com')) {
      expect(out.lines).toContain(`    ${line}`);
    }
    expect(printed).toContain('https://dash.cloudflare.com/?to=/:account/workers/plans');
    expect(printed).toContain('Zone Read + Email Sending Edit');
    expect(printed).not.toContain('verified destinations only');
  });

  it('does not treat an unreadable sending row as waiting for onboarding', async () => {
    const { inputs } = sendingOnly('mail.acme.com', { list: refused(10_000) });
    const pre = await preflightEmail(inputs);
    expect(isAwaitingSendingOnboarding(pre)).toBe(false);
    // Without a saved binding the app was never set up: deploy offers setup as usual.
    const fresh = sendingOnly('mail.acme.com', { list: notListed });
    fresh.inputs.existingSendEmail = undefined;
    expect(isAwaitingSendingOnboarding(await preflightEmail(fresh.inputs))).toBe(false);
  });

  it('reports an unreadable zone as unknown without proposing routing setup', async () => {
    const { inputs } = sendingOnly();
    inputs.fetchImpl = (async () => jsonResponse(403, { success: false })) as typeof fetch;
    const pre = await preflightEmail(inputs);
    expect(pre.zone.state).toBe('unknown');
    expect(pre.ready).toBe(false);
    expect(renderEmailChecklist(pre)).toContain('could not verify the sending domain');
    expect(renderEmailChecklist(pre)).not.toContain('enable Email Routing');
  });

  it('keeps stale inbound addresses visible and refuses to silently remove them', async () => {
    const { inputs } = sendingOnly();
    inputs.existingAddresses = ['support@mail.acme.com'];
    const pre = await preflightEmail(inputs);
    expect(pre.ready).toBe(false);
    expect(renderEmailChecklist(pre)).toContain('support@mail.acme.com');
    expect((await applyEmailSetup(pre, inputs)).patch).toEqual({});
  });
});

// ── Checklist ────────────────────────────────────────────────────────────────────

describe('renderEmailChecklist', () => {
  it('renders the checklist for the first subdomain deploy', async () => {
    const who = structuredClone(whoamiResult().data) as {
      email: string;
      accounts: Array<{ id: string; name: string }>;
    };
    who.email = 'dev@acme.com';
    who.accounts = [{ id: ACCOUNT, name: 'Acme' }];
    const { inputs } = transcriptInputs({
      runnerTable: { 'whoami --json': { status: 0, stdout: '', data: who, stderr: '' } },
    });
    const pre = await preflightEmail(inputs);
    expect(renderEmailChecklist(pre)).toBe(
      [
        '  Email in use   email/support+[ticket].ts · email/_default.ts',
        '    domain    mail.acme.com          (void.config.ts email.from)',
        '    zone      acme.com               account Acme (f721b8e5…) · session dev@acme.com',
        '    apex MX   aspmx.l.google.com     left alone — mail lives on the subdomain',
        '    routing   mail.acme.com  not enabled · subaddressing off',
        '    sending   mail.acme.com  not onboarded',
        '    rules     support@mail.acme.com → acme-support   (absent)',
        '    binding   SEND_EMAIL             (absent)',
        '    sender    noreply@mail.acme.com  (vars.__VOID_EMAIL_FROM absent)',
        '',
        '  This changes YOUR Cloudflare account. acme.com itself is not touched.',
        '    + enable Email Routing on mail.acme.com       Cloudflare writes and locks 3 MX + 1 SPF record there',
        '    + turn on subaddressing for acme.com          support+anything@ reaches support@',
        '    + onboard mail.acme.com for Email Sending     MX/SPF/DKIM on cf-bounce.mail.acme.com, _dmarc.mail.acme.com (p=reject)',
        '    + Cloudflare config                           send_email: [{ name: "SEND_EMAIL" }], addresses: ["support@mail.acme.com"], vars.__VOID_EMAIL_FROM: "noreply@mail.acme.com"',
        '    + routing rule (created on deploy)            support@mail.acme.com → acme-support',
        '    ! email/_default.ts                           a catch-all exists only on an apex; other @mail.acme.com mail bounces',
      ].join('\n'),
    );
  });

  it('renders blockers as ✘ rows so the developer sees why nothing is asked', async () => {
    const { inputs } = transcriptInputs({ existingSendEmail: [{ name: 'EMAIL' }] });
    const pre = await preflightEmail(inputs);
    const text = renderEmailChecklist(pre);
    expect(text).toContain('    binding   SEND_EMAIL             (found EMAIL instead)');
    expect(text).toContain(
      '    ✘ Cloudflare config already has a send_email binding named "EMAIL"',
    );
  });

  it('names a send-only app in the header when there are no email/ handlers', async () => {
    const pre = await preflightEmail(transcriptInputs({ handlers: scan([]) }).inputs);
    expect(renderEmailChecklist(pre).split('\n')[0]).toBe(
      '  Email in use   sending only (no email/ handlers)',
    );
  });
});

// ── Apply ────────────────────────────────────────────────────────────────────────

const ROUTING_DNS_POST = `POST /zones/${ZONE_ID}/email/routing/dns`;
const ROUTING_PATCH = `PATCH /zones/${ZONE_ID}/email/routing`;

function sendingEnabled(name: string): EmailWranglerRunResult {
  return {
    status: 0,
    stdout: '',
    data: { name, enabled: true },
    stderr: BETA_WARNING,
  };
}

describe('applyEmailSetup', () => {
  it('happy subdomain path: exact provider operations + exact REST calls, bearer in Authorization and nowhere else', async () => {
    const calls: Array<Call> = [];
    const fetchCalls: Array<FetchCall> = [];
    const { inputs } = transcriptInputs({
      calls,
      fetchCalls,
      runnerTable: { 'email sending enable mail.acme.com': sendingEnabled('mail.acme.com') },
      fetchTable: {
        [ROUTING_DNS_POST]: () =>
          jsonResponse(200, { success: true, result: { name: 'mail.acme.com' } }),
        [ROUTING_PATCH]: () =>
          jsonResponse(200, { success: true, result: { support_subaddress: true } }),
      },
    });
    const pre = await preflightEmail(inputs);
    calls.length = 0;
    fetchCalls.length = 0;

    const out = await applyEmailSetup(pre, inputs);
    expect(out.routingReady).toBe(true);
    expect(out.subaddressingReady).toBe(true);
    expect(out.sendingReady).toBe(true);
    expect(out.inboundReady).toBe(true);
    expect(out.patch).toEqual({
      sendEmail: { name: 'SEND_EMAIL' },
      vars: { __VOID_EMAIL_FROM: 'noreply@mail.acme.com' },
      addresses: ['support@mail.acme.com'],
    });
    expect(out.lines).toEqual([
      '  ✔ routing   mail.acme.com enabled',
      '  ✔ routing   subaddressing on for acme.com',
      '  ✔ sending   mail.acme.com onboarded',
      '  ✔ config    void.lock.json updated',
    ]);

    expect(calls.map((c) => c.args)).toEqual([['email', 'sending', 'enable', 'mail.acme.com']]);
    expect(fetchCalls).toEqual([
      {
        url: `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/dns`,
        method: 'POST',
        headers: { Authorization: `Bearer ${BEARER}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'mail.acme.com' }),
      },
      {
        url: `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing`,
        method: 'PATCH',
        headers: { Authorization: `Bearer ${BEARER}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ support_subaddress: true }),
      },
    ]);
    for (const call of fetchCalls) {
      expect(call.url).not.toContain(BEARER);
      expect(call.body).not.toContain(BEARER);
    }
  });

  it('first subdomain setup proceeds when only the apex routing status is misconfigured', async () => {
    const calls: Array<Call> = [];
    const fetchCalls: Array<FetchCall> = [];
    const { inputs } = transcriptInputs({
      calls,
      fetchCalls,
      runnerTable: {
        'email routing settings acme.com': routingSettings(
          'acme.com',
          true,
          'misconfigured',
          ZONE_ID,
        ),
        'email sending enable mail.acme.com': sendingEnabled('mail.acme.com'),
      },
      fetchTable: {
        [ROUTING_DNS_POST]: () =>
          jsonResponse(200, { success: true, result: { name: 'mail.acme.com' } }),
        [ROUTING_PATCH]: () =>
          jsonResponse(200, { success: true, result: { support_subaddress: true } }),
      },
    });
    const pre = await preflightEmail(inputs);
    expect(pre.routing).toEqual({
      state: 'pending',
      status: 'misconfigured',
      enabled: true,
    });
    expect(pre.blockers).toEqual([]);

    calls.length = 0;
    fetchCalls.length = 0;
    const out = await applyEmailSetup(pre, inputs);
    expect(out.routingReady).toBe(true);
    expect(out.inboundReady).toBe(true);
    expect(
      fetchCalls.map((call) => `${call.method} ${call.url.slice(call.url.indexOf('/zones'))}`),
    ).toEqual([ROUTING_DNS_POST, ROUTING_PATCH]);
    expect(calls.map((call) => call.args)).toEqual([
      ['email', 'sending', 'enable', 'mail.acme.com'],
    ]);
  });

  it('apex path: `wrangler email routing enable <apex>`, then the subaddressing PATCH through the bearer', async () => {
    const calls: Array<Call> = [];
    const fetchCalls: Array<FetchCall> = [];
    const { inputs } = transcriptInputs({
      calls,
      fetchCalls,
      from: 'noreply@acme.com',
      dns: fakeDns({}),
      runnerTable: {
        'email routing settings acme.com': routingSettings(
          'acme.com',
          false,
          'unconfigured',
          ZONE_ID,
        ),
        'email sending settings acme.com': sendingNotFound('acme.com'),
        'email routing enable acme.com': {
          status: 0,
          stdout: '',
          data: { name: 'acme.com', enabled: true },
          stderr: BETA_WARNING,
        },
        'email sending enable acme.com': sendingEnabled('acme.com'),
      },
      fetchTable: {
        [ROUTING_PATCH]: () =>
          jsonResponse(200, { success: true, result: { support_subaddress: true } }),
      },
    });
    const pre = await preflightEmail(inputs);
    calls.length = 0;
    fetchCalls.length = 0;
    const out = await applyEmailSetup(pre, inputs);
    expect(calls.map((c) => c.args)).toEqual([
      ['email', 'routing', 'enable', 'acme.com'],
      ['email', 'sending', 'enable', 'acme.com'],
    ]);
    expect(fetchCalls.map((c) => `${c.method} ${c.url.slice(c.url.indexOf('/zones'))}`)).toEqual([
      ROUTING_PATCH,
    ]);
    expect(out.patch.addresses).toEqual(['support@acme.com', '*@acme.com']);
    expect(out.lines[0]).toBe('  ✔ routing   acme.com enabled');
  });

  it('routing enabled but the subaddressing PATCH refused → routingReady, NOT inboundReady; addresses withheld', async () => {
    // The one partial state where `routingReady` is true and inbound is still not set up:
    // the PATCH is a bearer call, so its refusal withholds `addresses` (decision 11) — no
    // rule is created by the next deploy — and `+tag` mail matches no rule until the flag
    // is on. Both callers must read `inboundReady`, not `routingReady`.
    const fetchCalls: Array<FetchCall> = [];
    const { inputs } = transcriptInputs({
      fetchCalls,
      runnerTable: { 'email sending enable mail.acme.com': sendingEnabled('mail.acme.com') },
      fetchTable: {
        [ROUTING_DNS_POST]: () =>
          jsonResponse(200, { success: true, result: { name: 'mail.acme.com' } }),
        [ROUTING_PATCH]: () =>
          jsonResponse(403, {
            success: false,
            errors: [{ code: 10_000, message: 'Authentication error' }],
          }),
      },
    });
    const pre = await preflightEmail(inputs);
    fetchCalls.length = 0;
    const out = await applyEmailSetup(pre, inputs);
    expect(fetchCalls.map((c) => c.method)).toEqual(['POST', 'PATCH']);
    expect(out.routingReady).toBe(true);
    expect(out.subaddressingReady).toBe(false);
    expect(out.sendingReady).toBe(true);
    expect(out.inboundReady).toBe(false);
    expect(out.patch).toEqual({
      sendEmail: { name: 'SEND_EMAIL' },
      vars: { __VOID_EMAIL_FROM: 'noreply@mail.acme.com' },
      addresses: null,
    });
    expect(out.lines).toEqual([
      '  ✔ routing   mail.acme.com enabled',
      '  ✘ routing   subaddressing on acme.com: Cloudflare answered 403 [code: 10000] — Authentication error',
      '    turn it on in the Cloudflare dashboard → acme.com → Email → Settings → Subaddressing',
      '  ✔ sending   mail.acme.com onboarded',
      '  ! config    addresses withheld this run (session-bearer step failed); no routing rule is created for support@mail.acme.com',
      '  ✔ config    void.lock.json updated',
    ]);
  });

  it('bearer failure → dashboard fallback line, addresses withheld (deleted), deploy continues', async () => {
    const calls: Array<Call> = [];
    const { inputs } = transcriptInputs({
      calls,
      getSessionBearer: async () => null,
      runnerTable: { 'email sending enable mail.acme.com': sendingEnabled('mail.acme.com') },
    });
    const pre = await preflightEmail(inputs);
    calls.length = 0;
    const out = await applyEmailSetup(pre, inputs);
    expect(out.routingReady).toBe(false);
    expect(out.inboundReady).toBe(false);
    expect(out.patch.addresses).toBeNull();
    // Sending still onboarded → the binding is still written.
    expect(out.sendingReady).toBe(true);
    expect(out.patch.sendEmail).toEqual({ name: 'SEND_EMAIL' });
    expect(out.lines).toContain(
      '  ✘ routing   mail.acme.com: could not borrow the Cloudflare session (session-bearer step failed)',
    );
    expect(out.lines).toContain(`    ${subdomainDashboardFallback('acme.com', 'mail.acme.com')}`);
    expect(out.lines.some((l) => l.includes('addresses withheld this run'))).toBe(true);
    expect(calls.map((c) => c.args)).toEqual([['email', 'sending', 'enable', 'mail.acme.com']]);
  });

  it('non-2xx on the subdomain POST → fallback line + withheld; the PATCH is not attempted', async () => {
    const fetchCalls: Array<FetchCall> = [];
    const { inputs } = transcriptInputs({
      fetchCalls,
      runnerTable: { 'email sending enable mail.acme.com': sendingEnabled('mail.acme.com') },
      fetchTable: {
        [ROUTING_DNS_POST]: () =>
          jsonResponse(400, {
            success: false,
            errors: [{ code: 2062, message: 'routing not enabled' }],
          }),
      },
    });
    const pre = await preflightEmail(inputs);
    fetchCalls.length = 0;
    const out = await applyEmailSetup(pre, inputs);
    expect(fetchCalls.map((c) => c.method)).toEqual(['POST']);
    expect(out.lines.some((l) => l.includes('addresses withheld this run'))).toBe(true);
    expect(out.inboundReady).toBe(false);
    expect(out.patch.addresses).toBeNull();
    expect(out.lines[0]).toBe(
      '  ✘ routing   mail.acme.com: Cloudflare answered 400 [code: 2062] — Email Routing is not enabled on this zone',
    );
    expect(out.lines[1]).toBe(`    ${subdomainDashboardFallback('acme.com', 'mail.acme.com')}`);
  });

  it('non-2xx on the subdomain POST with a bearer in hand names the failed call, not the bearer', async () => {
    const { inputs } = transcriptInputs({
      runnerTable: { 'email sending enable mail.acme.com': sendingEnabled('mail.acme.com') },
      fetchTable: {
        [ROUTING_DNS_POST]: () =>
          jsonResponse(400, { success: false, errors: [{ code: 2062, message: 'nope' }] }),
      },
    });
    const pre = await preflightEmail(inputs);
    const out = await applyEmailSetup(pre, inputs);
    expect(out.lines).toContain(
      '  ✘ routing   subaddressing on acme.com: skipped (the subdomain routing call failed)',
    );
    expect(out.lines.some((l) => l.includes('session bearer unavailable'))).toBe(false);
  });

  it('never posts the subdomain routing call against an apex whose Email Routing is off', async () => {
    // What `POST …/routing/dns { name }` does on a zone that does not route is unmeasured;
    // the one outcome that matters — enabling the zone and locking MX over the apex's live
    // mail — is what the apex refusal exists to prevent. No call; addresses withheld.
    const calls: Array<Call> = [];
    const fetchCalls: Array<FetchCall> = [];
    const { inputs } = transcriptInputs({
      calls,
      fetchCalls,
      runnerTable: {
        'email routing settings acme.com': routingSettings(
          'acme.com',
          false,
          'unconfigured',
          ZONE_ID,
        ),
        'email sending enable mail.acme.com': sendingEnabled('mail.acme.com'),
      },
    });
    const pre = await preflightEmail(inputs);
    expect(pre.routing).toEqual({ state: 'pending', status: 'unconfigured', enabled: false });
    const checklist = renderEmailChecklist(pre);
    expect(checklist).not.toContain('acme.com itself is not touched');
    expect(checklist).toContain(
      `    ! enable Email Routing on mail.acme.com       Email Routing is not enabled on acme.com; Void never enables it on the apex from the subdomain path — ${subdomainDashboardFallback('acme.com', 'mail.acme.com')}`,
    );
    calls.length = 0;
    fetchCalls.length = 0;
    const out = await applyEmailSetup(pre, inputs);
    expect(fetchCalls).toEqual([]);
    expect(calls.map((c) => c.args)).toEqual([['email', 'sending', 'enable', 'mail.acme.com']]);
    expect(out.routingReady).toBe(false);
    expect(out.subaddressingReady).toBe(false);
    expect(out.inboundReady).toBe(false);
    expect(out.patch.addresses).toBeNull();
    expect(out.lines).toEqual([
      '  ✘ routing   mail.acme.com: Email Routing is not enabled on acme.com — a subdomain can only be added to a zone that already routes; Void never enables routing on the apex from the subdomain path',
      `    ${subdomainDashboardFallback('acme.com', 'mail.acme.com')}`,
      '  ✘ routing   subaddressing on acme.com: skipped (Email Routing is not enabled on acme.com)',
      '  ✔ sending   mail.acme.com onboarded',
      '  ! config    addresses withheld this run (routing not ready); no routing rule is created for support@mail.acme.com',
      '  ✔ config    void.lock.json updated',
    ]);
  });

  it('`[code: 2040]` on sending enable means already onboarded → ok', async () => {
    const { inputs } = transcriptInputs({
      runnerTable: {
        'email sending enable mail.acme.com': apiFailure(
          2040,
          `/zones/${ZONE_ID}/email/sending/subdomains`,
        ),
      },
      fetchTable: {
        [ROUTING_DNS_POST]: () => jsonResponse(200, { success: true, result: {} }),
        [ROUTING_PATCH]: () => jsonResponse(200, { success: true, result: {} }),
      },
    });
    const pre = await preflightEmail(inputs);
    const out = await applyEmailSetup(pre, inputs);
    expect(out.sendingReady).toBe(true);
    expect(out.lines).toContain('  ✔ sending   mail.acme.com onboarded');
    expect(out.patch.sendEmail).toEqual({ name: 'SEND_EMAIL' });
  });

  it('sending enable fails on Workers Free (10105) → hint line, continue with inbound', async () => {
    const { inputs } = transcriptInputs({
      runnerTable: {
        'email sending enable mail.acme.com': apiFailure(
          10_105,
          `/zones/${ZONE_ID}/email/sending/subdomains`,
        ),
      },
      fetchTable: {
        [ROUTING_DNS_POST]: () => jsonResponse(200, { success: true, result: {} }),
        [ROUTING_PATCH]: () => jsonResponse(200, { success: true, result: {} }),
      },
    });
    const pre = await preflightEmail(inputs);
    const out = await applyEmailSetup(pre, inputs);
    expect(out.sendingReady).toBe(false);
    expect(out.routingReady).toBe(true);
    expect(out.lines).toContain(
      '  ! sending   mail.acme.com not onboarded [code: 10105] — account is not entitled to Email Sending',
    );
    expect(out.lines).toContain(`    ${SENDING_FREE_PLAN_HINT}`);
    expect(out.patch).toEqual({
      sendEmail: { name: 'SEND_EMAIL' },
      vars: { __VOID_EMAIL_FROM: 'noreply@mail.acme.com' },
      addresses: ['support@mail.acme.com'],
    });

    // Round trip: the patch that refused run writes, fed back into the next preflight against
    // the account it left behind (routing + subaddressing on, sending still not-found), reads
    // ready — the binding is the memory of the refusal — with the retry on offer for `setup`.
    const next = await preflightEmail(
      transcriptInputs({
        runnerTable: {
          'email routing rules list acme.com': {
            status: 0,
            stdout: '',
            data: routingRules({ supportDomain: 'mail.acme.com' }),
            stderr: BETA_WARNING,
          },
        },
        fetchTable: { [`GET /zones/${ZONE_ID}/email/routing`]: routingGet(true) },
        dns: fakeDns({
          mx: {
            'acme.com': ['aspmx.l.google.com'],
            'mail.acme.com': ['route1.mx.cloudflare.net'],
          },
        }),
        existingSendEmail: [out.patch.sendEmail!],
        existingAddresses: out.patch.addresses,
        existingVars: out.patch.vars,
      }).inputs,
    );
    expect(next.sending.state).toBe('pending');
    expect(next.ready).toBe(true);
    expect(next.sendingRetryable).toBe(true);
    expect(next.addressesStale).toBe(false);
    expect(next.sender.state).toBe('ready');
  });

  it('a sending-scoped blocker (DMARC present) skips sending enable, routing still applies', async () => {
    const calls: Array<Call> = [];
    const { inputs } = transcriptInputs({
      calls,
      dns: fakeDns({
        mx: { 'acme.com': ['aspmx.l.google.com'] },
        txt: { '_dmarc.mail.acme.com': ['v=DMARC1'] },
      }),
      fetchTable: {
        [ROUTING_DNS_POST]: () => jsonResponse(200, { success: true, result: {} }),
        [ROUTING_PATCH]: () => jsonResponse(200, { success: true, result: {} }),
      },
    });
    const pre = await preflightEmail(inputs);
    calls.length = 0;
    const out = await applyEmailSetup(pre, inputs);
    expect(calls).toEqual([]);
    expect(out.sendingReady).toBe(false);
    expect(out.routingReady).toBe(true);
    expect(
      out.lines.some((l) => l.startsWith('  ! sending   _dmarc.mail.acme.com already exists')),
    ).toBe(true);
  });

  it('re-run with everything ready → zero wrangler calls, zero fetches, same patch', async () => {
    const calls: Array<Call> = [];
    const fetchCalls: Array<FetchCall> = [];
    const { inputs } = readyAccount({ calls, fetchCalls });
    const pre = await preflightEmail(inputs);
    expect(pre.ready).toBe(true);
    calls.length = 0;
    fetchCalls.length = 0;
    const out = await applyEmailSetup(pre, inputs);
    expect(calls).toEqual([]);
    expect(fetchCalls).toEqual([]);
    expect(out.patch).toEqual({
      sendEmail: { name: 'SEND_EMAIL' },
      vars: { __VOID_EMAIL_FROM: 'noreply@mail.acme.com' },
      addresses: ['support@mail.acme.com'],
    });
  });

  it('a blocked preflight applies nothing and returns an empty patch', async () => {
    const calls: Array<Call> = [];
    const fetchCalls: Array<FetchCall> = [];
    const { inputs } = transcriptInputs({
      calls,
      fetchCalls,
      existingSendEmail: [{ name: 'EMAIL' }],
    });
    const pre = await preflightEmail(inputs);
    calls.length = 0;
    fetchCalls.length = 0;
    const out = await applyEmailSetup(pre, inputs);
    expect(calls).toEqual([]);
    expect(fetchCalls).toEqual([]);
    expect(out.patch).toEqual({});
    expect(out.lines[0]).toContain('✘ Cloudflare config already has a send_email binding');
  });

  it('never surfaces the bearer in a printed line, a thrown error, or the returned object', async () => {
    // Every transport outcome that could carry the token: a fetch that throws with it in
    // the message, a non-2xx whose error message echoes it, and a happy path.
    const leaky = (call: FetchCall): Response => {
      throw new Error(`boom ${call.headers.Authorization}`);
    };
    const echo = () =>
      jsonResponse(403, {
        success: false,
        errors: [{ code: 10_000, message: `bad token Bearer ${BEARER}` }],
      });
    const tables: Array<Record<string, (call: FetchCall) => Response>> = [
      { [ROUTING_DNS_POST]: leaky },
      { [ROUTING_DNS_POST]: echo },
      {
        [ROUTING_DNS_POST]: () => jsonResponse(200, { success: true, result: {} }),
        [ROUTING_PATCH]: leaky,
      },
    ];
    for (const table of tables) {
      const { inputs } = transcriptInputs({
        runnerTable: { 'email sending enable mail.acme.com': sendingEnabled('mail.acme.com') },
        fetchTable: table,
      });
      const pre = await preflightEmail(inputs);
      let out: unknown;
      let thrown: unknown;
      try {
        out = await applyEmailSetup(pre, inputs);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeUndefined();
      const serialised = JSON.stringify(out);
      // The fakes echo the header back on purpose; `fetchWithSessionBearer` scrubs it.
      for (const line of (out as { lines: Array<string> }).lines) {
        expect(line).not.toContain(BEARER);
      }
      expect(serialised).not.toContain(BEARER);
      expect(JSON.stringify(pre)).not.toContain(BEARER);
    }
  });
});

describe('findEmailConfigConflicts', () => {
  it('names a cross-type owner of either name, and a malformed target field', () => {
    expect(findEmailConfigConflicts({})).toEqual([]);
    expect(findEmailConfigConflicts({ send_email: [{ name: 'SEND_EMAIL' }] })).toEqual([]);
    expect(
      findEmailConfigConflicts({ kv_namespaces: [{ binding: 'SEND_EMAIL', id: 'x' }] }),
    ).toEqual([
      'Cloudflare config already uses SEND_EMAIL as a KV Namespace binding; rename it in void.config.ts (Void writes SEND_EMAIL into send_email)',
    ]);
    expect(
      findEmailConfigConflicts({ kv_namespaces: [{ binding: '__VOID_EMAIL_FROM', id: 'x' }] }),
    ).toEqual([
      'Cloudflare config already uses __VOID_EMAIL_FROM as a KV Namespace binding; rename it in void.config.ts (Void writes __VOID_EMAIL_FROM into vars)',
    ]);
    expect(findEmailConfigConflicts({ send_email: { name: 'SEND_EMAIL' } })).toEqual([
      expect.stringContaining('"send_email"'),
    ]);
    expect(findEmailConfigConflicts({ vars: 'oops' })).toEqual([expect.stringContaining('"vars"')]);
  });
});

describe('fetchWithSessionBearer', () => {
  it('puts the token only in the Authorization header and never throws', async () => {
    const fetchCalls: Array<FetchCall> = [];
    const f = fakeFetch({ 'GET /zones?name=acme.com': zonesOk('acme.com') }, fetchCalls);
    const ok = await fetchWithSessionBearer(f, BEARER, 'GET', '/zones?name=acme.com');
    expect(ok.ok).toBe(true);
    expect(ok.status).toBe(200);
    expect(fetchCalls[0]?.headers).toEqual({ Authorization: `Bearer ${BEARER}` });
    expect(fetchCalls[0]?.body).toBeUndefined();

    const boom = await fetchWithSessionBearer(
      (async () => {
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch,
      BEARER,
      'POST',
      '/zones/x/email/routing/dns',
      { name: 'x' },
    );
    expect(boom).toEqual({
      ok: false,
      status: 0,
      result: null,
      errors: [{ code: 0, message: 'ECONNRESET' }],
    });

    const html = await fetchWithSessionBearer(
      (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch,
      BEARER,
      'GET',
      '/zones',
    );
    expect(html).toEqual({ ok: false, status: 502, result: null, errors: [] });
  });

  it('honours a custom API base (the pinned transport)', async () => {
    const fetchCalls: Array<FetchCall> = [];
    const f = fakeFetch({ 'GET /zones?name=acme.com': zonesOk('acme.com') }, fetchCalls);
    await fetchWithSessionBearer(
      f,
      BEARER,
      'GET',
      '/zones?name=acme.com',
      undefined,
      'https://api.example.test/v4',
    );
    expect(fetchCalls[0]?.url).toBe('https://api.example.test/v4/zones?name=acme.com');
  });
});

// ── Address map ──────────────────────────────────────────────────────────────────

describe('renderAddressMap', () => {
  it('renders the post-deploy block', () => {
    expect(
      renderAddressMap({
        from: 'support@mail.acme.com',
        routes: [{ address: 'support@mail.acme.com', handler: 'email/support+[ticket].ts' }],
        addresses: ['support@mail.acme.com'],
        sendingReady: true,
      }),
    ).toBe(
      [
        '    inbound   support@mail.acme.com  →  email/support+[ticket].ts',
        '    outbound  sendEmail() from support@mail.acme.com',
      ].join('\n'),
    );
  });

  it('marks routes outside the written addresses and a sending that is not onboarded', () => {
    const text = renderAddressMap({
      from: 'noreply@acme.com',
      routes: [
        { address: 'support@acme.com', handler: 'email/support.ts' },
        { address: '*@acme.com', handler: 'email/_default.ts' },
      ],
      addresses: ['support@acme.com'],
      sendingReady: false,
    });
    expect(text).toBe(
      [
        '    inbound   support@acme.com  →  email/support.ts',
        '    inbound   *@acme.com        →  email/_default.ts   (no rule this deploy)',
        '    outbound  sendEmail() from noreply@acme.com   (verified destinations only)',
      ].join('\n'),
    );
  });

  it('does not promise verified destinations to a sending-only app that is not onboarded', () => {
    expect(
      renderAddressMap({
        from: 'noreply@acme.com',
        routes: [],
        addresses: [],
        sendingReady: false,
        sendingOnly: true,
      }),
    ).toBe('    outbound  sendEmail() from noreply@acme.com   (Email Sending not onboarded)');
  });

  it('marks a written address whose rule this deploy creates', () => {
    const text = renderAddressMap({
      from: 'noreply@acme.com',
      routes: [
        { address: 'support@acme.com', handler: 'email/support.ts' },
        { address: 'sales@acme.com', handler: 'email/sales.ts' },
      ],
      addresses: ['support@acme.com', 'sales@acme.com'],
      sendingReady: true,
      creating: ['sales@acme.com'],
    });
    expect(text).toBe(
      [
        '    inbound   support@acme.com  →  email/support.ts',
        '    inbound   sales@acme.com    →  email/sales.ts   (rule created by this deploy)',
        '    outbound  sendEmail() from noreply@acme.com',
      ].join('\n'),
    );
  });

  it('takes a pending label that does not name a deploy (`void email status`)', () => {
    const text = renderAddressMap({
      from: 'noreply@acme.com',
      routes: [{ address: 'support@acme.com', handler: 'email/support.ts' }],
      addresses: [],
      sendingReady: true,
      pendingLabel: '(no rule yet)',
    });
    expect(text).toBe(
      [
        '    inbound   support@acme.com  →  email/support.ts   (no rule yet)',
        '    outbound  sendEmail() from noreply@acme.com',
      ].join('\n'),
    );
  });
});
