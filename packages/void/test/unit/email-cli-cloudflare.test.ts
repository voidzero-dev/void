import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudflareOperation } from '@void/deploy-cloudflare';
import { log } from '@voidzero-dev/vite-plus-prompts';
import { toSlash } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { MockInstance } from 'vite-plus/test';
import { SENDING_FREE_PLAN_HINT } from '../../src/cli/email-cloudflare.ts';
import type { EmailDns, EmailWranglerRunResult } from '../../src/cli/email-cloudflare.ts';
import { runEmailCloudflareCommand, runEmailCommand } from '../../src/cli/email.ts';
// oxlint-disable-next-line import/no-namespace -- The test replaces or spies on members of the module object.
import * as terminalOutput from '../../src/cli/output.ts';

/**
 * `void email setup|status --platform cloudflare` on a sample project:
 * `email/support+[ticket].ts` + `email/_default.ts`, `email.from = noreply@mail.acme.com`,
 * zone `acme.com` (routing ready on the apex, Google MX there), nothing on `mail.acme.com`.
 * Every Cloudflare touch is a fake returning structured account data.
 */

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

const ZONE_ID = '5b66f5cb84fd7dcfdd0170515e622181';
const ACCOUNT = 'f721b8e5f721b8e5f721b8e5f721b8e5';
const BEARER = 'cfoa-SECRET-BEARER-TOKEN-0123456789';
const BETA_WARNING = '▲ [WARNING] 🚧 `wrangler email x` is an open beta command.\n';

function routingSettings(name: string, status: string, enabled = true): EmailWranglerRunResult {
  return {
    status: 0,
    stdout: '',
    data: { name, enabled, status, tag: ZONE_ID },
    stderr: BETA_WARNING,
  };
}

function zoneNotFound(_name: string): EmailWranglerRunResult {
  return { status: 0, stdout: '', stderr: '', data: null };
}

function sendingNotFound(_name: string): EmailWranglerRunResult {
  return { status: 0, stdout: '', stderr: '', data: null };
}

function sendingEnabled(name: string): EmailWranglerRunResult {
  return {
    status: 0,
    stdout: '',
    data: { name, enabled: true },
    stderr: '',
  };
}

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
type FetchCall = { url: string; method: string; headers: Record<string, string>; body?: string };

function fakeRunner(table: Record<string, EmailWranglerRunResult>, calls: Array<Call>) {
  return (operation: CloudflareOperation, opts: { capture: boolean }): EmailWranglerRunResult => {
    const args = operationWords(operation);
    calls.push({ args, operation, capture: opts.capture });
    // Key the table on command words; config context is asserted separately.
    const configIndex = args.indexOf('-c');
    const envIndex = args.indexOf('--env=');
    const suffixIndex = configIndex >= 0 ? configIndex : envIndex >= 0 ? envIndex : args.length;
    const key = args.slice(0, suffixIndex).join(' ');
    const hit = table[key];
    if (!hit) {
      throw new Error(`unexpected wrangler call: ${args.join(' ')}`);
    }
    return hit;
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(table: Record<string, () => Response>, calls: Array<FetchCall>): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
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
    const key = `${call.method} ${url.slice(url.indexOf('/zones'))}`;
    const hit = table[key];
    if (!hit) {
      throw new Error(`unexpected fetch: ${key}`);
    }
    return hit();
  };
}

function fakeDns(mx: Record<string, Array<string>>): EmailDns {
  const noData = (): Error => Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
  return {
    resolveMx: async (name) => {
      const list = mx[name];
      if (!list) {
        throw noData();
      }
      return list.map((exchange, i) => ({ exchange, priority: (i + 1) * 10 }));
    },
    resolveTxt: async () => {
      throw noData();
    },
  };
}

/** Capture progress and the final verdict separately from checklist blocks. */
function captureLog(): { lines: Array<string>; restore: () => void } {
  const lines: Array<string> = [];
  const spies = (['message', 'info', 'warn', 'error', 'success', 'step'] as const).map((level) =>
    vi.spyOn(log, level).mockImplementation((...args: Array<unknown>) => {
      lines.push(args.map(String).join(' '));
    }),
  );
  const success = vi.spyOn(terminalOutput, 'printSuccess').mockImplementation((message) => {
    lines.push(message);
  });
  return {
    lines,
    restore: () => {
      success.mockRestore();
      for (const spy of spies) {
        spy.mockRestore();
      }
    },
  };
}

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/** Run the command; resolve the exit code (0 when it returned without exiting). */
async function run(
  root: string,
  subcommand: 'setup' | 'status',
  deps: Parameters<typeof runEmailCloudflareCommand>[2],
): Promise<number> {
  try {
    await runEmailCloudflareCommand(
      root,
      { subcommand, platform: 'cloudflare' },
      {
        ...deps,
        exit: (code: number): never => {
          throw new ExitSignal(code);
        },
      },
    );
    return 0;
  } catch (err) {
    if (err instanceof ExitSignal) {
      return err.code;
    }
    throw err;
  }
}

const INITIAL_WRANGLER = `{
  // the pinned account
  "account_id": "${ACCOUNT}",
  "name": "acme-support",
  "compatibility_date": "2026-01-01",
}
`;

