import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toSlash } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { listInstallationManifests } from '../../src/cli/platform-registry.ts';
import {
  listSavedPlatformInstallPlans,
  removeSavedPlatformInstallPlan,
  savePlatformInstallChoices,
} from '../../src/cli/platform-saved-plans.ts';
import {
  platformInstallCommandArguments,
  type PlatformInstallCommandOptions,
} from '../../src/cli/platform-setup.ts';

let directory: string;
const options: PlatformInstallCommandOptions = {
  commandName: 'void-dev',
  accountId: 'account',
  installationSlug: 'team',
  displayName: "Team's Platform",
  applicationDomain: 'apps.example.com',
  zoneName: 'example.com',
  controlPlaneDomain: 'api.example.com',
  dedicatedZone: false,
  workersDev: false,
  authentication: { providers: ['cloudflare-access'], configurable: true, accessProtection: true },
  hyperdrive: 'managed-drive-id',
  runtime: '/build output',
  yes: false,
};
const argumentsFor = (changes: Partial<PlatformInstallCommandOptions> = {}) =>
  platformInstallCommandArguments({ ...options, ...changes }).slice(2);

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'void-saved-plans-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('saved platform install choices', () => {
  it('preserves names and paths without shell parsing or creating an installation', () => {
    savePlatformInstallChoices(
      argumentsFor({ authConfig: '/auth config.json' }),
      'Team Account',
      directory,
    );
    expect(listSavedPlatformInstallPlans(directory)).toEqual([
      expect.objectContaining({
        accountName: 'Team Account',
        args: expect.objectContaining({
          name: 'team',
          displayName: "Team's Platform",
          account: 'account',
          applicationDomain: 'apps.example.com',
          controlPlaneDomain: 'api.example.com',
          hyperdrive: 'managed-drive-id',
          runtime: '/build output',
          authConfig: '/auth config.json',
          dedicatedZone: false,
          dedicatedZoneSpecified: true,
          yes: false,
          resume: false,
          plan: false,
        }),
      }),
    ]);
    expect(listInstallationManifests(directory)).toEqual([]);
    if (process.platform !== 'win32') {
      expect(statSync(join(directory, readdirSync(directory)[0]!)).mode & 0o777).toBe(0o600);
    }
  });

  it('replays minimal runtime logs in a saved plan', () => {
    savePlatformInstallChoices(argumentsFor({ runtimeLogs: 'minimal' }), 'Account', directory);
    expect(listSavedPlatformInstallPlans(directory)[0]!.args).toMatchObject({
      runtimeLogs: 'minimal',
    });
    expect(argumentsFor()).not.toContain('--runtime-logs');
  });

  it('updates the same account and slug while retaining plans for other accounts', () => {
    const first = savePlatformInstallChoices(argumentsFor(), 'Account', directory);
    const other = savePlatformInstallChoices(
      argumentsFor({ accountId: 'other-account' }),
      'Other',
      directory,
    );
    const updated = savePlatformInstallChoices(
      argumentsFor({ displayName: 'Updated' }),
      'Account',
      directory,
    );
    expect(updated.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    expect(listSavedPlatformInstallPlans(directory)).toHaveLength(2);
    expect(
      listSavedPlatformInstallPlans(directory).find((plan) => plan.id === first.id)?.args
        .displayName,
    ).toBe('Updated');
    removeSavedPlatformInstallPlan(updated.args, directory);
    expect(listSavedPlatformInstallPlans(directory).map((plan) => plan.id)).toEqual([other.id]);
  });

  it('stores login and protection selections without approval to apply them', () => {
    savePlatformInstallChoices(argumentsFor(), 'Account', directory);
    expect(listSavedPlatformInstallPlans(directory)[0]?.args).toMatchObject({
      loginMethods: ['cloudflare-access'],
      accessProtection: true,
    });
    for (const flag of ['--yes', '--plan', '--resume']) {
      expect(() =>
        savePlatformInstallChoices([...argumentsFor(), flag], 'Account', directory),
      ).toThrow('without mutation approval');
    }
  });

  it('reports a corrupt or mismatched plan with its local path', () => {
    savePlatformInstallChoices(argumentsFor(), 'Account', directory);
    const path = join(directory, readdirSync(directory)[0]!);
    const value = JSON.parse(readFileSync(path, 'utf8'));
    value.arguments[value.arguments.indexOf('account')] = 'another-account';
    writeFileSync(path, JSON.stringify(value));
    expect(() => listSavedPlatformInstallPlans(directory)).toThrow(
      `Invalid saved installation plan ${toSlash(path)}: Plan identity`,
    );
    writeFileSync(path, '{');
    expect(() => listSavedPlatformInstallPlans(directory)).toThrow(
      `Invalid saved installation plan ${toSlash(path)}`,
    );
  });
});
