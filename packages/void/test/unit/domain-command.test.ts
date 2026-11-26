import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { DomainStatusResponse } from '../../src/cli/client.ts';
import type { DomainArgs } from '../../src/cli/domain-args.ts';
import { computeRollup, runDomainCommand } from '../../src/cli/domain.ts';

const mockLogError = vi.fn<(...args: Array<unknown>) => void>();
const mockLogSuccess = vi.fn<(...args: Array<unknown>) => void>();
const mockLogInfo = vi.fn<(...args: Array<unknown>) => void>();
const mockNote = vi.fn<(...args: Array<unknown>) => void>();
class ProcessExitError extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}
const mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new ProcessExitError(code);
}) as never);

async function runExpectingExit(rt: string, a: DomainArgs): Promise<void> {
  await expect(runDomainCommand(rt, a)).rejects.toBeInstanceOf(ProcessExitError);
}

const mockGetToken = vi.fn<typeof import('../../src/cli/auth.ts').getToken>();
const mockReadProjectConfig = vi.fn<(root: string) => { projectId: string; slug: string } | null>();
const mockReadDeploymentPlatform =
  vi.fn<typeof import('../../src/cli/project.ts').readDeploymentPlatform>();
const mockListProjects = vi.fn<() => Promise<Array<{ id: string; slug: string }>>>();
const mockAddDomain = vi.fn<import('../../src/cli/client.ts').PlatformClient['addDomain']>();
const mockListDomains =
  vi.fn<
    (
      projectId: string,
    ) => Promise<
      Array<Pick<import('../../src/cli/client.ts').DomainResponse, 'id' | 'hostname' | 'status'>>
    >
  >();
const mockGetDomainStatus = vi.fn<
  (
    projectId: string,
    domainId: string,
  ) => Promise<
    Omit<DomainStatusResponse, 'cname_target'> & {
      cname_target?: string;
    }
  >
>();
const mockRemoveDomain = vi.fn<import('../../src/cli/client.ts').PlatformClient['removeDomain']>();

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  outro: vi.fn(),
  log: {
    error: (...args: Parameters<typeof mockLogError>) => mockLogError(...args),
    success: (...args: Parameters<typeof mockLogSuccess>) => mockLogSuccess(...args),
    info: (...args: Parameters<typeof mockLogInfo>) => mockLogInfo(...args),
  },
  note: (...args: Parameters<typeof mockNote>) => mockNote(...args),
}));

vi.mock('../../src/cli/auth', () => ({
  getToken: (...args: Parameters<typeof mockGetToken>) => mockGetToken(...args),
}));

vi.mock('../../src/cli/project', () => ({
  readProjectConfig: (...args: Parameters<typeof mockReadProjectConfig>) =>
    mockReadProjectConfig(...args),
  readDeploymentPlatform: (...args: Parameters<typeof mockReadDeploymentPlatform>) =>
    mockReadDeploymentPlatform(...args),
}));

vi.mock('../../src/cli/client', () => ({
  PlatformClient: class {
    listProjects(...args: Parameters<typeof mockListProjects>) {
      return mockListProjects(...args);
    }
    addDomain(...args: Parameters<typeof mockAddDomain>) {
      return mockAddDomain(...args);
    }
    listDomains(...args: Parameters<typeof mockListDomains>) {
      return mockListDomains(...args);
    }
    getDomainStatus(...args: Parameters<typeof mockGetDomainStatus>) {
      return mockGetDomainStatus(...args);
    }
    removeDomain(...args: Parameters<typeof mockRemoveDomain>) {
      return mockRemoveDomain(...args);
    }
  },
}));

const root = '/project';

beforeEach(() => {
  mockLogError.mockReset();
  mockLogSuccess.mockReset();
  mockLogInfo.mockReset();
  mockNote.mockReset();
  mockExit.mockClear();

  mockGetToken.mockReset();
  mockReadProjectConfig.mockReset();
  mockReadDeploymentPlatform.mockReset();
  mockListProjects.mockReset();
  mockAddDomain.mockReset();
  mockListDomains.mockReset();
  mockGetDomainStatus.mockReset();
  mockRemoveDomain.mockReset();

  mockGetToken.mockReturnValue('test-token');
  mockReadProjectConfig.mockReturnValue({ projectId: 'proj_default', slug: 'default' });
  mockReadDeploymentPlatform.mockReturnValue('void');
  mockListProjects.mockResolvedValue([]);
  mockListDomains.mockResolvedValue([]);
  delete process.env.VOID_PROJECT;
});

