import { describe, expect, it } from 'vite-plus/test';
import { parsePlatformArgs } from '../../src/cli/platform-args.ts';
import { assertNoninteractivePlatformMutationAcknowledged } from '../../src/cli/platform-lifecycle.ts';

describe('platform args', () => {
  it('accepts explicit planned choices and rejects contradictory configuration', () => {
    expect(
      parsePlatformArgs([
        'install',
        '--no-control-plane-domain',
        '--no-dedicated-zone',
        '--hyperdrive',
        'drive-id',
        '--login-methods',
        'google,oidc',
        '--no-access-protection',
      ]),
    ).toMatchObject({
      noControlPlaneDomain: true,
      dedicatedZoneSpecified: true,
      hyperdrive: 'drive-id',
      loginMethods: ['google', 'oidc'],
      accessProtection: false,
    });
    for (const flags of [
      ['--control-plane-domain', 'api.example.com', '--no-control-plane-domain'],
      ['--dedicated-zone', '--no-dedicated-zone'],
      ['--access-protection', '--no-access-protection'],
      ['--auth-config', 'auth.json', '--login-methods', 'github'],
      ['--auth-config', 'auth.json', '--access-protection'],
      ['--login-methods', 'unknown'],
      ['--login-methods', 'github,'],
    ]) {
      expect(() => parsePlatformArgs(['install', ...flags])).toThrow();
    }
  });

  it('configures dashboard origins only in install, upgrade, and repair', () => {
    for (const command of ['install', 'upgrade', 'repair']) {
      expect(
        parsePlatformArgs([command, '--dashboard-url', 'https://DASH.example.com:8443/']),
      ).toMatchObject({ dashboardUrl: 'https://dash.example.com:8443' });
      expect(parsePlatformArgs([command])).not.toHaveProperty('dashboardUrl');
      expect(() =>
        parsePlatformArgs([command, '--dashboard-url', 'https://dash.example.com/account']),
      ).toThrow('HTTPS origin');
      expect(() => parsePlatformArgs([command, '--dashboard-url'])).toThrow('requires a value');
    }
    for (const command of ['enable', 'disable', 'rollback', 'uninstall']) {
      expect(() =>
        parsePlatformArgs([command, '--dashboard-url', 'https://dash.example.com']),
      ).toThrow();
    }
  });
  it('accepts --runtime-logs only in install and upgrade', () => {
    for (const command of ['install', 'upgrade']) {
      expect(parsePlatformArgs([command, '--runtime-logs', 'minimal'])).toMatchObject({
        runtimeLogs: 'minimal',
      });
      expect(parsePlatformArgs([command, '--runtime-logs', 'full'])).toMatchObject({
        runtimeLogs: 'full',
      });
      expect(parsePlatformArgs([command])).not.toHaveProperty('runtimeLogs');
      expect(() => parsePlatformArgs([command, '--runtime-logs', 'none'])).toThrow(
        'platform: --runtime-logs must be full or minimal.',
      );
      expect(() => parsePlatformArgs([command, '--runtime-logs'])).toThrow('requires a value');
    }
    for (const command of ['repair', 'rollback', 'enable', 'disable', 'uninstall']) {
      expect(() =>
        parsePlatformArgs([command, '--runtime', 'dir', '--runtime-logs', 'minimal']),
      ).toThrow();
    }
  });
  it('turns on custom domains only in install, upgrade, and repair', () => {
    for (const command of ['install', 'upgrade', 'repair']) {
      expect(parsePlatformArgs([command, '--custom-domains'])).toMatchObject({
        customDomains: true,
      });
      expect(parsePlatformArgs([command])).not.toHaveProperty('customDomains');
    }
    for (const command of ['enable', 'disable', 'rollback', 'uninstall']) {
      expect(() => parsePlatformArgs([command, '--custom-domains'])).toThrow();
    }
    for (const flag of ['--workers-dev', '--no-dedicated-zone']) {
      expect(() => parsePlatformArgs(['install', '--custom-domains', flag])).toThrow(
        'dedicated application zone',
      );
    }
  });
  it('accepts replacement login settings only in repair', () => {
    expect(parsePlatformArgs(['repair', 'team', '--auth-config', 'auth.json'])).toEqual({
      subcommand: 'repair',
      selector: 'team',
      plan: false,
      runtime: '',
      yes: false,
      authConfig: 'auth.json',
    });
    expect(parsePlatformArgs(['repair'])).not.toHaveProperty('authConfig');
    expect(() => parsePlatformArgs(['repair', '--auth-config'])).toThrow('requires a value');
    for (const command of ['upgrade', 'enable', 'disable', 'uninstall']) {
      expect(() => parsePlatformArgs([command, '--auth-config', 'auth.json'])).toThrow(
        "Unknown flag '--auth-config'",
      );
    }
  });
  it('parses resumable domain setup without confusing app-domain commands', () => {
    expect(
      parsePlatformArgs(['domain', 'set', 'example.com', '--installation', 'team', '--plan']),
    ).toEqual({
      subcommand: 'domain',
      domain: 'example.com',
      selector: 'team',
      zone: '',
      dedicatedZone: false,
      plan: true,
      yes: false,
    });
    expect(() => parsePlatformArgs(['domain', 'set'])).toThrow('requires an application domain');
    expect(() => parsePlatformArgs(['domain', 'set', 'example.com', '--plan', '--yes'])).toThrow(
      'either',
    );
  });
  it('makes testing explicit and rejects competing domain choices', () => {
    expect(parsePlatformArgs(['install', '--workers-dev', '--plan'])).toMatchObject({
      workersDev: true,
      plan: true,
    });
    expect(parsePlatformArgs(['install'])).not.toHaveProperty('workersDev');
    for (const flags of [
      ['--zone', 'example.com'],
      ['--application-domain', 'example.com'],
      ['--dedicated-zone'],
    ]) {
      expect(() => parsePlatformArgs(['install', '--workers-dev', ...flags])).toThrow(
        'cannot be combined',
      );
    }
  });
  it('parses connection and lifecycle selectors', () => {
    expect(() => parsePlatformArgs(['connect', 'https://api.example.com'])).toThrow();
    expect(parsePlatformArgs(['repair', 'example-a1b2c3d4', '--plan'])).toEqual({
      subcommand: 'repair',
      selector: 'example-a1b2c3d4',
      plan: true,
      runtime: '',
      yes: false,
    });
    expect(parsePlatformArgs(['enable', 'example-a1b2c3d4'])).toEqual({
      subcommand: 'enable',
      selector: 'example-a1b2c3d4',
      plan: false,
      runtime: '',
      yes: false,
    });
    expect(parsePlatformArgs(['discover', '--account', 'account-id'])).toEqual({
      subcommand: 'discover',
      account: 'account-id',
      selector: '',
    });
    expect(
      parsePlatformArgs([
        'discover',
        '--installation',
        'staging-a1b2c3d4',
        '--account',
        'account-id',
      ]),
    ).toEqual({
      subcommand: 'discover',
      account: 'account-id',
      selector: 'staging-a1b2c3d4',
    });
  });

  it('parses custom runtimes for lifecycle commands that deploy Workers', () => {
    expect(
      parsePlatformArgs([
        'upgrade',
        'example-a1b2c3d4',
        '--runtime',
        'packages/platform/dist/runtime',
        '--yes',
      ]),
    ).toEqual({
      subcommand: 'upgrade',
      selector: 'example-a1b2c3d4',
      plan: false,
      runtime: 'packages/platform/dist/runtime',
      yes: true,
    });
    expect(
      parsePlatformArgs(['install', '--runtime', '/tmp/void-runtime', '--plan']),
    ).toMatchObject({ runtime: '/tmp/void-runtime' });
    expect(() => parsePlatformArgs(['disable', '--runtime', '/tmp/void-runtime'])).toThrow(
      "Unknown flag '--runtime'",
    );
    expect(
      parsePlatformArgs([
        'rollback',
        'example-a1b2c3d4',
        '--runtime',
        '/tmp/earlier-runtime',
        '--from-runtime',
        '/tmp/current-runtime',
        '--plan',
      ]),
    ).toEqual({
      fromRuntime: '/tmp/current-runtime',
      plan: true,
      runtime: '/tmp/earlier-runtime',
      selector: 'example-a1b2c3d4',
      subcommand: 'rollback',
      yes: false,
    });
    expect(() => parsePlatformArgs(['rollback', 'example-a1b2c3d4'])).toThrow(
      'rollback requires --runtime',
    );
  });

  it('parses safe uninstall choices explicitly', () => {
    expect(parsePlatformArgs(['uninstall', '--purge-data', '--keep-zone'])).toEqual({
      subcommand: 'uninstall',
      selector: '',
      plan: false,
      purgeData: true,
      purgeResources: false,
      yes: false,
    });
    expect(() => parsePlatformArgs(['uninstall', '--delete-zone'])).toThrow(
      "Unknown flag '--delete-zone'",
    );
  });

  it('treats --purge-resources as a purge of data and every other created resource', () => {
    expect(parsePlatformArgs(['uninstall', 'team', '--purge-resources', '--plan'])).toEqual({
      subcommand: 'uninstall',
      selector: 'team',
      plan: true,
      purgeData: true,
      purgeResources: true,
      yes: false,
    });
    expect(parsePlatformArgs(['uninstall', '--purge-data', '--purge-resources'])).toMatchObject({
      purgeData: true,
      purgeResources: true,
    });
  });

  it('fails closed for every unacknowledged non-interactive mutation', () => {
    for (const command of [
      'install',
      'upgrade',
      'rollback',
      'repair',
      'disable',
      'enable',
      'uninstall',
    ]) {
      const runtime = command === 'rollback' ? ['--runtime', '/tmp/earlier'] : [];
      const parsed = parsePlatformArgs([command, ...runtime]);
      expect(() => assertNoninteractivePlatformMutationAcknowledged(parsed, false)).toThrow(
        'requires --yes',
      );
      expect(() =>
        assertNoninteractivePlatformMutationAcknowledged(
          parsePlatformArgs([command, ...runtime, '--yes']),
          false,
        ),
      ).not.toThrow();
      expect(() =>
        assertNoninteractivePlatformMutationAcknowledged(
          parsePlatformArgs([command, ...runtime, '--plan']),
          false,
        ),
      ).not.toThrow();
    }
  });
});