function makeProject(overrides: { from?: string; wrangler?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'void-email-cli-'));
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify({ email: { from: overrides.from ?? 'noreply@mail.acme.com' } }),
  );
  writeFileSync(join(root, 'wrangler.jsonc'), overrides.wrangler ?? INITIAL_WRANGLER);
  mkdirSync(join(root, 'email'));
  writeFileSync(join(root, 'email', 'support+[ticket].ts'), 'export default () => {};\n');
  writeFileSync(join(root, 'email', '_default.ts'), 'export default () => {};\n');
  return root;
}

/** The sample project's fakes, with the apply-side entries overridable. */
function transcriptDeps(
  extra: {
    runnerTable?: Record<string, EmailWranglerRunResult>;
    fetchTable?: Record<string, () => Response>;
    mx?: Record<string, Array<string>>;
  } = {},
) {
  const calls: Array<Call> = [];
  const fetchCalls: Array<FetchCall> = [];
  const printed: Array<string> = [];
  const runnerTable: Record<string, EmailWranglerRunResult> = {
    'whoami --json': whoamiResult(),
    'email routing settings mail.acme.com': zoneNotFound('mail.acme.com'),
    'email routing settings acme.com': routingSettings('acme.com', 'ready'),
    'email routing rules list acme.com': { status: 0, stdout: '', data: emptyRules, stderr: '' },
    'email sending settings mail.acme.com': sendingNotFound('mail.acme.com'),
    ...extra.runnerTable,
  };
  const fetchTable: Record<string, () => Response> = {
    'GET /zones?name=acme.com': () =>
      jsonResponse(200, {
        success: true,
        result: [{ id: ZONE_ID, name: 'acme.com', type: 'full', account: { id: ACCOUNT } }],
      }),
    [`GET /zones/${ZONE_ID}/email/routing`]: () =>
      jsonResponse(200, { success: true, result: { enabled: true, support_subaddress: false } }),
    ...extra.fetchTable,
  };
  const deps = {
    runWrangler: fakeRunner(runnerTable, calls),
    getSessionBearer: async () => BEARER,
    fetchImpl: fakeFetch(fetchTable, fetchCalls),
    dns: fakeDns(extra.mx ?? { 'acme.com': ['aspmx.l.google.com'] }),
    print: (block: string) => {
      printed.push(block);
    },
  };
  return { deps, calls, fetchCalls, printed };
}

function readJsonc(path: string): Record<string, unknown> {
  // The writer preserves the comment; strip it for the structural assertion.
  const text = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .replaceAll(/,(\s*[}\]])/g, '$1');
  return JSON.parse(text) as Record<string, unknown>;
}

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Workers Free AFTER a `setup` that was refused Email Sending: the binding, `addresses`
 * and the sender var are committed, routing + subaddressing are on, the rule exists, and
 * `sending settings` still answers not-found — the same answer a Paid account that never
 * onboarded gives. The committed binding is the memory of the refusal (`preflightEmail`),
 * so every row reads ready; the onboarding is the one retry `setup` offers on its own
 * prompt, and the state `status` must call set up.
 */
function freeAfterSetup(extra: { runnerTable?: Record<string, EmailWranglerRunResult> } = {}) {
  const root = makeProject({
    wrangler: `{
  "account_id": "${ACCOUNT}",
  "name": "acme-support",
  "send_email": [{ "name": "SEND_EMAIL" }],
  "addresses": ["support@mail.acme.com"],
  "vars": { "__VOID_EMAIL_FROM": "noreply@mail.acme.com" },
}
`,
  });
  roots.push(root);
  const fakes = transcriptDeps({
    runnerTable: {
      'email routing rules list acme.com': {
        status: 0,
        stdout: '',
        data: [
          {
            id: '1a2b3c',
            name: 'support',
            enabled: true,
            matchers: [{ type: 'literal', field: 'to', value: 'support@mail.acme.com' }],
            actions: [{ type: 'worker', value: ['acme-support'] }],
          },
          { enabled: false, matchers: [{ type: 'all' }], actions: [{ type: 'drop' }] },
        ],
        stderr: BETA_WARNING,
      },
      ...extra.runnerTable,
    },
    fetchTable: {
      [`GET /zones/${ZONE_ID}/email/routing`]: () =>
        jsonResponse(200, { success: true, result: { enabled: true, support_subaddress: true } }),
    },
    mx: { 'acme.com': ['aspmx.l.google.com'], 'mail.acme.com': ['route1.mx.cloudflare.net'] },
  });
  return { root, configPath: join(root, 'wrangler.jsonc'), ...fakes };
}
const RETRY_PROMPT =
  'Onboard mail.acme.com for Email Sending? Inbound already works; onboarding needs Workers Paid.';