describe('runDomainCommand top-level guards', () => {
  it('fails when no token is found', async () => {
    mockGetToken.mockReturnValue(null);

    await runExpectingExit(root, { subcommand: 'list' });

    expect(mockLogError).toHaveBeenCalledWith('Not logged in. Run `void account login` first.');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('resolves project from --project <slug> flag', async () => {
    mockListProjects.mockResolvedValue([{ slug: 'foo', id: 'proj_foo' }]);
    mockListDomains.mockResolvedValue([]);

    await runDomainCommand(root, { subcommand: 'list', projectSlug: 'foo' });

    expect(mockListDomains).toHaveBeenCalledWith('proj_foo');
  });

  it('resolves project from readProjectConfig when no slug', async () => {
    mockReadProjectConfig.mockReturnValue({ projectId: 'proj_linked', slug: 'linked' });
    mockListDomains.mockResolvedValue([]);

    await runDomainCommand(root, { subcommand: 'list' });

    expect(mockListDomains).toHaveBeenCalledWith('proj_linked');
  });

  it('errors when no project resolvable', async () => {
    mockReadProjectConfig.mockReturnValue(null);

    await runExpectingExit(root, { subcommand: 'list' });

    expect(mockLogError).toHaveBeenCalledWith(
      'No linked project. Run `void project link` or pass --project <name>.',
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

describe('domainAdd', () => {
  it('prints CNAME + ownership TXT when both records returned', async () => {
    mockAddDomain.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      cname_target: 'foo.example.com.cdn.cloudflare.net',
      ownership_verification: { type: 'txt', name: '_cf-custom-hostname.foo', value: 'own-token' },
    });

    await runDomainCommand(root, { subcommand: 'add', hostname: 'foo.example.com' });

    expect(mockNote).toHaveBeenCalledTimes(1);
    const content = mockNote.mock.calls[0][0] as string;
    expect(content).toContain('CNAME (traffic)');
    expect(content).toContain('foo.example.com → foo.example.com.cdn.cloudflare.net');
    expect(content).toContain('TXT (ownership verification)');
    expect(content).toContain('_cf-custom-hostname.foo → own-token');
    // HTTP-DCV: no user-facing SSL-validation records.
    expect(content).not.toContain('TXT (SSL validation)');
    expect(content.indexOf('CNAME (traffic)')).toBeLessThan(
      content.indexOf('TXT (ownership verification)'),
    );
    expect(content).toContain(
      'Add the records above to your DNS, then run `void domain status foo.example.com` to check progress.',
    );
  });

  it('skips ownership section when ownership_verification is missing', async () => {
    mockAddDomain.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      cname_target: 'cname.example',
    });

    await runDomainCommand(root, { subcommand: 'add', hostname: 'foo.example.com' });

    const content = mockNote.mock.calls[0][0] as string;
    expect(content).toContain('CNAME (traffic)');
    expect(content).not.toContain('TXT (ownership verification)');
    expect(content).not.toContain('TXT (SSL validation)');
    // Only one record rendered: summary is singular and must not claim "both".
    expect(content).toContain(
      'Add the record above to your DNS, then run `void domain status foo.example.com` to check progress.',
    );
    expect(content).not.toContain('both');
  });
});

describe('domainStatus rollup', () => {
  function setupDomain(): void {
    mockListDomains.mockResolvedValue([
      { id: 'dom_1', hostname: 'foo.example.com', status: 'pending' },
    ]);
  }

  it('errors when hostname not found on project', async () => {
    mockListDomains.mockResolvedValue([]);

    await runExpectingExit(root, { subcommand: 'status', hostname: 'foo.example.com' });

    expect(mockLogError).toHaveBeenCalledWith(
      "domain: Domain 'foo.example.com' not found on this project.",
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('renders error state when verification_errors present', async () => {
    setupDomain();
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      ssl_status: 'pending_validation',
      cf_status: 'pending_validation',
      verification_errors: ['DNS validation timed out', 'second error'],
    });

    await runDomainCommand(root, { subcommand: 'status', hostname: 'foo.example.com' });

    const statusNote = mockNote.mock.calls[0][0] as string;
    expect(statusNote).toContain('Status:   error — Verification failed: DNS validation timed out');
    // Only the first error surfaces in the rollup line.
    expect(statusNote).not.toContain('second error');
  });
});

describe('computeRollup', () => {
  const baseStatus: DomainStatusResponse = {
    id: 'dom_1',
    project_id: 'p',
    hostname: 'h',
    cf_hostname_id: 'cf',
    created_at: 'now',
    status: 'pending',
    ssl_status: 'pending',
    cname_target: 'cname.void.app',
  };

  const issuing =
    'Cloudflare is issuing the SSL certificate automatically (typically <5 minutes). If this persists, confirm the traffic CNAME below is published.';
  const verifying = 'DNS records found, Cloudflare is validating ownership.';
  const pending = 'Verification pending. Cloudflare is processing.';
  const cases: Array<
    [name: string, input: Partial<DomainStatusResponse>, state: string, diagnostic: string]
  > = [
    [
      'error wins over everything',
      { verification_errors: ['boom'], cf_status: 'active', awaiting_deployment: true },
      'error',
      'Verification failed: boom',
    ],
    [
      'awaiting_deployment beats CF states',
      { awaiting_deployment: true, cf_status: 'pending' },
      'awaiting_deployment',
      'Your project has no live deployment yet. Run `void deploy` to bring the domain online.',
    ],
    [
      'awaiting_dns on pending + ownership',
      {
        cf_status: 'pending',
        ownership_verification: { type: 'txt', name: 'n', value: 'v' },
      },
      'awaiting_dns',
      'Cloudflare has not yet observed your _cf-custom-hostname TXT record. Confirm it is published at the host shown below.',
    ],
    ['verifying_dns', { cf_status: 'pending_validation' }, 'verifying_dns', verifying],
    [
      'issuing_cert on pending_issuance',
      { cf_status: 'pending_issuance' },
      'issuing_cert',
      issuing,
    ],
    [
      'issuing_cert on cert-renewal (cf active + ssl pending), even when DB is active',
      { status: 'active', cf_status: 'active', ssl_status: 'pending_validation' },
      'issuing_cert',
      issuing,
    ],
    [
      'deploying_cert',
      { cf_status: 'pending_deployment' },
      'deploying_cert',
      'SSL certificate issued; Cloudflare is propagating it to its edge.',
    ],
    [
      'active when DB active and CF/ssl both active',
      { status: 'active', cf_status: 'active', ssl_status: 'active' },
      'active',
      'Live.',
    ],
    ['pending fallback when no signals', {}, 'pending', pending],
    [
      'active gated on ssl_status — pre-rollout platform during cert renewal',
      { status: 'active', ssl_status: 'pending_validation' },
      'pending',
      pending,
    ],
    [
      'empty verification_errors does NOT trigger error',
      { verification_errors: [], cf_status: 'pending_validation' },
      'verifying_dns',
      verifying,
    ],
  ];

  for (const [name, input, state, diagnostic] of cases) {
    it(name, () => {
      expect(computeRollup({ ...baseStatus, ...input })).toEqual({ state, diagnostic });
    });
  }
});

describe('domainStatus --verbose', () => {
  it('renders both rolled-up state and multi-line breakdown', async () => {
    mockListDomains.mockResolvedValue([
      { id: 'dom_1', hostname: 'foo.example.com', status: 'pending' },
    ]);
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      ssl_status: 'pending_validation',
      cf_status: 'pending_validation',
      ownership_verification: { type: 'txt', name: 'own-name', value: 'own-value' },
      verification_errors: ['boom'],
    });

    await runDomainCommand(root, {
      subcommand: 'status',
      hostname: 'foo.example.com',
      verbose: true,
    });

    const statusNote = mockNote.mock.calls[0][0] as string;
    expect(statusNote).toContain('Status:   error —');
    expect(statusNote).toContain('Details:');
    expect(statusNote).toContain('  Status:      pending');
    expect(statusNote).toContain('  SSL Status:  pending_validation');
    expect(statusNote).toContain('  Ownership:   pending');
    expect(statusNote).toContain('  Errors:      boom');
  });

  it('omits the multi-line breakdown when --verbose is not set', async () => {
    mockListDomains.mockResolvedValue([
      { id: 'dom_1', hostname: 'foo.example.com', status: 'pending' },
    ]);
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      ssl_status: 'pending_validation',
      cf_status: 'pending_validation',
    });

    await runDomainCommand(root, { subcommand: 'status', hostname: 'foo.example.com' });

    const statusNote = mockNote.mock.calls[0][0] as string;
    expect(statusNote).not.toContain('SSL Status:');
    expect(statusNote).not.toContain('Details:');
    expect(statusNote).not.toContain('  Status:      pending');
  });
});

