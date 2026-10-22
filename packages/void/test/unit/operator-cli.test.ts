import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
} from '@void/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { hasHelpPage } from '../../src/cli/help.ts';
import { operatorCommands, parseOperatorArgs } from '../../src/cli/operator-args.ts';
import {
  OPERATOR_KEYRING_SERVICE,
  readOperatorToken,
  resolveOperatorOrigin,
  saveOperatorToken,
} from '../../src/cli/operator-auth.ts';
import { OperatorClient } from '../../src/cli/operator-client.ts';
import { followOperatorLogs, runOperatorCommand } from '../../src/cli/operator-cmd.ts';
import { parsePlatformArgs } from '../../src/cli/platform-args.ts';
import {
  getActivePlatformConnection,
  savePlatformConnection,
  writeInstallationManifest,
} from '../../src/cli/platform-registry.ts';

const keyring = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), remove: vi.fn() }));
const mutationPrompt = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: () => mutationPrompt,
}));
vi.mock('../../src/cli/keyring.ts', () => ({
  readKeyringPassword: keyring.read,
  writeKeyringPassword: keyring.write,
  deleteKeyringPassword: keyring.remove,
}));
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'void-operator-'));
  vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', directory);
  vi.stubEnv('VOID_API_URL', '');
  vi.stubEnv('VOID_OPERATOR_TOKEN', '');
  vi.stubEnv('VOID_TOKEN', 'deployment-only');
  keyring.read.mockReturnValue(null);
  keyring.write.mockReturnValue(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function connect(apiUrl: string) {
  return savePlatformConnection({
    accountId: null,
    apiUrl,
    applicationDomain: null,
    displayName: apiUrl,
    installationId: null,
    kind: 'connected',
    proxyUrl: null,
  });
}

describe('operator mutation completion output', () => {
  async function runMutation(result: Record<string, unknown>, flags: Array<string> = []) {
    connect('https://one.example');
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const details = vi.spyOn(console, 'log').mockImplementation(() => {});
    let terminal = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      terminal += String(chunk);
      return true;
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ dryRun: true, action: 'user.suspend', target: 'u1' }),
        )
        .mockResolvedValueOnce(Response.json(result)),
    );
    const operation = runOperatorCommand(
      parseOperatorArgs(['user', 'suspend', 'u1', '--yes', ...flags]),
    );
    if (result.ok === false || result.partial === true) {
      await expect(operation).rejects.toMatchObject({ code: 'partial_failure' });
    } else {
      await operation;
    }
    return { terminal: stripVTControlCharacters(terminal), details };
  }

  it('separates a completed mutation from its detailed result', async () => {
    const { terminal, details } = await runMutation({ action: 'user.suspend', target: 'u1' });
    expect(details).toHaveBeenCalledWith(expect.stringContaining('Target: u1'));
    expect(terminal).toBe('\n✓ Platform user suspend completed.\n\n');
  });

  it.each([
    { ok: false, partial: true },
    { ok: true, complete: false },
    { operationStatus: 'pending' },
    { ok: true, configuration: { status: 'configuring' } },
    { ok: true, project: { state: 'reconciling' } },
    { ok: true, project: { state: 'error', last_error: 'DNS verification failed' } },
  ])('does not claim completion for a failed or checkpointed result: %j', async (result) => {
    const { terminal } = await runMutation(result);
    expect(terminal).not.toContain('✓');
  });

  it('keeps successful JSON output free of terminal formatting', async () => {
    const result = { ok: true, action: 'user.suspend', target: 'u1' };
    const { terminal, details } = await runMutation(result, ['--json']);
    expect(details).toHaveBeenCalledExactlyOnceWith(JSON.stringify(result));
    expect(terminal).toBe('');
  });
});

