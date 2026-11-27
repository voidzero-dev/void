import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { detectPM, pmDlx, pmInitCommand, runVoidInit } from '../../src/pm.ts';

describe('create-void package manager delegation', () => {
  beforeEach(() => vi.stubEnv('VP_USER_AGENT', ''));
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

  it('selects Vite+ when invoked by the Vite+ CLI', () => {
    vi.stubEnv('VP_USER_AGENT', 'vp/1.7.0');
    expect(pmInitCommand('pnpm', '1.2.3', [])).toEqual([
      'pnpm',
      'dlx',
      'void@1.2.3',
      'init',
      '--toolchain',
      'vite-plus',
      '--no-install',
    ]);
  });

  it('preserves an explicitly selected toolchain when invoked by the Vite+ CLI', () => {
    vi.stubEnv('VP_USER_AGENT', 'vp/1.7.0');
    expect(pmInitCommand('pnpm', '1.2.3', ['--toolchain', 'vite'])).toEqual([
      'pnpm',
      'dlx',
      'void@1.2.3',
      'init',
      '--toolchain',
      'vite',
      '--no-install',
    ]);
  });

  it('preserves an explicit install request when invoked by the Vite+ CLI', () => {
    vi.stubEnv('VP_USER_AGENT', 'vp/1.7.0');
    expect(pmInitCommand('pnpm', '1.2.3', ['--install'])).toEqual([
      'pnpm',
      'dlx',
      'void@1.2.3',
      'init',
      '--install',
      '--toolchain',
      'vite-plus',
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

  it('passes the package manager and Vite+ origin through environment variables', async () => {
    vi.stubEnv('VP_USER_AGENT', 'vp/1.7.0');
    await runVoidInit('pnpm', '1.2.3', [], '/tmp/void-app', async (argv, cwd, env) => {
      expect(argv).not.toContain('--package-manager');
      expect(argv).not.toContain('--vp-create');
      expect(cwd).toBe('/tmp/void-app');
      expect(env).toMatchObject({ VOID_PACKAGE_MANAGER: 'pnpm', VOID_VP_CREATE: '1' });
    });
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
