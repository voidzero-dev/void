import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudflareOperation } from '@void/deploy-cloudflare';
import { log } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { runCloudflareEmailStep } from '../../src/cli/deploy-cloudflare-email.ts';
import type { DeployWranglerRunResult } from '../../src/cli/deploy-types.ts';
import { renderAddressMap } from '../../src/cli/email-cloudflare.ts';
import type { EmailDns } from '../../src/cli/email-cloudflare.ts';

/**
 * A sending-only app (no `email/` handlers) deployed from CI with an API token, shaped like
 * the pocket-folio report: `email.from` on `mail.pkmn.nakazawa.tech`, a subdomain of the
 * `nakazawa.tech` zone, Email Sending onboarded, Email Routing never enabled, and the
 * `SEND_EMAIL` binding plus `__VOID_EMAIL_FROM` already committed.
 */
const ACCOUNT = '004b3cab004b3cab004b3cab004b3cab';
const ZONE_ID = '5b66f5cb84fd7dcfdd0170515e622181';
const BEARER = 'cfat-SECRET-API-TOKEN-0123456789abcdef';
const DOMAIN = 'mail.pkmn.nakazawa.tech';
const FROM = `Pocket Folio <noreply@${DOMAIN}>`;

const clean = { status: 0, stdout: '', stderr: '' } as const;

type FetchCall = { method: string; path: string; auth: string };

function cpojerAccount() {
  const operations: Array<CloudflareOperation['type']> = [];
  const fetchCalls: Array<FetchCall> = [];
  const runWrangler = (operation: CloudflareOperation): DeployWranglerRunResult => {
    operations.push(operation.type);
    switch (operation.type) {
      case 'auth.whoami':
        return {
          ...clean,
          data: {
            loggedIn: true,
            authType: 'API Token',
            accounts: [{ id: ACCOUNT, name: 'Nakazawa Tech KK' }],
          },
        };
      case 'auth.token':
        return { ...clean, data: { type: 'api_token', token: BEARER } };
      case 'email.routing.settings':
      case 'email.sending.settings': {
        // The documented token (Zone Read + Email Sending Edit) has no Zone Settings Read,
        // so the provider's Email Routing settings read, which also locates the zone for its
        // sending read, is refused.
        const message = 'Cloudflare could not resolve the Email zone.';
        return { status: 1, stdout: '', stderr: message, errors: [{ message }] };
      }
      default:
        throw new Error(`unexpected Cloudflare operation: ${operation.type}`);
    }
  };
  const zones: Record<string, Array<unknown>> = {
    [DOMAIN]: [],
    'pkmn.nakazawa.tech': [],
    'nakazawa.tech': [
      { id: ZONE_ID, name: 'nakazawa.tech', type: 'full', account: { id: ACCOUNT } },
    ],
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.slice(url.indexOf('/zones'));
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    fetchCalls.push({ method, path, auth: headers.Authorization ?? '' });
    const prefix = '/zones?name=';
    if (method === 'GET' && path.startsWith(prefix)) {
      const name = decodeURIComponent(path.slice(prefix.length));
      if (name in zones) {
        return new Response(JSON.stringify({ success: true, result: zones[name] }));
      }
    }
    if (method === 'GET' && path === `/zones/${ZONE_ID}/email/sending/subdomains`) {
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: [
            {
              tag: '19af4fdbee924a92916afea0de5a8fdd',
              name: DOMAIN,
              enabled: true,
              created: '2026-11-01T00:00:00Z',
              modified: '2026-11-01T00:00:00Z',
              dkim_selector: 'cf-bounce',
              return_path_domain: `cf-bounce.${DOMAIN}`,
            },
          ],
          result_info: { count: 1, page: 1, per_page: 20, total_count: 1, total_pages: 1 },
        }),
      );
    }
    throw new Error(`unexpected fetch: ${method} ${path}`);
  }) as typeof fetch;
  // Onboarding wrote its own `_dmarc` and `cf-bounce` records; inbound MX is never read.
  const dns: EmailDns = {
    resolveMx: async (name) => {
      throw new Error(`a sending-only app must not read inbound MX (${name})`);
    },
    resolveTxt: async (name) => {
      if (name === `_dmarc.${DOMAIN}`) {
        return [['v=DMARC1; p=reject']];
      }
      if (name === `cf-bounce.${DOMAIN}`) {
        return [['v=spf1 include:_spf.mx.cloudflare.net ~all']];
      }
      throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
    },
  };
  return { operations, fetchCalls, runWrangler, fetchImpl, dns };
}