describe('operator argument and help coverage', () => {
  it('has nested help and routable arguments for every operation', () => {
    for (const command of operatorCommands) {
      expect(hasHelpPage(['platform', command.group, command.action])).toBe(true);
      const parameters = (command.positional ?? []).map((name) =>
        name === 'type' ? 'email' : `${name}-value`,
      );
      const configureFlags =
        command.group === 'zero-trust' && command.action === 'configure'
          ? [
              '--identity-providers',
              'idp-1',
              '--policies',
              'policy-1',
              '--existing-projects',
              'public',
              '--token-stdin',
            ]
          : [];
      const result = parsePlatformArgs([
        command.group,
        command.action,
        ...parameters,
        ...configureFlags,
      ]);
      expect(result).toMatchObject({
        subcommand: 'operator',
        group: command.group,
        action: command.action,
      });
    }
  });
  it('parses Zero Trust configuration and project overrides without accepting a token in argv', () => {
    expect(
      parseOperatorArgs([
        'zero-trust',
        'configure',
        '--identity-providers',
        'idp-1,idp-2',
        '--policies',
        'policy-1, policy-2',
        '--existing-projects',
        'public',
        '--protect-new-projects',
        '--token-stdin',
      ]),
    ).toMatchObject({
      method: 'POST',
      path: '/zero-trust/configure',
      tokenStdin: true,
      body: {
        identityProviderIds: ['idp-1', 'idp-2'],
        policyIds: ['policy-1', 'policy-2'],
        existingProjects: 'public',
        protectNewProjects: true,
      },
    });
    expect(parseOperatorArgs(['zero-trust', 'project-protect', 'project/id'])).toMatchObject({
      path: '/zero-trust/projects/project%2Fid',
      body: { protected: true },
    });
    expect(parseOperatorArgs(['zero-trust', 'project-public', 'project/id'])).toMatchObject({
      body: { protected: false },
    });
    // Reconfiguring an enabled installation omits the existing-project choice.
    const reconfigure = parseOperatorArgs([
      'zero-trust',
      'configure',
      '--identity-providers',
      'idp-1',
      '--policies',
      'policy-1',
      '--token-stdin',
    ]);
    expect(reconfigure.body).toEqual({
      identityProviderIds: ['idp-1'],
      policyIds: ['policy-1'],
      protectNewProjects: false,
    });
    expect(() =>
      parseOperatorArgs([
        'zero-trust',
        'configure',
        '--account',
        'account-1',
        '--identity-providers',
        'idp-1',
        '--policies',
        'policy-1',
        '--token-stdin',
      ]),
    ).toThrow("Unknown flag '--account'");
    expect(parseOperatorArgs(['zero-trust', 'status'])).toMatchObject({
      method: 'GET',
      path: '/zero-trust',
      query: {},
      body: {},
    });
    expect(parseOperatorArgs(['zero-trust', 'status', '--check'])).toMatchObject({
      method: 'GET',
      query: { check: 'true' },
      body: {},
    });
    expect(() =>
      parseOperatorArgs([
        'zero-trust',
        'configure',
        '--identity-providers',
        'idp-1',
        '--policies',
        'policy-1',
        '--existing-projects',
        'public',
      ]),
    ).toThrow('requires --token-stdin');
    expect(() =>
      parseOperatorArgs([
        'zero-trust',
        'configure',
        '--identity-providers',
        'idp-1',
        '--policies',
        'policy-1',
        '--existing-projects',
        'invalid',
        '--token-stdin',
      ]),
    ).toThrow('--existing-projects must be protected or public');
  });
  it('accepts explicit flags before the operator group and encodes IDs', () => {
    expect(
      parsePlatformArgs(['--connection', 'chosen', '--json', 'user', 'show', 'user /?x']),
    ).toMatchObject({ connection: 'chosen', json: true, path: '/users/user%20%2F%3Fx' });
    expect(
      parseOperatorArgs([
        'signup',
        'allow',
        'email',
        '*@example.com',
        '--note',
        'Operators only',
        '--plan',
      ]),
    ).toMatchObject({
      method: 'POST',
      body: { type: 'email', pattern: '*@example.com', note: 'Operators only' },
      plan: true,
    });
    expect(
      parseOperatorArgs([
        'signup',
        'allow',
        'identity',
        'company-sso',
        'Employee-42',
        '--note',
        'No email',
      ]),
    ).toMatchObject({
      path: '/signup/allow',
      method: 'POST',
      body: {
        type: 'identity',
        connectionId: 'company-sso',
        subject: 'Employee-42',
        note: 'No email',
      },
    });
    expect(
      parseOperatorArgs(['signup', 'disallow', 'identity', 'company-sso', 'Employee-42']),
    ).toMatchObject({
      path: '/signup/disallow',
      body: { type: 'identity', connectionId: 'company-sso', subject: 'Employee-42' },
    });
    expect(parsePlatformArgs(['--timeout', '600', 'user', 'delete', 'id'])).toMatchObject({
      timeoutMs: 600_000,
    });
    expect(
      parsePlatformArgs(['system', 'sandbox-drain', '--plan', '--cursor', '{"phase":"resources"}']),
    ).toMatchObject({
      method: 'POST',
      plan: true,
      body: { cursor: '{"phase":"resources"}' },
    });
    expect(
      parsePlatformArgs(['project', 'owner', 'project / 1', 'user-2', '--plan']),
    ).toMatchObject({
      path: '/projects/project%20%2F%201/owner',
      method: 'POST',
      body: { userId: 'user-2' },
      plan: true,
    });
  });
  it('routes the email group to the operator email endpoints', () => {
    expect(parseOperatorArgs(['email', 'policy'])).toMatchObject({
      method: 'GET',
      path: '/email/policy',
    });
    expect(
      parseOperatorArgs(['email', 'policy-set', 'domains', '--domains', 'a.example,b.example']),
    ).toMatchObject({
      method: 'POST',
      path: '/email/policy',
      body: { mode: 'domains', domains: 'a.example,b.example' },
    });
    expect(parseOperatorArgs(['email', 'settings-set', '--domains', 'admin'])).toMatchObject({
      method: 'POST',
      path: '/email/settings',
      body: { domains: 'admin' },
    });
    expect(
      parseOperatorArgs(['email', 'limit', 'my/slug', '--monthly', '500', '--burst', '20']),
    ).toMatchObject({
      method: 'POST',
      path: '/email/projects/my%2Fslug/limit',
      body: { monthly: '500', burst: '20' },
    });
    expect(() => parseOperatorArgs(['email', 'policy', '--domains', 'x'])).toThrow();
    expect(() => parseOperatorArgs(['email', 'limit'])).toThrow();
    expect(
      parseOperatorArgs(['email', 'logs', 'project/id', '--page', '2', '--limit', '100']),
    ).toMatchObject({
      method: 'GET',
      path: '/email/projects/project%2Fid/logs',
      query: { page: '2', limit: '100' },
    });
    expect(() => parseOperatorArgs(['email', 'logs', 'project', '--limit', '101'])).toThrow();
    expect(() => parseOperatorArgs(['email', 'logs', 'project', '--follow'])).toThrow();
  });
  it('routes deployment asset migration and its resume cursor through mutation help', () => {
    expect(
      parsePlatformArgs([
        'deployment',
        'migrate-assets',
        'deployment / id',
        '--cursor',
        'opaque-cursor',
        '--plan',
      ]),
    ).toMatchObject({
      method: 'POST',
      path: '/deployments/deployment%20%2F%20id/migrate-assets',
      body: { cursor: 'opaque-cursor' },
      plan: true,
    });
    expect(() =>
      parseOperatorArgs(['deployment', 'migrate-assets', 'id', '--plan', '--yes']),
    ).toThrow('--plan and --yes cannot be combined');
  });
  it('routes proxy token rotation with its project scope in the body', () => {
    expect(
      parsePlatformArgs([
        'system',
        'rotate-proxy-tokens',
        '--project',
        'proj_000000000001',
        '--plan',
      ]),
    ).toMatchObject({
      method: 'POST',
      path: '/system/rotate-proxy-tokens',
      body: { project: 'proj_000000000001' },
      plan: true,
    });
    const all = parseOperatorArgs(['system', 'rotate-proxy-tokens', '--all', '--yes']);
    expect(all).toMatchObject({ method: 'POST', yes: true });
    expect(all.body.all).toBe(true);
    expect(parseOperatorArgs(['system', 'rotate-proxy-tokens', '--yes']).body).toEqual({});
    expect(() => parseOperatorArgs(['system', 'rotate-proxy-tokens', '--dry-run'])).toThrow(
      '--dry-run requires a value',
    );
    expect(() => parseOperatorArgs(['system', 'sandbox-drain', '--all'])).toThrow(
      "Unknown flag '--all'",
    );
  });
  it('routes asset migration inventory with bounded pagination', () => {
    expect(
      parsePlatformArgs(['system', 'asset-migrations', '--page', '2', '--limit', '100']),
    ).toMatchObject({
      method: 'GET',
      path: '/system/asset-migrations',
      query: { page: '2', limit: '100' },
      body: {},
    });
    expect(() => parseOperatorArgs(['system', 'asset-migrations', '--limit', '101'])).toThrow(
      '--limit must be an integer from 1 to 100',
    );
    expect(() => parseOperatorArgs(['system', 'asset-migrations', '--page', '0'])).toThrow(
      '--page must be an integer from 1 to 1000000',
    );
    expect(() => parseOperatorArgs(['system', 'asset-migrations', '--yes'])).toThrow(
      "Unknown flag '--yes'",
    );
  });
  it('routes attempt inspection and attested resolution with a bounded audit reason', () => {
    expect(
      parseOperatorArgs(['email', 'attempts', '--project', 'my-project', '--page', '2']),
    ).toMatchObject({
      method: 'GET',
      path: '/email/attempts',
      query: { project: 'my-project', page: '2' },
    });
    expect(
      parseOperatorArgs([
        'email',
        'attempt-resolve',
        'attempt/id',
        '--ended',
        '--reason',
        'Worker execution ended',
        '--yes',
      ]),
    ).toMatchObject({
      method: 'POST',
      path: '/email/attempts/attempt%2Fid/resolve',
      body: { ended: true, reason: 'Worker execution ended' },
      yes: true,
    });
    expect(() => parseOperatorArgs(['email', 'attempts', '--ended'])).toThrow();
    expect(
      parseOperatorArgs([
        'email',
        'operation-resolve',
        'operation/id',
        '--ended',
        '--outcome',
        'not-applied',
        '--reason',
        'Provider audit completed',
      ]),
    ).toMatchObject({
      method: 'POST',
      path: '/email/operations/operation%2Fid/resolve',
      body: {
        ended: true,
        outcome: 'not-applied',
        reason: 'Provider audit completed',
      },
    });
  });
  it('pages shared recipient inspection', () => {
    expect(
      parseOperatorArgs([
        'email',
        'shared-recipients',
        '--project',
        'app',
        '--page',
        '2',
        '--limit',
        '10',
      ]),
    ).toMatchObject({
      method: 'GET',
      path: '/email/shared-recipients',
      query: { project: 'app', page: '2', limit: '10' },
    });
  });
  it('routes the email domain verbs', () => {
    expect(
      parseOperatorArgs([
        'email',
        'shared-recipient-resolve',
        'erec/id',
        '--ended',
        '--outcome',
        'not-applied',
        '--reason',
        'Provider audit confirms absence',
        '--yes',
      ]),
    ).toMatchObject({
      method: 'POST',
      path: '/email/shared-recipients/erec%2Fid/resolve',
      body: { ended: true, outcome: 'not-applied', reason: 'Provider audit confirms absence' },
      yes: true,
    });
    expect(parseOperatorArgs(['email', 'domains', '--project', 'hr-portal'])).toMatchObject({
      method: 'GET',
      path: '/email/domains',
      query: { project: 'hr-portal' },
    });
    expect(
      parseOperatorArgs([
        'email',
        'domain-add',
        'mail.example.com',
        '--project',
        'hr-portal',
        '--token-stdin',
        '--yes',
      ]),
    ).toMatchObject({
      method: 'POST',
      path: '/email/domains',
      body: { domain: 'mail.example.com', project: 'hr-portal' },
      tokenStdin: true,
      yes: true,
    });
    const outboundOnly = parseOperatorArgs([
      'email',
      'domain-add',
      'brand.example.com',
      '--project',
      'hr-portal',
      '--outbound-only',
    ]);
    expect(outboundOnly.body).toEqual({
      domain: 'brand.example.com',
      project: 'hr-portal',
      outboundOnly: true,
    });
    expect(parseOperatorArgs(['email', 'domain-status', 'mail.example.com'])).toMatchObject({
      method: 'GET',
      path: '/email/domains/mail.example.com',
    });
    expect(parseOperatorArgs(['email', 'domain-sync', 'mail.example.com'])).toMatchObject({
      method: 'POST',
      path: '/email/domains/mail.example.com/sync',
      body: {},
    });
    expect(parseOperatorArgs(['email', 'domain-rotate-secret', 'mail.example.com'])).toMatchObject({
      method: 'POST',
      path: '/email/domains/mail.example.com/rotate-secret',
      body: {},
    });
    expect(parseOperatorArgs(['email', 'domain-remove', 'mail.example.com']).body).toEqual({});
    expect(
      parseOperatorArgs(['email', 'domain-remove', 'mail.example.com', '--token-stdin', '--yes']),
    ).toMatchObject({
      method: 'POST',
      path: '/email/domains/mail.example.com/remove',
      body: {},
      tokenStdin: true,
      yes: true,
    });
    expect(() => parseOperatorArgs(['email', 'domain-remove', 'x', '--force'])).toThrow(
      "Unknown flag '--force'",
    );
    expect(() => parseOperatorArgs(['email', 'domain-sync', 'x', '--force'])).toThrow(
      "Unknown flag '--force'",
    );
    expect(() => parseOperatorArgs(['email', 'domain-add', 'x', '--force'])).toThrow(
      "Unknown flag '--force'",
    );
  });
  it.each([
    ['user', 'list', '--limit', '101'],
    ['user', 'list', '--page', '1e3'],
    ['user', 'list', '--yes'],
    ['user', 'delete', 'id', '--yes', '--plan'],
    ['user', 'show', '..'],
    ['user', 'list', '--json', '--json'],
    ['user', 'list', '--search'],
    ['user', 'list', '--wat', 'value'],
    ['build', 'logs', 'id', '--since', '-1'],
    ['build', 'logs', 'id', '--since', '9007199254740992'],
    ['worker', 'rollback', 'api', 'version', '--environment', 'preview'],
    ['signup', 'allow', 'typo', '*'],
    ['signup', 'allow', 'identity', 'company-sso'],
    ['signup', 'allow', 'identity', 'Company', 'employee'],
    ['signup', 'disallow', 'identity', 'company', 'employee', 'extra'],
    ['signup', 'remove', 'identity', 'company'],
    ['auth', 'login', '--yes'],
    ['user', 'delete', 'id', '--timeout', '0'],
    ['user', 'delete', 'id', '--timeout', '3601'],
    ['user', 'delete', 'id', '--timeout', '1.5'],
    ['user', 'show', 'id', '--timeout', '60'],
  ])('rejects malformed command %j', (...args) => {
    expect(() => parseOperatorArgs(args)).toThrow();
  });
});

