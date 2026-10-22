import { log, note } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  PlatformApiError,
  PlatformClient,
  type EmailDomainResponse,
  type RemoveEmailDomainResponse,
} from '../../src/cli/client.ts';
import {
  buildCfApiTokenTemplateUrl,
  classifyCfApiTokenShape,
  emailDomainAdd,
  emailDomainList,
  emailDomainRemove,
  emailDomainStatus,
  emailDomainSync,
  emailDomainRotateSecret,
  isValidEmailDomainInput,
  normalizeEmailDomainInput,
  type EmailDomainAddDeps,
} from '../../src/cli/email.ts';
import * as output from '../../src/cli/output.ts';
import { withPlatformDiscovery } from '../helpers/platform-discovery.ts';

/**
 * `void email domain …`.
 * Every browser, clipboard, DNS and stdin touch is a seam; credential values
 * here are inert placeholders and are never printed.
 */

vi.mock('@voidzero-dev/vite-plus-prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@voidzero-dev/vite-plus-prompts')>();
  return { ...actual, note: vi.fn() };
});

const LEGACY_TOKEN = `Lgcy-${'a1'.repeat(17)}B`; // 40 chars, [A-Za-z0-9_-]
const CFUT_TOKEN = `cfut_${'c0'.repeat(20)}${'deed'.repeat(2)}`; // 40-char core + checksum tail
/** The default platform: owners register their own domains. */
const selfServeSettings = async (): Promise<{
  domains: { management: 'self-serve' | 'admin'; projectSlug?: string };
}> => ({ domains: { management: 'self-serve' } });
const noEmailDomains = async (): Promise<Array<EmailDomainResponse>> => [];

type LogSpy = ReturnType<typeof vi.spyOn>;

let successSpy: LogSpy;
let infoSpy: LogSpy;
let warnSpy: LogSpy;
let errorSpy: LogSpy;