/** Everything the step prints: every clack level plus raw stdout/stderr. */
function captureOutput(): { lines: Array<string>; restore: () => void } {
  const lines: Array<string> = [];
  const spies = (['message', 'info', 'warn', 'error', 'success', 'step'] as const).map((level) =>
    vi.spyOn(log, level).mockImplementation(((message: unknown) => {
      lines.push(`${level}: ${String(message)}`);
    }) as never),
  );
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    lines.push(`stdout: ${String(chunk)}`);
    return true;
  }) as never);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    lines.push(`stderr: ${String(chunk)}`);
    return true;
  }) as never);
  return {
    lines,
    restore: () => {
      for (const spy of spies) {
        spy.mockRestore();
      }
      out.mockRestore();
      err.mockRestore();
    },
  };
}

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(rootConfig: Record<string, unknown>): { root: string; configPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'void-email-step-'));
  roots.push(root);
  const configPath = join(root, '.void-wrangler.jsonc');
  writeFileSync(configPath, JSON.stringify(rootConfig, null, 2));
  return { root, configPath };
}

describe('runCloudflareEmailStep — sending-only app in CI', () => {
  it('prints nothing for an onboarded sending-only app, then one neutral outbound line', async () => {
    const rootConfig = {
      name: 'pkmn-binder',
      send_email: [{ name: 'SEND_EMAIL' }],
      vars: { __VOID_EMAIL_FROM: FROM },
    };
    const { root, configPath } = project(rootConfig);
    const account = cpojerAccount();
    const output = captureOutput();
    let result: Awaited<ReturnType<typeof runCloudflareEmailStep>>;
    try {
      result = await runCloudflareEmailStep({
        root,
        configPath,
        voidConfig: { email: { from: FROM } },
        rootConfig,
        handlers: { addresses: [] },
        workerName: 'pkmn-binder',
        accountId: ACCOUNT,
        apiBaseUrl: 'https://api.cloudflare.com/client/v4',
        runWrangler: account.runWrangler,
        nonInteractive: true,
        confirm: async () => {
          throw new Error('CI must never be asked');
        },
        fetchImpl: account.fetchImpl,
        dns: account.dns,
      });
    } finally {
      output.restore();
    }

    expect(output.lines).toEqual([]);
    expect(result).toEqual({
      satisfied: true,
      configWritten: false,
      map: {
        from: FROM,
        routes: [],
        addresses: [],
        sendingReady: true,
        sendingOnly: true,
        creating: [],
      },
    });
    // The post-deploy block is the only email output of the whole deploy.
    expect(renderAddressMap(result.map!)).toBe(`    outbound  sendEmail() from ${FROM}`);
    // Nothing touches Email Routing: with a token scoped Zone Read + Email Sending Edit,
    // sending is read on the zone the bearer resolved, so --require-email passes. The
    // bearer stays in the Authorization header.
    expect(account.operations).toEqual(['auth.whoami', 'auth.token']);
    expect(account.fetchCalls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `GET /zones?name=${DOMAIN}`,
      'GET /zones?name=pkmn.nakazawa.tech',
      'GET /zones?name=nakazawa.tech',
      `GET /zones/${ZONE_ID}/email/sending/subdomains`,
    ]);
    expect(account.fetchCalls.every(({ auth }) => auth === `Bearer ${BEARER}`)).toBe(true);
  });
});