describe('operator credential isolation', () => {
  it('resolves an installation slug without changing the active connection', () => {
    const manifest = createPlatformInstallationManifest({
      account: { id: 'account', name: 'Account' },
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment: createPlatformDeploymentManifest({
        application: { baseDomain: 'example.com', zoneName: 'example.com' },
        displayName: 'Example',
        installationSlug: 'example',
      }),
      id: 'example-a1b2c3d4',
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    writeInstallationManifest(manifest);
    const installed = savePlatformConnection({
      accountId: manifest.account.id,
      apiUrl: 'https://api.example.com',
      applicationDomain: 'example.com',
      displayName: 'Friendly platform name',
      installationId: manifest.id,
      kind: 'installed',
      proxyUrl: null,
    });
    const active = connect('https://other.example.com');
    expect(resolveOperatorOrigin('example')).toBe(installed.apiUrl);
    expect(getActivePlatformConnection()?.id).toBe(active.id);
    expect(keyring.read).not.toHaveBeenCalled();
  });
  it('uses only registered explicit connections, without changing the active connection', () => {
    const first = connect('https://one.example');
    const second = connect('https://two.example');
    vi.stubEnv('VOID_API_URL', 'https://override.example');
    expect(resolveOperatorOrigin(first.id)).toBe(first.apiUrl);
    expect(getActivePlatformConnection()?.id).toBe(second.id);
    expect(resolveOperatorOrigin()).toBe('https://override.example');
    expect(() => resolveOperatorOrigin('https://unregistered.example')).toThrow('registered');
  });
  it('rejects headless credentials with an implicit origin', () => {
    const connection = connect('https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    expect(() => resolveOperatorOrigin()).toThrow('explicit');
    expect(resolveOperatorOrigin(connection.id)).toBe(connection.apiUrl);
  });
  it('never falls back to a deploy token and keeps operator credentials in a separate service', () => {
    expect(() => readOperatorToken('https://one.example')).toThrow('No operator session');
    saveOperatorToken('https://one.example', 'operator');
    expect(keyring.write).toHaveBeenCalledWith(
      OPERATOR_KEYRING_SERVICE,
      expect.stringMatching(/^platform:/),
      'operator',
    );
    keyring.write.mockReturnValue(false);
    expect(() => saveOperatorToken('https://one.example', 'operator')).toThrow('keychain');
  });
});

describe('deployment asset migration', () => {
  const target = 'deployment / id';
  const preview = (expected = 'digest-1') => ({
    dryRun: true,
    action: 'deployment.migrate-assets',
    target,
    expected,
    assets: 2,
  });
  const applied = (nextCursor: string | null) => ({
    dryRun: false,
    action: 'deployment.migrate-assets',
    target,
    complete: nextCursor === null,
    nextCursor,
    verified: 2,
  });
  beforeEach(() => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  it.each([false, true])(
    'reads asset inventory without a mutation in JSON=%s mode',
    async (json) => {
      const inventory = {
        deployments: [
          {
            id: 'deployment-1',
            projectId: 'project-1',
            slug: 'example',
            active: true,
            retained: true,
            bundleStored: true,
            assets: 2,
            needsMigration: 2,
            invalid: false,
          },
        ],
        pagination: { page: 2, limit: 100, total: 102, totalPages: 2 },
      };
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(inventory));
      vi.stubGlobal('fetch', fetcher);
      await runOperatorCommand(
        parseOperatorArgs([
          'system',
          'asset-migrations',
          '--page',
          '2',
          '--limit',
          '100',
          ...(json ? ['--json'] : []),
        ]),
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(String(fetcher.mock.calls[0]![0])).toBe(
        'https://one.example/operator/v1/system/asset-migrations?page=2&limit=100',
      );
      expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'GET' });
      expect(fetcher.mock.calls[0]![1]!.body).toBeUndefined();
      if (json) {
        expect(console.log).toHaveBeenCalledWith(JSON.stringify(inventory));
      } else {
        const printed = vi
          .mocked(console.log)
          .mock.calls.map(([line]) => String(line))
          .join('\n');
        expect(printed).toContain('Needs migration: 2');
        expect(printed).toContain('Invalid: false');
        expect(printed).toContain('Bundle stored: true');
        expect(printed).toContain('Total pages: 2');
        expect(printed).toContain('Deployments:');
      }
    },
  );
  it('previews only the requested starting batch in plan mode', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(preview()));
    vi.stubGlobal('fetch', fetcher);
    await runOperatorCommand(
      parseOperatorArgs([
        'deployment',
        'migrate-assets',
        target,
        '--cursor',
        'resume-cursor',
        '--plan',
        '--json',
      ]),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      'https://one.example/operator/v1/deployments/deployment%20%2F%20id/migrate-assets',
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({
      cursor: 'resume-cursor',
      dryRun: true,
    });
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('all remaining asset batches'),
    );
  });
  it('previews and pins every batch until complete, retaining each successful cursor', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(preview('digest-1')))
      .mockResolvedValueOnce(Response.json(applied('cursor-1')))
      .mockResolvedValueOnce(Response.json(preview('digest-2')))
      .mockResolvedValueOnce(Response.json(applied(null)));
    vi.stubGlobal('fetch', fetcher);
    await runOperatorCommand(
      parseOperatorArgs(['deployment', 'migrate-assets', target, '--yes', '--json']),
    );
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init!.body)))).toEqual([
      { dryRun: true },
      { expected: 'digest-1' },
      { cursor: 'cursor-1', dryRun: true },
      { cursor: 'cursor-1', expected: 'digest-2' },
    ]);
    expect(vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      applied('cursor-1'),
      applied(null),
    ]);
    expect(process.stderr.write).not.toHaveBeenCalled();
  });
  it('applies the exact resumed cursor and stops at completed migration', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(preview()))
      .mockResolvedValueOnce(Response.json(applied(null)));
    vi.stubGlobal('fetch', fetcher);
    await runOperatorCommand(
      parseOperatorArgs([
        'deployment',
        'migrate-assets',
        target,
        '--cursor',
        'resume-cursor',
        '--yes',
      ]),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({
      cursor: 'resume-cursor',
      expected: 'digest-1',
    });
  });
  it('asks once before continuing all previewed batches in an interactive terminal', async () => {
    vi.stubGlobal('process', {
      ...process,
      stdin: { ...process.stdin, isTTY: true },
      stderr: { ...process.stderr, isTTY: true, write: vi.fn() },
    });
    mutationPrompt.question.mockResolvedValue('yes');
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(preview()))
      .mockResolvedValueOnce(Response.json(applied('cursor-1')))
      .mockResolvedValueOnce(Response.json(preview('digest-2')))
      .mockResolvedValueOnce(Response.json(applied(null)));
    vi.stubGlobal('fetch', fetcher);
    await runOperatorCommand(parseOperatorArgs(['deployment', 'migrate-assets', target]));
    expect(mutationPrompt.question).toHaveBeenCalledTimes(1);
    expect(mutationPrompt.close).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(process.stderr.write).toHaveBeenCalledTimes(2);
  });
  it.each([
    { action: 'deployment.delete' },
    { target: 'another-deployment' },
    { expected: '' },
    { expected: null },
    { dryRun: false },
  ])('rejects an invalid asset preview %j before applying', async (changes) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...preview(), ...changes }));
    vi.stubGlobal('fetch', fetcher);
    await expect(
      runOperatorCommand(parseOperatorArgs(['deployment', 'migrate-assets', target, '--yes'])),
    ).rejects.toMatchObject({ code: 'invalid_preview' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { nextCursor: undefined },
    { nextCursor: '' },
    { nextCursor: 1 },
    { nextCursor: 'resume-cursor' },
    { complete: true },
    { action: 'deployment.delete' },
    { target: 'another-deployment' },
  ])('stops after a malformed or repeated continuation %j without retrying', async (changes) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(preview()))
      .mockResolvedValueOnce(Response.json({ ...applied('cursor-1'), ...changes }));
    vi.stubGlobal('fetch', fetcher);
    await expect(
      runOperatorCommand(
        parseOperatorArgs([
          'deployment',
          'migrate-assets',
          target,
          '--cursor',
          'resume-cursor',
          '--yes',
        ]),
      ),
    ).rejects.toMatchObject({
      code: 'invalid_response',
      details: { lastSuccessfulCursor: 'resume-cursor' },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('detects a cursor cycle after multiple successful batches', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(preview()))
      .mockResolvedValueOnce(Response.json(applied('cursor-1')))
      .mockResolvedValueOnce(Response.json(preview('digest-2')))
      .mockResolvedValueOnce(Response.json(applied('cursor-2')))
      .mockResolvedValueOnce(Response.json(preview('digest-3')))
      .mockResolvedValueOnce(Response.json(applied('cursor-1')));
    vi.stubGlobal('fetch', fetcher);
    await expect(
      runOperatorCommand(parseOperatorArgs(['deployment', 'migrate-assets', target, '--yes'])),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(console.log).toHaveBeenCalledTimes(2);
  });
  it('keeps the last successful cursor and never retries an ambiguous later apply', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(preview()))
      .mockResolvedValueOnce(Response.json(applied('cursor-1')))
      .mockResolvedValueOnce(Response.json(preview('digest-2')))
      .mockRejectedValueOnce(new Error('connection lost'));
    vi.stubGlobal('fetch', fetcher);
    await expect(
      runOperatorCommand(parseOperatorArgs(['deployment', 'migrate-assets', target, '--yes'])),
    ).rejects.toMatchObject({ code: 'connection_failed' });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('cursor-1'));
  });
});

