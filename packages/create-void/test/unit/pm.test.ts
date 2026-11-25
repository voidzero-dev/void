import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { detectPM, pmDlx, pmInitCommand } from '../../src/pm.ts';

describe('create-void package manager delegation', () => {
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
    [
      'npm',
      [
        'npm',
        'exec',
        '--yes',
        '--package=void@1.2.3',
        '--',
        'void',
        'init',
        '--package-manager',
        'npm',
      ],
    ],
    ['pnpm', ['pnpm', 'dlx', 'void@1.2.3', 'init', '--package-manager', 'pnpm']],
    ['yarn', ['yarn', 'dlx', 'void@1.2.3', 'init', '--package-manager', 'yarn']],
    ['bun', ['bunx', 'void@1.2.3', 'init', '--package-manager', 'bun']],
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
      '--package-manager',
      'yarn',
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
      '--package-manager',
      'pnpm',
      '--framework',
      'react',
      '--no-install',
    ]);
    expect(command).not.toContain('install');
  });

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