describe('domainStatus pending records block', () => {
  it('shows the traffic CNAME while the cert is still pending (ownership already verified)', async () => {
    mockListDomains.mockResolvedValue([
      { id: 'dom_1', hostname: 'foo.example.com', status: 'pending' },
    ]);
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      ssl_status: 'pending_validation',
      cf_status: 'pending_issuance',
      cname_target: 'cname.void.app',
    });

    await runDomainCommand(root, { subcommand: 'status', hostname: 'foo.example.com' });

    expect(mockNote).toHaveBeenCalledTimes(2);
    const pendingNote = mockNote.mock.calls[1][0] as string;
    expect(pendingNote).toContain('CNAME (traffic)');
    expect(pendingNote).toContain('foo.example.com → cname.void.app');
    // Ownership already verified — CF dropped the TXT, so it must not appear.
    expect(pendingNote).not.toContain('TXT (ownership verification)');
    // One record only: singular title.
    expect(mockNote.mock.calls[1][1]).toBe('Add this DNS record to your provider');
  });

  it('does NOT show the traffic CNAME once the domain is fully active', async () => {
    mockListDomains.mockResolvedValue([
      { id: 'dom_1', hostname: 'foo.example.com', status: 'active' },
    ]);
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'active',
      created_at: 'now',
      ssl_status: 'active',
      cf_status: 'active',
      cname_target: 'cname.void.app',
    });

    await runDomainCommand(root, { subcommand: 'status', hostname: 'foo.example.com' });

    // Only the Domain Status note — the CNAME is correct by definition when live.
    expect(mockNote).toHaveBeenCalledTimes(1);
    expect(mockNote.mock.calls[0][1]).toBe('Domain Status');
    expect(mockNote.mock.calls[0][0] as string).not.toContain('CNAME (traffic)');
  });

  it('shows both records (CNAME before TXT) with a plural title before activation', async () => {
    mockListDomains.mockResolvedValue([
      { id: 'dom_1', hostname: 'foo.example.com', status: 'pending' },
    ]);
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      ssl_status: 'pending_validation',
      cf_status: 'pending',
      cname_target: 'cname.void.app',
      ownership_verification: { type: 'txt', name: 'own-name', value: 'own-value' },
    });

    await runDomainCommand(root, { subcommand: 'status', hostname: 'foo.example.com' });

    expect(mockNote).toHaveBeenCalledTimes(2);
    const pendingNote = mockNote.mock.calls[1][0] as string;
    expect(pendingNote).toContain('CNAME (traffic)');
    expect(pendingNote).toContain('foo.example.com → cname.void.app');
    expect(pendingNote).toContain('TXT (ownership verification)');
    expect(pendingNote).toContain('own-name → own-value');
    // HTTP-DCV: no SSL-validation records ever surface to the user.
    expect(pendingNote).not.toContain('TXT (SSL validation)');
    // CNAME ordered before ownership, matching `domain add`.
    expect(pendingNote.indexOf('CNAME (traffic)')).toBeLessThan(
      pendingNote.indexOf('TXT (ownership verification)'),
    );
    // Two records: plural title.
    expect(mockNote.mock.calls[1][1]).toBe('Add these DNS records to your provider');
  });
});

describe('domainList', () => {
  it("prints 'No custom domains configured.' info line for empty list", async () => {
    mockListDomains.mockResolvedValue([]);

    await runDomainCommand(root, { subcommand: 'list' });

    expect(mockLogInfo).toHaveBeenCalledWith('No custom domains configured.');
  });
});

describe('domainRemove', () => {
  it('errors with not-found message when hostname not in list', async () => {
    mockListDomains.mockResolvedValue([]);

    await runExpectingExit(root, { subcommand: 'delete', hostname: 'foo.example.com' });

    expect(mockLogError).toHaveBeenCalledWith(
      "domain: Domain 'foo.example.com' not found on this project.",
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