const sendingRefused: EmailWranglerRunResult = {
  status: 1,
  stdout: '',
  data: '',
  stderr: `${BETA_WARNING}✘ [ERROR] A request to the Cloudflare API (/zones/${ZONE_ID}/email/sending/subdomains) failed.\n\n  something went wrong [code: 10105]\n`,
  errorCode: 10_105,
};
const sendingOnboarded: EmailWranglerRunResult = {
  status: 0,
  stdout: '',
  data: { name: 'mail.acme.com', enabled: true, tag: ZONE_ID },
  stderr: BETA_WARNING,
};
/** Sending-only apps read and onboard Email Sending through the bearer on the resolved zone. */
const SENDING_SUBDOMAINS = `/zones/${ZONE_ID}/email/sending/subdomains`;
const subdomainsListed = (names: Array<string>) => () =>
  jsonResponse(200, {
    success: true,
    result: names.map((name) => ({ name, enabled: true, tag: '19af4fdbee924a92916afea0de5a8fdd' })),
  });
const sendingRefusedByApi = () =>
  jsonResponse(403, {
    success: false,
    errors: [{ code: 10_105, message: 'email.sending.error.authentication.not_entitled' }],
    result: null,
  });

describe('sending-only email setup and status', () => {
  it.each(['setup', 'status'] as const)(
    '%s succeeds without inbound configuration or prompts',
    async (command) => {
      const root = makeProject({
        wrangler: JSON.stringify({
          account_id: ACCOUNT,
          name: 'acme-support',
          send_email: [{ name: 'SEND_EMAIL' }],
          vars: { __VOID_EMAIL_FROM: 'noreply@mail.acme.com' },
        }),
      });
      roots.push(root);
      rmSync(join(root, 'email'), { recursive: true });
      const { deps, calls, fetchCalls, printed } = transcriptDeps({
        fetchTable: {
          'GET /zones?name=mail.acme.com': () => jsonResponse(200, { success: true, result: [] }),
          [`GET ${SENDING_SUBDOMAINS}`]: subdomainsListed(['mail.acme.com']),
        },
      });
      const code = await run(root, command, {
        ...deps,
        isInteractive: false,
        confirm: async () => {
          throw new Error('Sending is already configured');
        },
      });
      expect(code).toBe(0);
      expect(printed.join('\n')).toContain('inbound   not required');
      expect(printed.join('\n')).not.toContain('enable Email Routing');
      expect(calls.some(({ operation }) => operation.type.startsWith('email.'))).toBe(false);
      expect(
        fetchCalls.every(({ method, url }) => method === 'GET' && !url.includes('/email/routing')),
      ).toBe(true);
      const config = readJsonc(join(root, 'wrangler.jsonc'));
      expect(config.addresses).toBeUndefined();
      expect(config.send_email).toEqual([{ name: 'SEND_EMAIL' }]);
    },
  );

  /** A sending-only app set up earlier (binding saved) whose domain is not onboarded. */
  function savedSendingOnly(extra: { fetchTable?: Record<string, () => Response> } = {}) {
    const root = makeProject({
      wrangler: JSON.stringify({
        account_id: ACCOUNT,
        name: 'acme-support',
        send_email: [{ name: 'SEND_EMAIL' }],
        vars: { __VOID_EMAIL_FROM: 'noreply@mail.acme.com' },
      }),
    });
    roots.push(root);
    rmSync(join(root, 'email'), { recursive: true });
    const fakes = transcriptDeps({
      fetchTable: {
        'GET /zones?name=mail.acme.com': () => jsonResponse(200, { success: true, result: [] }),
        [`GET ${SENDING_SUBDOMAINS}`]: subdomainsListed([]),
        ...extra.fetchTable,
      },
    });
    return { root, configPath: join(root, 'wrangler.jsonc'), ...fakes };
  }

  it('status names Workers Paid, its link and the token permissions, and exits 1', async () => {
    const { root, deps, calls, fetchCalls, printed } = savedSendingOnly();
    const logged = captureLog();
    let code: number;
    try {
      code = await run(root, 'status', { ...deps, isInteractive: false });
    } finally {
      logged.restore();
    }
    expect(code).toBe(1);
    expect(printed[0]).toContain(
      'sending   mail.acme.com  not onboarded — needs Workers Paid; after upgrading run void email setup --platform cloudflare',
    );
    expect(printed.at(-1)).toBe(
      '    outbound  sendEmail() from noreply@mail.acme.com   (Email Sending not onboarded)',
    );
    const warned = logged.lines.join('\n');
    expect(warned).toContain(
      'Enable Workers Paid: https://dash.cloudflare.com/?to=/:account/workers/plans',
    );
    expect(warned).toContain('Zone Read + Email Sending Edit');
    expect(warned).not.toContain('Email is not set up');
    expect(calls.some(({ operation }) => operation.type.startsWith('email.'))).toBe(false);
    expect(fetchCalls.some(({ method }) => method === 'POST')).toBe(false);
  });

  it('setup asks to onboard Email Sending; a refusal prints the Workers Paid steps and exits 1', async () => {
    const { root, configPath, deps, calls, fetchCalls, printed } = savedSendingOnly({
      fetchTable: { [`POST ${SENDING_SUBDOMAINS}`]: sendingRefusedByApi },
    });
    const before = readFileSync(configPath, 'utf8');
    const confirms: Array<string> = [];
    const logged = captureLog();
    let code: number;
    try {
      code = await run(root, 'setup', {
        ...deps,
        isInteractive: true,
        confirm: async (message) => {
          confirms.push(message);
          return true;
        },
      });
    } finally {
      logged.restore();
    }
    expect(code).toBe(1);
    expect(confirms).toEqual([
      'Onboard mail.acme.com for Email Sending? Sending-only apps need Workers Paid.',
    ]);
    expect(calls.some(({ operation }) => operation.type.startsWith('email.'))).toBe(false);
    expect(
      fetchCalls
        .filter(({ method }) => method === 'POST')
        .map(({ url, body }) => [url.slice(url.indexOf('/zones')), body]),
    ).toEqual([[SENDING_SUBDOMAINS, JSON.stringify({ name: 'mail.acme.com' })]]);
    const output = printed.join('\n');
    expect(output).toContain('[code: 10105]');
    expect(output).toContain(
      'Enable Workers Paid: https://dash.cloudflare.com/?to=/:account/workers/plans',
    );
    expect(output).toContain('Zone Read + Email Sending Edit');
    expect(output).not.toContain('verified destinations only');
    expect(logged.lines.join('\n')).toContain('Follow the Workers Paid steps above.');
    // The saved binding and sender stay as they were.
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });
});

