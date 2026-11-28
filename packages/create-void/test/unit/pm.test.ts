import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { detectPM, pmDlx, pmInitCommand, runVoidInit } from '../../src/pm.ts';

describe('create-void package manager delegation', () => {
  beforeEach(() => {
    vi.stubEnv('VP_USER_AGENT', '');
    vi.stubEnv('VP_PACKAGE_MANAGER', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ['npm', ['npm', 'exec', '--yes', '--package=void@1.2.3', '--', 'void']],
    ['pnpm', ['pnpm', 'dlx', 'void@1.2.3']],
    ['yarn', ['yarn', 'dlx', 'void@1.2.3']],
    ['bun', ['bunx', 'void@1.2.3']],
  ] as const)('uses %s to execute the requested Void version', (pm, expected) => {
    vi.stubEnv('npm_config_user_agent', '');
    expect(pmDlx(pm, '1.2.3')).toEqual(expected);
  });

  it('uses npm exec for Yarn Classic, which does not provide dlx', () => {
    vi.stubEnv('npm_config_user_agent', 'yarn/1.22.22 npm/? node/v24.22.1');
    expect(pmDlx('yarn', '1.2.3')).toEqual([
      'npm',
      'exec',
      '--yes',
      '--package=void@1.2.3',
      '--',
      'void',
    ]);
  });

  it.each([
    ['npm', ['npm', 'exec', '--yes', '--package=void@1.2.3', '--', 'void', 'init']],
    ['pnpm', ['pnpm', 'dlx', 'void@1.2.3', 'init']],
    ['yarn', ['yarn', 'dlx', 'void@1.2.3', 'init']],
    ['bun', ['bunx', 'void@1.2.3', 'init']],
  ] as const)('builds the %s void init command', (pm, expected) => {
    vi.stubEnv('npm_config_user_agent', '');
    expect(pmInitCommand(pm, '1.2.3', [])).toEqual(expected);
  });

  it('uses npm exec for void init under Yarn Classic', () => {
    vi.stubEnv('npm_config_user_agent', 'yarn/1.22.22 npm/? node/v24.22.1');
    expect(pmInitCommand('yarn', '1.2.3', ['--no-install'])).toEqual([
      'npm',
      'exec',
      '--yes',
      '--package=void@1.2.3',
      '--',
      'void',
      'init',
      '--no-install',
    ]);
  });

  it('forwards init options, including --no-install, without adding a package install', () => {
    const command = pmInitCommand('pnpm', '1.2.3', ['--framework', 'react', '--no-install']);

    expect(command).toEqual([
      'pnpm',
      'dlx',
      'void@1.2.3',
      'init',
      '--framework',
      'react',
      '--no-install',
    ]);
    expect(command).not.toContain('install');
  });

  it.each([undefined, '', 'npm@11.19.1'])(
    'only delegates the package manager when VP_PACKAGE_MANAGER is %s',
    async (packageManager) => {
      vi.stubEnv('VP_USER_AGENT', 'vp/1.8.0');
      vi.stubEnv('VP_PACKAGE_MANAGER', packageManager);

      await runVoidInit('pnpm', '1.2.3', [], '/tmp/void-app', async (argv, cwd, env) => {
        expect(argv).toEqual(['pnpm', 'dlx', 'void@1.2.3', 'init']);
        expect(cwd).toBe('/tmp/void-app');
        expect(env).toEqual({ VOID_PACKAGE_MANAGER: 'pnpm' });
      });
    },
  );

  it.each([
    ['pnpm/10.0.0 npm/? node/v24.22.1', 'pnpm'],
    ['npm/11.0.0 node/v24.22.1', 'npm'],
    ['yarn/4.5.0 npm/? node/v24.22.1', 'yarn'],
    ['bun/1.2.0', 'bun'],
  ] as const)('detects %s from npm_config_user_agent', (userAgent, expected) => {
    vi.stubEnv('npm_config_user_agent', userAgent);
    expect(detectPM()).toBe(expected);
  });
});