describe('operator transport and execution', () => {
  it('encodes queries and refuses credential-bearing redirects without retrying', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: 'https://evil.example' } }),
      );
    const client = new OperatorClient('https://one.example', 'operator', fetcher);
    await expect(
      client.request('/users', { query: { search: 'x&admin=1' } }),
    ).rejects.toMatchObject({ code: 'redirect_rejected' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      'https://one.example/operator/v1/users?search=x%26admin%3D1',
    );
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      redirect: 'manual',
      headers: { Authorization: 'Bearer operator' },
      signal: expect.any(AbortSignal),
    });
  });
  it('preserves structured partial errors and never retries mutations', async () => {
    const details = { completed: ['one'], failed: ['two'] };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: 'partial_failure', message: 'Some resources remain.', details },
          { status: 502 },
        ),
      );
    await expect(
      new OperatorClient('https://one.example', 'token', fetcher).request('/users/id/delete', {
        method: 'POST',
        body: {},
      }),
    ).rejects.toMatchObject({ code: 'partial_failure', details });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('names a disabled platform and how to restore it', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: 'Platform disabled' }, { status: 503 }));
    await expect(
      new OperatorClient('https://one.example', 'operator', fetcher).request('/users'),
    ).rejects.toMatchObject({
      code: 'Platform disabled',
      status: 503,
      message: 'Operator request failed (HTTP 503): Platform disabled. Run `void platform enable`.',
    });
  });
  it('does not suggest enabling a platform paused for an upgrade or repair', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ error: 'Platform disabled', reason: 'maintenance' }, { status: 503 }),
      );
    await expect(
      new OperatorClient('https://one.example', 'operator', fetcher).request('/users'),
    ).rejects.toMatchObject({
      code: 'Platform disabled',
      status: 503,
      message:
        'Operator request failed (HTTP 503): the platform is paused for an upgrade or repair. Retry when it finishes.',
    });
  });
  it('includes the error code when the API sends no message', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: 'not_found' }, { status: 404 }));
    await expect(
      new OperatorClient('https://one.example', 'operator', fetcher).request('/users/x'),
    ).rejects.toMatchObject({ message: 'Operator request failed (HTTP 404): not_found.' });
  });
  it('uses short read deadlines, longer mutation deadlines, and bounded overrides', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const client = new OperatorClient('https://one.example', 'operator', fetcher);

    await expect(
      client.request('/users/id/delete', { method: 'POST', body: {}, timeoutMs: 3_600_001 }),
    ).rejects.toMatchObject({ code: 'invalid_timeout' });
    expect(fetcher).not.toHaveBeenCalled();

    const read = client.request('/users');
    const readFailure = expect(read).rejects.toMatchObject({
      code: 'request_timeout',
      message: expect.stringContaining('Check connectivity'),
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await readFailure;

    const mutation = client.request('/users/id/delete', { method: 'POST', body: {} });
    await vi.advanceTimersByTimeAsync(30_000);
    expect((fetcher.mock.calls[1]![1]!.signal as AbortSignal).aborted).toBe(false);
    const mutationFailure = expect(mutation).rejects.toMatchObject({
      code: 'request_timeout',
      message: expect.stringContaining('outcome may be unknown'),
    });
    await vi.advanceTimersByTimeAsync(270_000);
    await mutationFailure;

    const overridden = client.request('/users/id/delete', {
      method: 'POST',
      body: {},
      timeoutMs: 2_000,
    });
    const overrideFailure = expect(overridden).rejects.toMatchObject({
      code: 'request_timeout',
      message: expect.stringContaining('2-second timeout'),
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await overrideFailure;
    vi.useRealTimers();
  });
  it('requires authorization before preview and validates preview before executing', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    await expect(runOperatorCommand(parseOperatorArgs(['user', 'delete', 'id']))).rejects.toThrow(
      '--yes',
    );
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      runOperatorCommand(parseOperatorArgs(['user', 'delete', 'id', '--yes'])),
    ).rejects.toThrow('valid mutation preview');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('performs plan only and pins rollback-all execution to previewed versions', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const preview = {
      dryRun: true,
      action: 'workers.rollback-all',
      target: 'production',
      versions: { api: 'version-a' },
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(preview));
    vi.stubGlobal('fetch', fetcher);
    await runOperatorCommand(parseOperatorArgs(['worker', 'rollback-all', '--plan', '--json']));
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockClear();
    await runOperatorCommand(parseOperatorArgs(['worker', 'rollback-all', '--yes']));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({
      versions: { api: 'version-a' },
    });
  });
  it('pins project normalization to its previewed database changes', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const changes = { activeDeployment: { from: null, to: 'dpl_older' }, queues: [] };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ dryRun: true, action: 'project.normalize', target: 'proj_1', changes }),
      );
    vi.stubGlobal('fetch', fetcher);
    await runOperatorCommand(parseOperatorArgs(['project', 'normalize', 'proj_1', '--yes']));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({ expected: changes });
  });
  it.each(['--plan', '--yes'])(
    'reads a cleanup token once for %s without printing it',
    async (mode) => {
      vi.stubEnv('VOID_API_URL', 'https://one.example');
      vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const stdin = vi
        .spyOn(process.stdin, Symbol.asyncIterator)
        .mockImplementation(async function* () {
          yield 'replacement-cloudflare-token\n';
          return undefined;
        });
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({
            dryRun: true,
            action: 'email.domain.remove',
            target: { domain: 'mail.example.com', credentialReplacement: true },
          }),
        )
        .mockResolvedValueOnce(Response.json({ operationStatus: 'completed' }));
      vi.stubGlobal('fetch', fetcher);
      await runOperatorCommand(
        parseOperatorArgs(['email', 'domain-remove', 'mail.example.com', '--token-stdin', mode]),
      );
      expect(stdin).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(mode === '--plan' ? 1 : 2);
      expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({
        apiToken: 'replacement-cloudflare-token',
        dryRun: true,
      });
      if (mode === '--yes') {
        expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({
          apiToken: 'replacement-cloudflare-token',
        });
      }
      expect(JSON.stringify([output.mock.calls, stderr.mock.calls])).not.toContain(
        'replacement-cloudflare-token',
      );
    },
  );
  it('prints email recipient outcomes through the operator logs command', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          projectId: 'project-1',
          page: 1,
          limit: 20,
          logs: [
            {
              operationId: 'action-1',
              recipient: 'one@example.com',
              status: 'provider_accepted',
              transport: 'binding',
            },
          ],
        }),
      ),
    );
    await runOperatorCommand(parseOperatorArgs(['email', 'logs', 'project-1']));
    const printed = output.mock.calls.flat().join('\n');
    expect(printed).toContain('one@example.com');
    expect(printed).toContain('provider_accepted');
  });
  it('previews then submits an attested email attempt resolution', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          dryRun: true,
          action: 'email.attempt.resolve',
          target: { attemptId: 'er_1' },
        }),
      )
      .mockResolvedValueOnce(Response.json({ state: 'outcome_unknown', charged: true }));
    vi.stubGlobal('fetch', fetcher);
    await runOperatorCommand(
      parseOperatorArgs([
        'email',
        'attempt-resolve',
        'er_1',
        '--ended',
        '--reason',
        'Worker execution ended',
        '--yes',
      ]),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      'https://one.example/operator/v1/email/attempts/er_1/resolve',
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({
      ended: true,
      reason: 'Worker execution ended',
      dryRun: true,
    });
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({
      ended: true,
      reason: 'Worker execution ended',
    });
  });
  it('pins email operation recovery execution to the previewed step fence', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          dryRun: true,
          action: 'email.operation.resolve',
          target: {
            operationId: 'eop_1',
            stepId: 'estep_1',
            attempt: 2,
            requestDigest: 'digest-1',
            resourceIdentity: 'account/zone/worker/relay/7',
            connectionId: 'ezc_1',
            desiredGeneration: 4,
            routeId: 'edr_1',
            routeDesiredGeneration: 3,
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ status: 'pending' }));
    vi.stubGlobal('fetch', fetcher);
    await runOperatorCommand(
      parseOperatorArgs([
        'email',
        'operation-resolve',
        'eop_1',
        '--ended',
        '--outcome',
        'applied',
        '--reason',
        'Exact provider resource verified',
        '--yes',
      ]),
    );
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({
      ended: true,
      outcome: 'applied',
      reason: 'Exact provider resource verified',
      stepId: 'estep_1',
      attempt: 2,
      requestDigest: 'digest-1',
      resourceIdentity: 'account/zone/worker/relay/7',
      connectionId: 'ezc_1',
      desiredGeneration: 4,
      routeId: 'edr_1',
      routeDesiredGeneration: 3,
    });
  });
  it('pins shared recipient recovery to the inspected preview and rejects missing fences', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator-token');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          dryRun: true,
          action: 'email.shared-recipient.resolve',
          target: { recoveryFence: 'a'.repeat(64) },
        }),
      )
      .mockResolvedValueOnce(Response.json({ status: 'pending' }));
    vi.stubGlobal('fetch', fetcher);
    const args = parseOperatorArgs([
      'email',
      'shared-recipient-resolve',
      'erec_1',
      '--ended',
      '--outcome',
      'not-applied',
      '--reason',
      'Provider audit completed',
      '--yes',
    ]);
    await runOperatorCommand(args);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({
      ended: true,
      outcome: 'not-applied',
      reason: 'Provider audit completed',
      recoveryFence: 'a'.repeat(64),
    });
    fetcher
      .mockReset()
      .mockResolvedValueOnce(
        Response.json({ dryRun: true, action: 'email.shared-recipient.resolve', target: {} }),
      );
    await expect(runOperatorCommand(args)).rejects.toMatchObject({ code: 'invalid_preview' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('stops an outbound-only add when the platform preview ignores the mode', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const preview = (target: Record<string, unknown>) =>
      Response.json({ dryRun: true, action: 'email.domain.add', target });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(preview({ domain: 'brand.example.com' }));
    vi.stubGlobal('fetch', fetcher);
    const args = parseOperatorArgs([
      'email',
      'domain-add',
      'brand.example.com',
      '--project',
      'hr-portal',
      '--outbound-only',
      '--yes',
    ]);
    await expect(runOperatorCommand(args)).rejects.toMatchObject({ code: 'unsupported' });
    expect(fetcher).toHaveBeenCalledTimes(1);

    fetcher
      .mockReset()
      .mockResolvedValueOnce(preview({ domain: 'brand.example.com', inboundMode: 'none' }))
      .mockResolvedValueOnce(Response.json({ domain: { operationStatus: 'completed' } }));
    await runOperatorCommand(args);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({
      domain: 'brand.example.com',
      project: 'hr-portal',
      outboundOnly: true,
    });
  });
  it('drains runtime cursors and rejects repeated cursors instead of spinning', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ data: [], nextCursor: 'page-2', watermark: '2030-01-01T00:00:00Z' }),
      );
    await expect(
      followOperatorLogs(
        new OperatorClient('https://one.example', 'token', fetcher),
        parseOperatorArgs(['deployment', 'logs', 'id', '--follow', '--since', '1h']),
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]![0])).toContain('cursor=page-2');
    expect(String(fetcher.mock.calls[1]![0])).toContain('since=1h');
  });
  it('follows ingestion cursors with overlap dedupe and preserves identical row counts', async () => {
    const controller = new AbortController();
    const repeated = {
      timestamp: 1000,
      ingestedAt: 1900,
      method: 'GET',
      url: '/same',
      status: '200',
      logs: [],
      exceptions: [],
    };
    const completedLate = {
      timestamp: 1500,
      ingestedAt: 2500,
      method: 'POST',
      url: '/completed-late',
      status: '201',
      logs: [],
      exceptions: [],
    };
    const write = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ data: [repeated], nextCursor: null, watermark: '2000' }),
      )
      .mockImplementationOnce(async () => {
        controller.abort();
        return Response.json({
          data: [repeated, repeated, completedLate],
          nextCursor: null,
          watermark: '3000',
        });
      });

    await followOperatorLogs(
      new OperatorClient('https://one.example', 'token', fetcher),
      parseOperatorArgs(['deployment', 'logs', 'id', '--follow', '--since', '1h']),
      controller.signal,
      0,
    );

    const lines = write.mock.calls.map(([line]) => String(line));
    expect(lines.filter((line) => line.includes('/same'))).toHaveLength(2);
    expect(lines.filter((line) => line.includes('/completed-late'))).toHaveLength(1);
    expect(String(fetcher.mock.calls[0]![0])).toContain('since=1h');
    expect(String(fetcher.mock.calls[1]![0])).toContain('after=2000');
    expect(String(fetcher.mock.calls[1]![0])).not.toContain('since=');
  });
  it('fails explicitly when a runtime follow window exceeds its dedupe bound', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const row = {
      timestamp: 1000,
      ingestedAt: 1900,
      method: 'GET',
      url: '/same',
      status: '200',
      logs: [],
      exceptions: [],
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: Array.from({ length: 10_001 }, () => row),
        nextCursor: null,
        watermark: '2000',
      }),
    );

    await expect(
      followOperatorLogs(
        new OperatorClient('https://one.example', 'token', fetcher),
        parseOperatorArgs(['deployment', 'logs', 'id', '--follow']),
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('renders deployment status, log messages, and exceptions in human output', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    const write = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          data: [
            {
              timestamp: 1234,
              method: 'GET',
              url: '/broken',
              status: '503',
              outcome: 'exception',
              logs: [{ level: 'error', message: 'request failed' }],
              exceptions: [{ name: 'TypeError', message: 'missing value' }],
            },
          ],
          nextCursor: null,
          watermark: '1235',
        }),
      ),
    );

    await runOperatorCommand(parseOperatorArgs(['deployment', 'logs', 'deployment-1']));

    expect(write.mock.calls.map(([line]) => String(line))).toEqual([
      '1234 GET /broken 503',
      '  [error] request failed',
      '  TypeError: missing value',
    ]);
  });

  it('neutralizes C1 terminal controls in human operator output', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    const write = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          data: [
            {
              timestamp: 1234,
              method: 'GET',
              url: '/x\u009b2J',
              status: '503',
              outcome: 'exception',
              logs: [{ level: 'error', message: ['hi \u009b2J', '\u009d52;c;ZXZpbA==\u009c'] }],
              exceptions: [{ name: 'Error\u009b', message: 'bad\u009b31m' }],
            },
          ],
          nextCursor: null,
          watermark: '1235',
        }),
      ),
    );

    await runOperatorCommand(parseOperatorArgs(['deployment', 'logs', 'deployment-1']));

    const lines = write.mock.calls.map(([line]) => String(line));
    expect(lines).toEqual([
      '1234 GET /x 2J 503',
      '  [error] ["hi  2J"," 52;c;ZXZpbA== "]',
      '  Error : bad 31m',
    ]);
    expect(lines.some((line) => /[\u0080-\u009f]/.test(line))).toBe(false);
  });

  it('renders every worker and audit event field without table-column truncation', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    const write = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          batchId: 'batch-1',
          environment: 'production',
          events: [
            {
              id: 'event-1',
              batch_id: 'batch-1',
              action: 'rollback_all',
              worker_name: 'api',
              environment: 'production',
              version_id: 'version-failed',
              script_name: 'void-api',
              status: 'failed',
              error_message: 'Version no longer exists.',
              auditError: 'Could not persist the outcome.',
              admin_login: 'operator',
              created_at: '2030-01-01T00:00:00Z',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          events: [
            {
              id: 'audit-1',
              login: 'operator',
              action: 'workers/api/rollback',
              target: '{"worker":"api","versionId":"version-failed"}',
              status: 'failed',
              http_status: 207,
              created_at: '2030-01-01T00:00:00Z',
            },
          ],
          page: 1,
          limit: 25,
          total: 1,
        }),
      );
    vi.stubGlobal('fetch', fetcher);

    await runOperatorCommand(parseOperatorArgs(['worker', 'events', 'batch-1']));
    await runOperatorCommand(parseOperatorArgs(['system', 'events']));

    const rendered = write.mock.calls.map(([line]) => String(line)).join('\n');
    expect(rendered).toContain('Version ID: version-failed');
    expect(rendered).toContain('Error message: Version no longer exists.');
    expect(rendered).toContain('Audit error: Could not persist the outcome.');
    expect(rendered).toContain('Action: workers/api/rollback');
    expect(rendered).toContain('Target: {"worker":"api","versionId":"version-failed"}');
  });

  it('renders sentence-case field labels that keep known acronyms', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    const write = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          apiVersion: 3,
          githubOAuth: true,
          customDomains: false,
          callbackUrl: 'https://one.example/auth/callback',
          installation_id: 'install-1',
          http_status: 200,
          capabilities: { workerIds: 2 },
        }),
      ),
    );

    await runOperatorCommand(parseOperatorArgs(['system', 'health']));

    expect(write.mock.calls.map(([line]) => String(line)).join('\n')).toBe(
      [
        'API version: 3',
        'GitHub OAuth: true',
        'Custom domains: false',
        'Callback URL: https://one.example/auth/callback',
        'Installation ID: install-1',
        'HTTP status: 200',
        'Capabilities:',
        '  Worker IDs: 2',
      ].join('\n'),
    );
  });

  it('follows build log sequence and stops when terminal', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        lines: [{ seq: 3, text: 'done' }],
        lastSeq: 3,
        terminal: true,
        logsComplete: true,
      }),
    );
    await followOperatorLogs(
      new OperatorClient('https://one.example', 'token', fetcher),
      parseOperatorArgs(['build', 'logs', 'id', '--follow', '--since', '2', '--json']),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toContain('since=2');
  });

  it('waits for drain completion across stable terminal pages and prints a delayed marker', async () => {
    const write = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ lines: [], lastSeq: 3, terminal: true, logsComplete: false }),
      )
      .mockResolvedValueOnce(
        Response.json({ lines: [], lastSeq: 3, terminal: true, logsComplete: false }),
      )
      .mockResolvedValueOnce(
        Response.json({
          lines: [{ seq: 4, line: '[build-manager] container terminated: timed out' }],
          lastSeq: 4,
          terminal: true,
          logsComplete: true,
        }),
      );

    await followOperatorLogs(
      new OperatorClient('https://one.example', 'token', fetcher),
      parseOperatorArgs(['build', 'logs', 'id', '--follow', '--since', '3', '--json']),
      undefined,
      0,
    );

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('since')),
    ).toEqual(['3', '3', '3']);
    expect(write.mock.calls.map(([line]) => String(line)).join('\n')).toContain(
      'container terminated: timed out',
    );
  });

  it('fails within a bound when a terminal producer never confirms completion', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      now += 60_000;
      return Response.json({ lines: [], lastSeq: 3, terminal: true, logsComplete: false });
    });

    await expect(
      followOperatorLogs(
        new OperatorClient('https://one.example', 'token', fetcher),
        parseOperatorArgs(['build', 'logs', 'id', '--follow', '--since', '3', '--json']),
        undefined,
        0,
      ),
    ).rejects.toThrow('did not confirm completion');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, null])(
    'requires an upgrade instead of declaring logs complete for a terminal response with %s completion state',
    async (logsComplete) => {
      const write = vi.spyOn(console, 'log').mockImplementation(() => {});
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          lines: [{ seq: 3, line: 'retained final row' }],
          lastSeq: 3,
          terminal: true,
          logsComplete,
        }),
      );

      await expect(
        followOperatorLogs(
          new OperatorClient('https://one.example', 'token', fetcher),
          parseOperatorArgs(['build', 'logs', 'id', '--follow', '--since', '2', '--json']),
          undefined,
          0,
        ),
      ).rejects.toMatchObject({
        code: 'log_completion_unavailable',
        message: expect.stringContaining('Upgrade the platform runtime'),
      });

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(write.mock.calls.map(([line]) => String(line)).join('\n')).toContain(
        'retained final row',
      );
    },
  );

  it('reads historical build logs without following when completion state is absent', async () => {
    const write = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        lines: [{ seq: 3, line: 'historical row' }],
        lastSeq: 3,
        terminal: true,
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator-token');
    vi.stubEnv('VOID_API_URL', 'https://one.example');

    await runOperatorCommand(parseOperatorArgs(['build', 'logs', 'id', '--json']));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(write.mock.calls.map(([line]) => String(line)).join('\n')).toContain('historical row');
  });
});