beforeEach(() => {
  successSpy = vi.spyOn(output, 'printSuccess').mockImplementation(() => {});
  infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
  warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
  // Silenced, never asserted: the CI-mode spinner writes through log.step.
  vi.spyOn(log, 'step').mockImplementation(() => {});
  vi.mocked(note).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function printed(spy: LogSpy): string {
  return (spy.mock.calls as Array<Array<unknown>>).map((call) => String(call[0])).join('\n');
}

function notedBlocks(): string {
  return vi
    .mocked(note)
    .mock.calls.map((call) => String(call[0]))
    .join('\n');
}

function domainRow(overrides: Partial<EmailDomainResponse> = {}): EmailDomainResponse {
  return {
    id: 'edom_1',
    domain: 'acme.com',
    projectId: 'prj_1',
    status: 'ready',
    managed_by: 'owner',
    connectionId: 'conn_1',
    account_id: 'account_1',
    zone_id: 'zone_1',
    relay_worker_name: 'void-email-ingress',
    relay_version: 1,
    operationId: null,
    readiness: {
      inbound: { status: 'ready', reason: null, observedAt: null },
      outbound: { status: 'verified_only', reason: null, observedAt: null },
      management: { status: 'healthy', reason: null, observedAt: null },
    },
    ...overrides,
  };
}

/** exit seam: throws so the command stops the way process.exit would. */
function exitSpy(): (code: number) => never {
  return vi.fn((code: number): never => {
    throw new Error(`exit ${code}`);
  });
}

function neverEnter(): Promise<never> {
  return new Promise<never>(() => {});
}

describe('buildCfApiTokenTemplateUrl', () => {
  it('carries the five pinned permission groups, wildcard resources and the domain name', () => {
    const url = new URL(buildCfApiTokenTemplateUrl('acme.com'));
    expect(url.origin + url.pathname).toBe('https://dash.cloudflare.com/profile/api-tokens');
    expect(JSON.parse(url.searchParams.get('permissionGroupKeys')!)).toEqual([
      { key: 'zone', type: 'read' },
      { key: 'email_routing_rule', type: 'edit' },
      { key: 'email_sending', type: 'edit' },
      { key: 'workers_scripts', type: 'edit' },
      { key: 'zone_settings', type: 'edit' },
    ]);
    expect(url.searchParams.get('accountId')).toBe('*');
    expect(url.searchParams.get('zoneId')).toBe('all');
    // The em dash survives the round trip through percent-encoding.
    expect(url.searchParams.get('name')).toBe('Void email — acme.com');
  });
});

describe('classifyCfApiTokenShape', () => {
  it('accepts the cfut_ format (prefix + 40 chars + checksum)', () => {
    expect(classifyCfApiTokenShape(CFUT_TOKEN)).toBe('cfut');
    // Checksum length is bounded loosely — the docs pin the 40, not the tail.
    expect(classifyCfApiTokenShape(`cfut_${'a'.repeat(44)}`)).toBe('cfut');
    expect(classifyCfApiTokenShape(`cfut_${'a'.repeat(64)}`)).toBe('cfut');
  });

  it('accepts the legacy 40-character form, trimmed', () => {
    expect(classifyCfApiTokenShape(LEGACY_TOKEN)).toBe('legacy');
    expect(classifyCfApiTokenShape(`  ${LEGACY_TOKEN}\n`)).toBe('legacy');
  });

  it('refuses other vendor prefixes and the CF global key without a network call', () => {
    for (const value of [
      `ghp_${'a'.repeat(36)}`,
      `github_pat_${'a'.repeat(30)}`,
      `sk-proj-${'a'.repeat(30)}`,
      `sk-${'a'.repeat(40)}`,
      `xoxb-${'1'.repeat(20)}`,
      `xoxp-${'1'.repeat(20)}`,
      `cfk_${'a'.repeat(48)}`,
    ]) {
      expect(classifyCfApiTokenShape(value)).toBe('refused');
    }
  });

  it('rejects everything else as unknown', () => {
    expect(classifyCfApiTokenShape('')).toBe('unknown');
    expect(classifyCfApiTokenShape('   ')).toBe('unknown');
    expect(classifyCfApiTokenShape('hello world')).toBe('unknown');
    expect(classifyCfApiTokenShape(`cfut_${'a'.repeat(43)}`)).toBe('unknown'); // core + no checksum
    expect(classifyCfApiTokenShape(`cfut_${'a'.repeat(65)}`)).toBe('unknown');
    expect(classifyCfApiTokenShape('a'.repeat(39))).toBe('unknown');
    expect(classifyCfApiTokenShape('a'.repeat(41))).toBe('unknown');
    // An account-token prefix is not accepted — the shape check only passes
    // user tokens; anything else is the platform's to refuse.
    expect(classifyCfApiTokenShape(`cfat_${'a'.repeat(48)}`)).toBe('unknown');
    // Legacy shape tolerates no whitespace inside.
    expect(classifyCfApiTokenShape(`${'a'.repeat(20)} ${'a'.repeat(19)}`)).toBe('unknown');
  });
});

describe('domain input helpers', () => {
  it('normalizes like the api (trim, lowercase, strip trailing dot)', () => {
    expect(normalizeEmailDomainInput('  ACME.com. ')).toBe('acme.com');
    expect(isValidEmailDomainInput('acme.com')).toBe(true);
    expect(isValidEmailDomainInput('mail.acme.com')).toBe(true);
    expect(isValidEmailDomainInput('not a domain')).toBe(false);
    expect(isValidEmailDomainInput('-bad.com')).toBe(false);
    expect(isValidEmailDomainInput('nodot')).toBe(false);
  });
});

describe('PlatformClient.getEmailSettings', () => {
  function clientWith(status: number, body: string) {
    const fetchSpy = vi.fn(async () => new Response(body, { status }));
    vi.stubGlobal('fetch', withPlatformDiscovery(fetchSpy));
    return new PlatformClient('jwt-dummy', { apiUrl: 'https://api.example.test' });
  }

  it('reads the settings the platform reports', async () => {
    const client = clientWith(
      200,
      JSON.stringify({ domains: { management: 'admin', projectSlug: 'hr-portal' } }),
    );
    await expect(client.getEmailSettings('prj_1')).resolves.toMatchObject({
      domains: { management: 'admin', projectSlug: 'hr-portal' },
    });
  });

  it('does not start a credential flow when the settings route is unavailable', async () => {
    await expect(clientWith(404, '404 Not Found').getEmailSettings('prj_1')).rejects.toThrow(
      PlatformApiError,
    );
    await expect(
      clientWith(404, JSON.stringify({ error: 'project not found' })).getEmailSettings('prj_gone'),
    ).rejects.toThrow(PlatformApiError);
  });
});

describe('emailDomainAdd', () => {
  const ATTEMPT_ID = '11111111-2222-4333-8444-555555555555';
  function addDeps(overrides: Partial<EmailDomainAddDeps> = {}): EmailDomainAddDeps {
    return {
      dns: { resolveMx: vi.fn(async () => []) },
      isInteractive: true,
      openUrl: vi.fn(),
      readClipboard: () => null,
      clearClipboard: vi.fn(),
      pasteToken: vi.fn(async () => LEGACY_TOKEN),
      confirmScope: vi.fn(async () => true),
      verifyToken: vi.fn(async () => 'active' as const),
      waitForEnter: neverEnter,
      watchIntervalMs: 1,
      watchTimeoutMs: 40,
      sleep: vi.fn(async () => {}),
      exit: exitSpy(),
      ...overrides,
    };
  }
  function client() {
    return {
      addEmailDomain: vi.fn(async () => domainRow({ operationStatus: 'completed' })),
      getEmailDomain: vi.fn(async () => domainRow()),
      getEmailOperation: vi.fn(async () => ({
        operationId: 'op_1',
        attemptId: ATTEMPT_ID,
        status: 'completed' as const,
        domain: 'acme.com',
        readiness: {
          inbound: { status: 'ready' as const },
          outbound: { status: 'ready' as const },
          management: { status: 'healthy' as const },
        },
      })),
      getEmailSettings: vi.fn(selfServeSettings),
      listEmailDomains: vi.fn(noEmailDomains),
    };
  }

  it('uses scoped API-token setup and submits no OAuth grant', async () => {
    const api = client();
    const deps = addDeps();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(ATTEMPT_ID);
    await emailDomainAdd(api, 'prj_1', 'acme.com', deps);
    expect(api.addEmailDomain).toHaveBeenCalledWith('prj_1', {
      domain: 'acme.com',
      apiToken: LEGACY_TOKEN,
      attemptId: ATTEMPT_ID,
    });
    expect(deps.openUrl).toHaveBeenCalledWith(expect.stringContaining('/profile/api-tokens?'));
    expect(deps.confirmScope).toHaveBeenCalledWith('acme.com');
    expect(printed(infoSpy)).toContain('replace All accounts and All zones');
    expect(printed(infoSpy)).toContain('zone connection');
    expect([printed(infoSpy), printed(successSpy), notedBlocks()].join('')).not.toContain(
      LEGACY_TOKEN,
    );
  });

  it('does not submit a token whose scope was not confirmed', async () => {
    const api = client();
    await expect(
      emailDomainAdd(api, 'prj_1', 'acme.com', addDeps({ confirmScope: async () => false })),
    ).rejects.toThrow('exit 1');
    expect(api.addEmailDomain).not.toHaveBeenCalled();
  });

  it('refuses foreign apex mail without proposing an unsupported subdomain or opening credentials', async () => {
    const api = client();
    const deps = addDeps({
      dns: { resolveMx: async () => [{ exchange: 'mx.example.net', priority: 10 }] },
    });
    await expect(emailDomainAdd(api, 'prj_1', 'acme.com', deps)).rejects.toThrow('exit 1');
    expect(printed(errorSpy)).toContain('unused Cloudflare zone apex');
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(api.addEmailDomain).not.toHaveBeenCalled();
  });

  it('rejects invalid domains before opening a browser', async () => {
    const api = client();
    const deps = addDeps();
    await expect(emailDomainAdd(api, 'prj_1', 'https://acme.com', deps)).rejects.toThrow('exit 1');
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(api.addEmailDomain).not.toHaveBeenCalled();
  });

  it('hands new administrator-managed domains to the operator without a token flow', async () => {
    const api = client();
    const deps = addDeps();
    api.getEmailSettings.mockResolvedValue({ domains: { management: 'admin' } });
    await expect(emailDomainAdd(api, 'prj_1', 'acme.com', deps)).rejects.toThrow('exit 0');
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(deps.pasteToken).not.toHaveBeenCalled();
    expect(printed(infoSpy)).toContain('void platform email domain-add acme.com --project prj_1');
  });

  it('points an administrator-managed apex with foreign mail at outbound-only setup', async () => {
    const api = client();
    const deps = addDeps({
      dns: { resolveMx: async () => [{ exchange: 'aspmx.l.google.com', priority: 1 }] },
    });
    api.getEmailSettings.mockResolvedValue({
      domains: { management: 'admin', projectSlug: 'hr-portal' },
    });
    await expect(emailDomainAdd(api, 'prj_1', 'acme.com', deps)).rejects.toThrow('exit 1');
    expect(printed(errorSpy)).toContain(
      'void platform email domain-add acme.com --project hr-portal --outbound-only',
    );
    expect(api.addEmailDomain).not.toHaveBeenCalled();
  });

  it('lets an owner renew their earlier assignment after the administrator mode switch', async () => {
    const api = client();
    const deps = addDeps();
    api.getEmailSettings.mockResolvedValue({ domains: { management: 'admin' } });
    api.listEmailDomains.mockResolvedValue([domainRow({ managed_by: 'owner' })]);
    await emailDomainAdd(api, 'prj_1', 'acme.com', deps);
    expect(api.addEmailDomain).toHaveBeenCalledWith(
      'prj_1',
      expect.objectContaining({ domain: 'acme.com', apiToken: LEGACY_TOKEN }),
    );
    expect(deps.dns?.resolveMx).not.toHaveBeenCalled();
  });

  it('fails non-interactive setup without opening a browser', async () => {
    const api = client();
    const deps = addDeps({ isInteractive: false });
    await expect(emailDomainAdd(api, 'prj_1', 'acme.com', deps)).rejects.toThrow('exit 1');
    expect(deps.openUrl).not.toHaveBeenCalled();
  });

  it('cancels masked paste without storing a credential', async () => {
    const api = client();
    const deps = addDeps({ pasteToken: async () => null });
    await emailDomainAdd(api, 'prj_1', 'acme.com', deps);
    expect(api.addEmailDomain).not.toHaveBeenCalled();
    expect(deps.confirmScope).not.toHaveBeenCalled();
  });

  it.each(['ghp_not-a-cloudflare-token', 'not-a-token'])(
    'rejects foreign or malformed credential %s locally',
    async (token) => {
      const api = client();
      const deps = addDeps({ pasteToken: async () => token });
      await expect(emailDomainAdd(api, 'prj_1', 'acme.com', deps)).rejects.toThrow('exit 1');
      expect(deps.verifyToken).not.toHaveBeenCalled();
      expect(api.addEmailDomain).not.toHaveBeenCalled();
    },
  );

  it('refuses an inactive token', async () => {
    const api = client();
    await expect(
      emailDomainAdd(api, 'prj_1', 'acme.com', addDeps({ verifyToken: async () => 'inactive' })),
    ).rejects.toThrow('exit 1');
    expect(api.addEmailDomain).not.toHaveBeenCalled();
  });

  it('leaves authoritative verification to the API if the local token probe is unavailable', async () => {
    const api = client();
    await emailDomainAdd(api, 'prj_1', 'acme.com', addDeps({ verifyToken: async () => 'unknown' }));
    expect(api.addEmailDomain).toHaveBeenCalled();
  });

  it('accepts only a new Cloudflare-shaped clipboard value and clears it after use', async () => {
    const api = client();
    const readClipboard = vi
      .fn()
      .mockReturnValueOnce('old clipboard')
      .mockReturnValueOnce('ghp_ignored')
      .mockReturnValue(CFUT_TOKEN);
    const deps = addDeps({ readClipboard });
    // Fake time keeps the 40 ms watch window from closing on a slow machine
    // before the third read; the token arrives on the second 1 ms poll.
    vi.useFakeTimers();
    const added = emailDomainAdd(api, 'prj_1', 'acme.com', deps);
    await vi.advanceTimersByTimeAsync(deps.watchTimeoutMs!);
    await added;
    expect(deps.verifyToken).toHaveBeenCalledTimes(1);
    expect(deps.verifyToken).toHaveBeenCalledWith(CFUT_TOKEN);
    expect(deps.clearClipboard).toHaveBeenCalledTimes(1);
    expect(api.addEmailDomain).toHaveBeenCalledWith(
      'prj_1',
      expect.objectContaining({ apiToken: CFUT_TOKEN }),
    );
  });

  it('recovers a lost submission response by exact operation key', async () => {
    const api = client();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(ATTEMPT_ID);
    api.addEmailDomain.mockRejectedValue(new Error('connection reset'));
    await emailDomainAdd(api, 'prj_1', 'acme.com', addDeps());
    expect(api.getEmailOperation).toHaveBeenCalledWith('prj_1', ATTEMPT_ID);
    expect(api.getEmailDomain).not.toHaveBeenCalled();
    expect(notedBlocks()).toContain('Operation:   op_1');
    expect(notedBlocks()).toContain('Inbound:     ready');
    expect(notedBlocks()).not.toContain('[object Object]');
  });

  it('never treats missing operation reads as proof that nothing committed', async () => {
    const api = client();
    api.addEmailDomain.mockRejectedValue(new Error('connection reset'));
    api.getEmailOperation.mockRejectedValue(new PlatformApiError('not found', 404, '{}'));
    await expect(emailDomainAdd(api, 'prj_1', 'acme.com', addDeps())).rejects.toThrow('exit 1');
    expect(api.getEmailOperation).toHaveBeenCalledTimes(15);
    expect(printed(errorSpy)).toContain('outcome is unknown');
    expect(printed(errorSpy)).toContain('Nothing was revoked');
  });

  it('does not poll after a definitive validation refusal', async () => {
    const api = client();
    api.addEmailDomain.mockRejectedValue(new PlatformApiError('invalid domain', 400, '{}'));
    await expect(emailDomainAdd(api, 'prj_1', 'acme.com', addDeps())).rejects.toThrow(
      'invalid domain',
    );
    expect(api.getEmailOperation).not.toHaveBeenCalled();
  });

  it.each(['pending', 'running', 'blocked', 'unknown'] as const)(
    'returns failure when setup is %s, even if a row exists',
    async (operationStatus) => {
      const api = client();
      api.addEmailDomain.mockResolvedValue(
        domainRow({ operationId: 'op_1', operationStatus, error: 'setup unfinished' }),
      );
      await expect(emailDomainAdd(api, 'prj_1', 'acme.com', addDeps())).rejects.toThrow('exit 1');
      expect(printed(errorSpy)).toContain('setup unfinished');
      expect(notedBlocks()).toContain(`op_1 · ${operationStatus}`);
    },
  );
});

describe('emailDomainStatus', () => {
  it('shows the recorded readiness and gives an owner the correct reconciliation command', async () => {
    const getEmailSettings = vi.fn(selfServeSettings);
    await emailDomainStatus(
      {
        getEmailDomain: vi.fn(async () =>
          domainRow({
            status: 'pending',
            operationId: 'eop_1',
            operationStatus: 'blocked',
            readiness: {
              inbound: {
                status: 'pending',
                reason: 'Enable Email Routing for mail.acme.com',
                observedAt: '2026-09-17T00:00:00Z',
              },
              outbound: { status: 'verified_only' },
              management: { status: 'healthy' },
            },
          }),
        ),
        getEmailSettings,
      },
      'prj_1',
      'acme.com',
    );
    expect(notedBlocks()).toContain('Operation:   eop_1 · blocked');
    expect(notedBlocks()).toContain('Enable Email Routing for mail.acme.com');
    expect(notedBlocks()).toContain('outbound     verified_only');
    expect(printed(infoSpy)).toContain('void email domain sync acme.com');
    expect(getEmailSettings).not.toHaveBeenCalled();
  });

  it('sends an administrator-managed pending assignment to the operator', async () => {
    const getEmailSettings = vi.fn(async () => ({
      domains: { management: 'admin' as const, projectSlug: 'hr-portal' },
    }));
    await emailDomainStatus(
      {
        getEmailDomain: vi.fn(async () =>
          domainRow({
            managed_by: 'admin',
            status: 'pending',
            readiness: {
              inbound: { status: 'pending' },
              outbound: { status: 'verified_only' },
              management: { status: 'healthy' },
            },
          }),
        ),
        getEmailSettings,
      },
      'prj_1',
      'acme.com',
    );
    expect(notedBlocks()).toContain('Managed by:  administrator');
    expect(printed(infoSpy)).toContain('void platform email domain-sync acme.com');
    expect(printed(infoSpy)).not.toContain('Run `void email domain sync');
    expect(getEmailSettings).toHaveBeenCalledWith('prj_1');
  });

  it('names credential renewal and the project for an administrator-managed route', async () => {
    await emailDomainStatus(
      {
        getEmailDomain: vi.fn(async () =>
          domainRow({
            managed_by: 'admin',
            readiness: {
              inbound: { status: 'ready' },
              outbound: { status: 'blocked' },
              management: { status: 'revoked', reason: 'token revoked' },
            },
          }),
        ),
        getEmailSettings: vi.fn(async () => ({
          domains: { management: 'admin' as const, projectSlug: 'hr-portal' },
        })),
      },
      'prj_1',
      'acme.com',
    );
    expect(notedBlocks()).toContain('management   revoked — token revoked');
    expect(printed(infoSpy)).toContain(
      'void platform email domain-add acme.com --project hr-portal',
    );
  });

  it('does not invite reconciliation of an operation with an unknown provider outcome', async () => {
    await emailDomainStatus(
      {
        getEmailDomain: vi.fn(async () =>
          domainRow({
            status: 'drifted',
            operationId: 'eop_unknown',
            operationStatus: 'unknown',
            readiness: {
              inbound: { status: 'drifted' },
              outbound: { status: 'verified_only' },
              management: { status: 'refresh_unknown' },
            },
          }),
        ),
        getEmailSettings: vi.fn(selfServeSettings),
      },
      'prj_1',
      'acme.com',
    );
    expect(printed(warnSpy)).toContain('eop_unknown');
    expect(printed(infoSpy)).not.toContain('domain sync');
  });
});

describe('emailDomainList', () => {
  it('reports the empty state with the add hint', async () => {
    await emailDomainList({ listEmailDomains: vi.fn(async () => []) }, 'prj_1');
    expect(printed(infoSpy)).toContain('void email domain add <domain>');
  });

  it('lists actual assignment status and management, without a retired mode column', async () => {
    await emailDomainList(
      {
        listEmailDomains: vi.fn(async () => [
          domainRow(),
          domainRow({
            id: 'edom_2',
            domain: 'mail.example.org',
            status: 'pending',
            managed_by: 'admin',
          }),
        ]),
      },
      'prj_1',
    );
    const block = notedBlocks();
    expect(block).toContain('acme.com');
    expect(block).toContain('ready');
    expect(block).toContain('mail.example.org');
    expect(block).toContain('administrator');
    expect(block).not.toContain('  —');
  });
});

describe('emailDomainSync', () => {
  it('renders the current readiness and operation without claiming secret rotation', async () => {
    const syncEmailDomain = vi.fn(async () =>
      domainRow({ operationId: 'eop_sync', operationStatus: 'completed' }),
    );
    await emailDomainSync({ syncEmailDomain }, 'prj_1', 'acme.com');
    expect(notedBlocks()).toContain('eop_sync · completed');
    expect(notedBlocks()).toContain('outbound     verified_only');
    expect(printed(successSpy)).not.toContain('rotated secret');
  });

  it.each(['pending', 'running', 'blocked', 'unknown'] as const)(
    'exits unsuccessfully for a %s operation while retaining its ID',
    async (operationStatus) => {
      const syncEmailDomain = vi.fn(async () =>
        domainRow({ operationId: 'eop_sync', operationStatus, error: 'provider step unresolved' }),
      );
      await expect(emailDomainSync({ syncEmailDomain }, 'prj_1', 'acme.com')).rejects.toThrow(
        'eop_sync',
      );
      expect(printed(errorSpy)).toContain('provider step unresolved');
    },
  );
});

describe('emailDomainRemove', () => {
  function removeClient(body: RemoveEmailDomainResponse) {
    return { removeEmailDomain: vi.fn(async () => body) };
  }

  it('reports completion and retained shared zone resources', async () => {
    const client = removeClient({
      ok: true,
      removed: true,
      operationId: 'eop_remove',
      operationStatus: 'completed',
    });
    await emailDomainRemove(client, 'prj_1', 'acme.com');
    expect(client.removeEmailDomain).toHaveBeenCalledWith('prj_1', 'acme.com');
    expect(printed(infoSpy)).toContain('eop_remove · completed');
    expect(printed(successSpy)).toContain(
      'Zone resources still used by other domains were retained',
    );
  });

  it.each(['blocked', 'unknown', 'running'] as const)(
    'returns a nonzero result for %s cleanup and never claims removal',
    async (operationStatus) => {
      const client = removeClient({
        ok: false,
        removed: false,
        operationId: 'eop_remove',
        operationStatus,
        error: 'cleanup still recorded',
      });
      const exit = exitSpy();
      await expect(emailDomainRemove(client, 'prj_1', 'acme.com', { exit })).rejects.toThrow(
        'exit 1',
      );
      expect(printed(infoSpy)).toContain(`eop_remove · ${operationStatus}`);
      expect(printed(errorSpy)).toContain('cleanup still recorded');
      expect(printed(successSpy)).toBe('');
    },
  );
});

describe('PlatformClient.removeEmailDomain', () => {
  it('DELETEs only the exact domain path', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            ok: true,
            removed: true,
            operationId: 'eop_remove',
            operationStatus: 'completed',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', withPlatformDiscovery(fetchMock));
    const client = new PlatformClient('tok', { apiUrl: 'https://api.test' });
    await client.removeEmailDomain('prj_1', 'acme.com');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.test/projects/prj_1/email/domains/acme.com');
    expect(init?.method).toBe('DELETE');
  });
});

describe('emailDomainRotateSecret', () => {
  it('reports completion only after the deployed generation was verified', async () => {
    const attemptId = '11111111-2222-4333-8444-555555555555';
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(attemptId);
    const rotateEmailDomainSecret = vi.fn(async () =>
      domainRow({ operationId: 'eop_rotate', operationStatus: 'completed' }),
    );
    await emailDomainRotateSecret(
      { rotateEmailDomainSecret, getEmailOperation: vi.fn() },
      'prj_1',
      'acme.com',
    );
    expect(rotateEmailDomainSecret).toHaveBeenCalledWith('prj_1', 'acme.com', attemptId);
    expect(printed(successSpy)).toContain('verified on the deployed Worker');
  });

  it('reports an uncertain rotation without claiming success', async () => {
    const rotateEmailDomainSecret = vi.fn(async () =>
      domainRow({ operationId: 'eop_rotate', operationStatus: 'unknown' }),
    );
    await expect(
      emailDomainRotateSecret(
        { rotateEmailDomainSecret, getEmailOperation: vi.fn() },
        'prj_1',
        'acme.com',
      ),
    ).rejects.toThrow('eop_rotate');
    expect(printed(successSpy)).not.toContain('secret rotated');
  });

  it('recovers a lost response by the exact rotation key before reporting success', async () => {
    const attemptId = '11111111-2222-4333-8444-555555555555';
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(attemptId);
    const rotateEmailDomainSecret = vi.fn(async () => {
      throw new Error('connection reset');
    });
    const getEmailOperation = vi.fn(async () => ({
      operationId: 'eop_rotate',
      attemptId,
      status: 'completed' as const,
      domain: 'acme.com',
      readiness: domainRow().readiness,
    }));
    await emailDomainRotateSecret(
      { rotateEmailDomainSecret, getEmailOperation },
      'prj_1',
      'acme.com',
      { sleep: vi.fn(async () => {}) },
    );
    expect(rotateEmailDomainSecret).toHaveBeenCalledWith('prj_1', 'acme.com', attemptId);
    expect(getEmailOperation).toHaveBeenCalledWith('prj_1', attemptId);
    expect(notedBlocks()).toContain('eop_rotate');
    expect(printed(successSpy)).toContain('verified on the deployed Worker');
  });
});

describe('PlatformClient.rotateEmailDomainSecret', () => {
  it('submits an idempotency key with the rotation request', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(domainRow()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', withPlatformDiscovery(fetchMock));
    const client = new PlatformClient('tok', { apiUrl: 'https://api.test' });
    await client.rotateEmailDomainSecret('prj_1', 'acme.com', 'attempt_1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://api.test/projects/prj_1/email/domains/acme.com/rotate-secret',
    );
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ attemptId: 'attempt_1' });
  });
});