describe('void email setup --platform cloudflare', () => {
  it('first run: checklist, one confirm, exact provider operations + REST calls, wrangler.jsonc written', async () => {
    const root = makeProject();
    roots.push(root);
    const configPath = join(root, 'wrangler.jsonc');
    const { deps, calls, fetchCalls, printed } = transcriptDeps({
      runnerTable: { 'email sending enable mail.acme.com': sendingEnabled('mail.acme.com') },
      fetchTable: {
        [`POST /zones/${ZONE_ID}/email/routing/dns`]: () =>
          jsonResponse(200, { success: true, result: { name: 'mail.acme.com' } }),
        [`PATCH /zones/${ZONE_ID}/email/routing`]: () =>
          jsonResponse(200, { success: true, result: { support_subaddress: true } }),
      },
    });
    const confirms: Array<string> = [];

    const code = await run(root, 'setup', {
      ...deps,
      isInteractive: true,
      confirm: async (message) => {
        confirms.push(message);
        return true;
      },
    });

    expect(code).toBe(0);
    expect(confirms).toEqual(['Set up email on mail.acme.com?']);

    // Every provider operation carries the deploy's config pin; the writes come after the reads.
    expect(calls.map((c) => c.args)).toEqual([
      ['whoami', '--json'],
      ['email', 'routing', 'settings', 'mail.acme.com'],
      ['email', 'routing', 'settings', 'acme.com'],
      ['email', 'routing', 'rules', 'list', 'acme.com'],
      ['email', 'sending', 'settings', 'mail.acme.com'],
      ['email', 'sending', 'enable', 'mail.acme.com'],
    ]);
    expect(calls.every((c) => c.capture)).toBe(true);
    expect(calls.every((c) => c.operation.configPath === toSlash(configPath))).toBe(true);
    expect(fetchCalls.map((c) => `${c.method} ${c.url.slice(c.url.indexOf('/zones'))}`)).toEqual([
      'GET /zones?name=acme.com',
      `GET /zones/${ZONE_ID}/email/routing`,
      `POST /zones/${ZONE_ID}/email/routing/dns`,
      `PATCH /zones/${ZONE_ID}/email/routing`,
    ]);
    for (const call of fetchCalls) {
      expect(call.headers.Authorization).toBe(`Bearer ${BEARER}`);
      expect(call.url).not.toContain(BEARER);
    }

    // The root config: binding + addresses + sender var, comment and siblings intact.
    const written = readFileSync(configPath, 'utf8');
    expect(written).toContain('// the pinned account');
    expect(readJsonc(configPath)).toEqual({
      account_id: ACCOUNT,
      name: 'acme-support',
      compatibility_date: '2026-01-01',
      send_email: [{ name: 'SEND_EMAIL' }],
      addresses: ['support@mail.acme.com'],
      vars: { __VOID_EMAIL_FROM: 'noreply@mail.acme.com' },
    });

    // The checklist came before the prompt; the ✔ rows and the address map after.
    const output = printed.join('\n');
    expect(printed[0]).toContain('Email in use   email/support+[ticket].ts · email/_default.ts');
    expect(printed[0]).toContain('+ enable Email Routing on mail.acme.com');
    expect(printed[0]).toContain('! email/_default.ts');
    expect(output).toContain('✔ routing   mail.acme.com enabled');
    expect(output).toContain('✔ sending   mail.acme.com onboarded');
    expect(output).toContain('✔ config    void.lock.json updated');
    expect(printed.at(-1)).toBe(
      [
        '    inbound   support@mail.acme.com  →  email/support+[ticket].ts',
        '    outbound  sendEmail() from noreply@mail.acme.com',
      ].join('\n'),
    );
    for (const block of printed) {
      expect(block).not.toContain(BEARER);
    }
  });

  it('declined: nothing is written or called after the checklist', async () => {
    const root = makeProject();
    roots.push(root);
    const before = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
    const { deps, calls, fetchCalls } = transcriptDeps();

    const code = await run(root, 'setup', {
      ...deps,
      isInteractive: true,
      confirm: async () => false,
    });

    expect(code).toBe(0);
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).toBe(before);
    expect(calls.map((c) => c.args[0])).toEqual(['whoami', 'email', 'email', 'email', 'email']);
    expect(calls.some((c) => c.args.includes('enable'))).toBe(false);
    expect(fetchCalls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('non-interactive and not ready: checklist, exit 1, no writes (CI cannot press Enter)', async () => {
    const root = makeProject();
    roots.push(root);
    const before = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
    const { deps, calls, fetchCalls, printed } = transcriptDeps();
    const confirm = vi.fn(async () => true);

    const code = await run(root, 'setup', { ...deps, isInteractive: false, confirm });

    expect(code).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(printed[0]).toContain(
      'This changes YOUR Cloudflare account. acme.com itself is not touched.',
    );
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).toBe(before);
    expect(calls.some((c) => c.args.includes('enable'))).toBe(false);
    expect(fetchCalls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('an `all` blocker (foreign MX on the apex path) exits 1 without a prompt', async () => {
    const root = makeProject({ from: 'noreply@acme.com' });
    roots.push(root);
    const { deps, calls, fetchCalls, printed } = transcriptDeps({
      runnerTable: {
        'email routing settings acme.com': routingSettings('acme.com', 'unconfigured', false),
        'email sending settings acme.com': sendingNotFound('acme.com'),
      },
    });
    const confirm = vi.fn(async () => true);

    const code = await run(root, 'setup', { ...deps, isInteractive: true, confirm });

    expect(code).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(printed[0]).toContain(
      '✘ acme.com already receives mail (aspmx.l.google.com). Void never enables routing over live mail. Use something@mail.acme.com.',
    );
    expect(calls.some((c) => c.args.includes('enable'))).toBe(false);
    expect(fetchCalls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('routing came up but the subaddressing PATCH was refused: exit 1, subaddressing named, addresses withheld', async () => {
    // The apex path: `wrangler email routing enable acme.com` succeeds, then the bearer
    // PATCH `{ support_subaddress: true }` is refused. `addresses` is withheld (no bearer
    // call may fail, decision 11), so the next deploy creates NO rule, and until the flag
    // is on `support+T-42@` matches no rule for `support@` either. Routing alone is not
    // "set up": the exit and the verdict line must say what is missing and to rerun.
    const root = makeProject({ from: 'noreply@acme.com' });
    roots.push(root);
    const configPath = join(root, 'wrangler.jsonc');
    const { deps, calls, fetchCalls, printed } = transcriptDeps({
      runnerTable: {
        'email routing settings acme.com': routingSettings('acme.com', 'unconfigured', false),
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
        [`PATCH /zones/${ZONE_ID}/email/routing`]: () =>
          jsonResponse(403, {
            success: false,
            errors: [{ code: 10_000, message: 'Authentication error' }],
          }),
      },
      mx: {},
    });
    const logged = captureLog();
    let code: number;
    try {
      code = await run(root, 'setup', { ...deps, isInteractive: true, confirm: async () => true });
    } finally {
      logged.restore();
    }

    expect(code).toBe(1);
    expect(calls.map((c) => c.args.slice(0, 4))).toContainEqual([
      'email',
      'routing',
      'enable',
      'acme.com',
    ]);
    expect(fetchCalls.map((c) => c.method)).toEqual(['GET', 'GET', 'PATCH']);
    const output = printed.join('\n');
    expect(output).toContain('✔ routing   acme.com enabled');
    expect(output).toContain(
      '✘ routing   subaddressing on acme.com: Cloudflare answered 403 [code: 10000] — Authentication error',
    );
    expect(output).toContain('addresses withheld this run (session-bearer step failed)');
    // Routing DID come up, so the binding + sender var are written; `addresses` is not.
    const config = readJsonc(configPath);
    expect(config.send_email).toEqual([{ name: 'SEND_EMAIL' }]);
    expect(config.vars).toEqual({ __VOID_EMAIL_FROM: 'noreply@acme.com' });
    expect(config.addresses).toBeUndefined();
    // The verdict: not "set up" — what is missing, and the rerun.
    const verdict = logged.lines.join('\n');
    expect(verdict).not.toContain('Email set up on');
    expect(verdict).toContain('subaddressing');
    expect(verdict).toContain('rerun `void email setup --platform cloudflare`');
  });

  it('Workers Free: routing + subaddressing on, sending refused → exit 0 with the plan hint, addresses written', async () => {
    // Sending onboarding needs Workers Paid, which Void cannot buy; inbound is complete and
    // `addresses` is committed, which is all `setup` exists to do (CI commits the file).
    // The plan hint and the `(verified destinations only)` marker are the warning.
    const root = makeProject();
    roots.push(root);
    const configPath = join(root, 'wrangler.jsonc');
    const { deps, printed } = transcriptDeps({
      runnerTable: {
        'email sending enable mail.acme.com': {
          status: 1,
          stdout: '',
          data: '',
          stderr: `${BETA_WARNING}✘ [ERROR] A request to the Cloudflare API (/zones/${ZONE_ID}/email/sending/subdomains) failed.\n\n  something went wrong [code: 10105]\n`,
          errorCode: 10_105,
        },
      },
      fetchTable: {
        [`POST /zones/${ZONE_ID}/email/routing/dns`]: () =>
          jsonResponse(200, { success: true, result: { name: 'mail.acme.com' } }),
        [`PATCH /zones/${ZONE_ID}/email/routing`]: () =>
          jsonResponse(200, { success: true, result: { support_subaddress: true } }),
      },
    });
    const logged = captureLog();
    let code: number;
    try {
      code = await run(root, 'setup', { ...deps, isInteractive: true, confirm: async () => true });
    } finally {
      logged.restore();
    }

    expect(code).toBe(0);
    const output = printed.join('\n');
    expect(output).toContain('✔ routing   mail.acme.com enabled');
    expect(output).toContain('✔ routing   subaddressing on for acme.com');
    expect(output).toContain(
      '! sending   mail.acme.com not onboarded [code: 10105] — account is not entitled to Email Sending',
    );
    expect(output).toContain(SENDING_FREE_PLAN_HINT);
    expect(printed.at(-1)).toContain(
      'outbound  sendEmail() from noreply@mail.acme.com   (verified destinations only)',
    );
    expect(readJsonc(configPath).addresses).toEqual(['support@mail.acme.com']);
    expect(logged.lines.join('\n')).toContain('Email set up on mail.acme.com.');
  });

  it('Workers Free after `setup`: the onboarding is offered as its own prompt; refused again → hint, config unchanged, exit 0', async () => {
    const { root, configPath, deps, calls, fetchCalls, printed } = freeAfterSetup({
      runnerTable: { 'email sending enable mail.acme.com': sendingRefused },
    });
    const before = readFileSync(configPath, 'utf8');
    const confirms: Array<string> = [];
    const logged = captureLog();
    let code: number;
    try {
      code = await run(root, 'setup', {
        ...deps,
        isInteractive: true,
        confirm: async (message) => {
          confirms.push(message);
          return true;
        },
      });
    } finally {
      logged.restore();
    }

    expect(code).toBe(0);
    expect(confirms).toEqual([RETRY_PROMPT]);
    // The checklist before the prompt: the row says what works, the retry is the one change.
    expect(printed[0]).toContain(
      '    sending   mail.acme.com  not onboarded — verified destinations only; after upgrading to Workers Paid run void email setup --platform cloudflare',
    );
    expect(printed[0]).toContain('    + onboard mail.acme.com for Email Sending');
    expect(printed[0]).not.toContain('+ enable Email Routing');
    expect(printed[0]).not.toContain('+ wrangler.jsonc');
    // ONE account write — the onboarding — and no bearer write.
    expect(calls.filter((c) => c.args.includes('enable')).map((c) => c.args.slice(0, 4))).toEqual([
      ['email', 'sending', 'enable', 'mail.acme.com'],
    ]);
    expect(fetchCalls.every((c) => c.method === 'GET')).toBe(true);
    const output = printed.join('\n');
    expect(output).toContain(
      '! sending   mail.acme.com not onboarded [code: 10105] — account is not entitled to Email Sending',
    );
    expect(output).toContain(SENDING_FREE_PLAN_HINT);
    expect(printed.at(-1)).toContain(
      'outbound  sendEmail() from noreply@mail.acme.com   (verified destinations only)',
    );
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(logged.lines.join('\n')).toContain('Email set up on mail.acme.com.');
  });

  it('Workers Free after `setup`, upgraded to Workers Paid: the retry onboards the domain', async () => {
    const { root, configPath, deps, calls, printed } = freeAfterSetup({
      runnerTable: { 'email sending enable mail.acme.com': sendingEnabled('mail.acme.com') },
    });
    const before = readFileSync(configPath, 'utf8');
    const logged = captureLog();
    let code: number;
    try {
      code = await run(root, 'setup', { ...deps, isInteractive: true, confirm: async () => true });
    } finally {
      logged.restore();
    }

    expect(code).toBe(0);
    expect(calls.filter((c) => c.args.includes('enable'))).toHaveLength(1);
    expect(printed.join('\n')).toContain('✔ sending   mail.acme.com onboarded');
    expect(printed.at(-1)).toBe(
      [
        '    inbound   support@mail.acme.com  →  email/support+[ticket].ts',
        '    outbound  sendEmail() from noreply@mail.acme.com',
      ].join('\n'),
    );
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(logged.lines.join('\n')).toContain('Email set up on mail.acme.com.');
  });

  it('Workers Free after `setup`, retry declined: nothing changed, no `enable` call, no write', async () => {
    const { root, configPath, deps, calls, fetchCalls } = freeAfterSetup();
    const before = readFileSync(configPath, 'utf8');
    const confirms: Array<string> = [];
    const logged = captureLog();
    let code: number;
    try {
      code = await run(root, 'setup', {
        ...deps,
        isInteractive: true,
        confirm: async (message) => {
          confirms.push(message);
          return false;
        },
      });
    } finally {
      logged.restore();
    }

    expect(code).toBe(0);
    expect(confirms).toEqual([RETRY_PROMPT]);
    expect(logged.lines).toContain('Nothing changed.');
    expect(calls.some((c) => c.args.includes('enable'))).toBe(false);
    expect(fetchCalls.every((c) => c.method === 'GET')).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('Workers Free after `setup`, non-interactive: the retry is never run unasked — exit 1, no `enable` call', async () => {
    const { root, configPath, deps, calls } = freeAfterSetup();
    const before = readFileSync(configPath, 'utf8');
    const confirm = vi.fn(async () => true);

    const code = await run(root, 'setup', { ...deps, isInteractive: false, confirm });

    expect(code).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(calls.some((c) => c.args.includes('enable'))).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('second run, everything ready: no prompt, zero writes, config unchanged, exit 0', async () => {
    const { root, configPath, deps, calls, fetchCalls, printed } = freeAfterSetup({
      runnerTable: { 'email sending settings mail.acme.com': sendingOnboarded },
    });
    const before = readFileSync(configPath, 'utf8');
    const confirm = vi.fn(async () => true);

    const code = await run(root, 'setup', { ...deps, isInteractive: false, confirm });

    expect(code).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(calls.some((c) => c.args.includes('enable'))).toBe(false);
    expect(fetchCalls.every((c) => c.method === 'GET')).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    // Every row reads ready; the only remaining line is the `!` for the refused catch-all.
    expect(printed[0]).toContain('    rules     support@mail.acme.com → acme-support   (ready)');
    expect(printed[0]).not.toContain('\n    + ');
  });

  it('refuses without email.from before touching wrangler', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-email-cli-'));
    roots.push(root);
    writeFileSync(join(root, 'void.json'), '{}');
    writeFileSync(join(root, 'wrangler.jsonc'), INITIAL_WRANGLER);
    const { deps, calls, fetchCalls } = transcriptDeps();

    const code = await run(root, 'setup', { ...deps, isInteractive: true });

    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(fetchCalls).toEqual([]);
  });

  it('refuses without a pinned account before touching wrangler', async () => {
    const root = makeProject({ wrangler: '{ "name": "acme-support" }\n' });
    roots.push(root);
    const saved = process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    try {
      const { deps, calls } = transcriptDeps();
      const code = await run(root, 'setup', { ...deps, isInteractive: true });
      expect(code).toBe(1);
      expect(calls).toEqual([]);
    } finally {
      if (saved !== undefined) {
        process.env.CLOUDFLARE_ACCOUNT_ID = saved;
      }
    }
  });
});

describe('void email status --platform cloudflare', () => {
  it('fences off an ancestor config without creating a root config, then removes the temporary config', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'void-email-cli-parent-'));
    roots.push(parent);
    const parentConfigPath = join(parent, 'wrangler.jsonc');
    const parentConfig = '{ "account_id": "wrong-account", "name": "wrong-worker" }\n';
    writeFileSync(parentConfigPath, parentConfig);
    const root = join(parent, 'app');
    mkdirSync(join(root, 'email'), { recursive: true });
    writeFileSync(
      join(root, 'void.json'),
      JSON.stringify({ email: { from: 'noreply@mail.acme.com' } }),
    );
    writeFileSync(join(root, 'email', 'support+[ticket].ts'), 'export default () => {};\n');
    const configPath = join(root, 'wrangler.jsonc');
    const { deps, calls, fetchCalls } = transcriptDeps({
      runnerTable: {
        'auth token --json': {
          status: 0,
          stdout: '',
          data: { type: 'oauth', token: BEARER },
          stderr: '',
        },
      },
    });
    const { getSessionBearer: _injectedBearer, ...defaultBearerDeps } = deps;
    const runWrangler = defaultBearerDeps.runWrangler;
    const temporaryConfigPaths: Array<string> = [];
    defaultBearerDeps.runWrangler = (operation, options) => {
      const temporaryConfigPath = operation.configPath as string;
      temporaryConfigPaths.push(temporaryConfigPath);
      expect(temporaryConfigPath).not.toBe(parentConfigPath);
      expect(temporaryConfigPath).not.toBe(configPath);
      expect(readFileSync(temporaryConfigPath, 'utf8')).toBe('{}\n');
      return runWrangler(operation, options);
    };
    const savedAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;

    try {
      const code = await run(root, 'status', defaultBearerDeps);

      expect(code).toBe(1);
      expect(existsSync(configPath)).toBe(false);
      expect(readFileSync(parentConfigPath, 'utf8')).toBe(parentConfig);
      expect(fetchCalls.every((call) => call.method === 'GET')).toBe(true);
      expect(temporaryConfigPaths.length).toBeGreaterThan(0);
      expect(new Set(temporaryConfigPaths).size).toBe(1);
      expect(existsSync(temporaryConfigPaths[0])).toBe(false);
      expect(calls.every((call) => call.operation.configPath === temporaryConfigPaths[0])).toBe(
        true,
      );
      expect(calls.find((call) => call.operation.type === 'auth.token')?.operation).toEqual({
        type: 'auth.token',
        configPath: temporaryConfigPaths[0],
      });
    } finally {
      if (savedAccountId === undefined) {
        delete process.env.CLOUDFLARE_ACCOUNT_ID;
      } else {
        process.env.CLOUDFLARE_ACCOUNT_ID = savedAccountId;
      }
    }
  });

  it('not ready: status rows + address map, exit 1, read-only', async () => {
    const root = makeProject();
    roots.push(root);
    const before = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
    const { deps, calls, fetchCalls, printed } = transcriptDeps();
    const confirm = vi.fn(async () => true);

    const code = await run(root, 'status', { ...deps, isInteractive: true, confirm });

    expect(code).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(calls.some((c) => c.args.includes('enable'))).toBe(false);
    expect(fetchCalls.every((c) => c.method === 'GET')).toBe(true);
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).toBe(before);

    expect(printed).toHaveLength(2);
    expect(printed[0]).toContain('    routing   mail.acme.com  not enabled · subaddressing off');
    expect(printed[0]).toContain('    binding   SEND_EMAIL             (absent)');
    expect(printed[1]).toBe(
      [
        '    inbound   support@mail.acme.com  →  email/support+[ticket].ts   (no rule yet)',
        '    outbound  sendEmail() from noreply@mail.acme.com   (verified destinations only)',
      ].join('\n'),
    );
  });

  it('Workers Free after `setup` (binding committed, sending still not onboarded): exit 0, the row says what works and how to retry', async () => {
    const { root, configPath, deps, calls, fetchCalls, printed } = freeAfterSetup();
    const before = readFileSync(configPath, 'utf8');
    const confirm = vi.fn(async () => true);
    const logged = captureLog();
    let code: number;
    try {
      code = await run(root, 'status', { ...deps, isInteractive: true, confirm });
    } finally {
      logged.restore();
    }

    expect(code).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(calls.some((c) => c.args.includes('enable'))).toBe(false);
    expect(fetchCalls.every((c) => c.method === 'GET')).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(printed[0]).toContain(
      '    sending   mail.acme.com  not onboarded — verified destinations only; after upgrading to Workers Paid run void email setup --platform cloudflare',
    );
    expect(printed[0]).toContain('    binding   SEND_EMAIL             (present)');
    expect(printed[1]).toBe(
      [
        '    inbound   support@mail.acme.com  →  email/support+[ticket].ts',
        '    outbound  sendEmail() from noreply@mail.acme.com   (verified destinations only)',
      ].join('\n'),
    );
    expect(logged.lines.join('\n')).toContain('Email is set up on mail.acme.com.');
    expect(logged.lines.join('\n')).not.toContain('not set up');
  });

  it('not signed in: the checklist reaches the terminal as-is and says `void cloudflare login`, exit 1', async () => {
    const root = makeProject();
    roots.push(root);
    const { deps, calls } = transcriptDeps({
      runnerTable: {
        'whoami --json': { status: 0, stdout: '', data: { loggedIn: false }, stderr: '' },
      },
    });
    // The default block printer is clack's `log.message`, straight from the renderer — this
    // path has no `formatCloudflareUserMessage` in front of it, so the text pinned here is
    // exactly what the developer reads.
    const { print: _print, ...withoutPrint } = deps;
    const logged = captureLog();
    let code: number;
    try {
      code = await run(root, 'status', { ...withoutPrint, isInteractive: false });
    } finally {
      logged.restore();
    }

    expect(code).toBe(1);
    const output = logged.lines.join('\n');
    expect(output).toContain('    ✘ not logged in to Cloudflare — run `void cloudflare login`');
    expect(output).not.toMatch(/wrangler login/i);
    expect(output).toContain('Email is not set up on mail.acme.com yet');
    expect(calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['whoami --json']);
  });

  it('ready: exit 0 and the routed address map', async () => {
    const { root, deps, printed } = freeAfterSetup({
      runnerTable: { 'email sending settings mail.acme.com': sendingOnboarded },
    });

    const code = await run(root, 'status', { ...deps, isInteractive: false });

    expect(code).toBe(0);
    expect(printed[1]).toBe(
      [
        '    inbound   support@mail.acme.com  →  email/support+[ticket].ts',
        '    outbound  sendEmail() from noreply@mail.acme.com',
      ].join('\n'),
    );
  });
});

describe('void email setup|status without --platform cloudflare', () => {
  let exitSpy: MockInstance;
  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new ExitSignal(code);
    }) as never);
  });
  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('explains that both need --platform cloudflare and exits 1 before any platform call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-email-cli-'));
    roots.push(root);
    for (const subcommand of ['setup', 'status'] as const) {
      await expect(runEmailCommand(root, { subcommand })).rejects.toBeInstanceOf(ExitSignal);
      expect(exitSpy).toHaveBeenLastCalledWith(1);
      // `--platform void` is that default spelled out: the same exit, still no platform call.
      await expect(runEmailCommand(root, { subcommand, platform: 'void' })).rejects.toBeInstanceOf(
        ExitSignal,
      );
      expect(exitSpy).toHaveBeenLastCalledWith(1);
    }
  });

  it('says status reads your own Cloudflare account and names the Void platform commands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-email-cli-'));
    roots.push(root);
    const logged = captureLog();
    try {
      await expect(runEmailCommand(root, { subcommand: 'status' })).rejects.toBeInstanceOf(
        ExitSignal,
      );
    } finally {
      logged.restore();
    }
    expect(logged.lines).toEqual([
      'email: `void email status` checks email on your own Cloudflare account. Run it with `--platform cloudflare`. On the Void platform, use `void email usage` and `void email destinations`.',
    ]);
  });
});
