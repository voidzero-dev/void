import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { parseInitArgs, runInitCommand } from '../../../void/src/cli/init.ts';
import { detectPM, runVoidInit } from '../../src/pm.ts';

const VOID_VERSION = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
) as { version: string };

describe('create-void delegation', () => {
  beforeEach(() => {
    vi.stubEnv('VP_USER_AGENT', '');
    vi.stubEnv('VP_PACKAGE_MANAGER', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('writes the npm package manager for an npm create void Vite+ starter', async () => {
    vi.stubEnv('VP_USER_AGENT', '');
    vi.stubEnv('npm_config_user_agent', 'npm/11.0.0 node/v24.22.1');
    const root = mkdtempSync(join(tmpdir(), 'create-void-npm-'));
    try {
      expect(detectPM()).toBe('npm');

      await runVoidInit(
        detectPM(),
        VOID_VERSION.version,
        [
          '--toolchain',
          'vite-plus',
          '--framework',
          'react',
          '--starter',
          'static',
          '--deploy',
          'none',
          '--no-install',
        ],
        root,
        async (argv, cwd, env) => {
          expect(argv).not.toContain('--package-manager');
          expect(env).toMatchObject({ VOID_PACKAGE_MANAGER: 'npm', VOID_VP_CREATE: '' });
          vi.stubEnv('VOID_PACKAGE_MANAGER', env.VOID_PACKAGE_MANAGER);
          vi.stubEnv('VOID_VP_CREATE', env.VOID_VP_CREATE);
          await runInitCommand(cwd!, parseInitArgs(argv.slice(argv.indexOf('init') + 1)));
        },
      );

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.devEngines.packageManager).toEqual({ name: 'npm' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('delegates to void init in a pnpm workspace member and forwards --no-install', async () => {
    const root = mkdtempSync(join(tmpdir(), 'create-void-workspace-'));
    try {
      const appDirectory = join(root, 'apps', 'my-app');
      mkdirSync(appDirectory, { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true }));
      writeFileSync(
        join(root, 'pnpm-workspace.yaml'),
        [
          '# Keep this workspace comment',
          'packages:',
          '  - apps/*',
          'allowBuilds:',
          '  esbuild: false # Keep this approval decision',
          '  custom-build: true',
          '',
        ].join('\n'),
      );

      let invoked = false;
      await runVoidInit(
        'pnpm',
        VOID_VERSION.version,
        [
          '--toolchain',
          'vite',
          '--framework',
          'react',
          '--starter',
          'static',
          '--deploy',
          'none',
          '--no-install',
        ],
        appDirectory,
        async (argv, cwd, env) => {
          invoked = true;
          expect(env).toMatchObject({ VOID_PACKAGE_MANAGER: 'pnpm', VOID_VP_CREATE: '' });
          vi.stubEnv('VOID_PACKAGE_MANAGER', env.VOID_PACKAGE_MANAGER);
          vi.stubEnv('VOID_VP_CREATE', env.VOID_VP_CREATE);
          expect(argv).toEqual([
            'pnpm',
            'dlx',
            `void@${VOID_VERSION.version}`,
            'init',
            '--toolchain',
            'vite',
            '--framework',
            'react',
            '--starter',
            'static',
            '--deploy',
            'none',
            '--no-install',
          ]);
          expect(cwd).toBe(appDirectory);
          await runInitCommand(cwd!, parseInitArgs(argv.slice(4)));
        },
      );
      expect(invoked).toBe(true);

      expect(existsSync(join(appDirectory, 'package.json'))).toBe(true);
      expect(existsSync(join(appDirectory, 'pages', 'index.tsx'))).toBe(true);
      expect(existsSync(join(appDirectory, 'pnpm-workspace.yaml'))).toBe(false);
      expect(existsSync(join(appDirectory, 'pnpm-lock.yaml'))).toBe(false);
      expect(existsSync(join(appDirectory, 'package-lock.json'))).toBe(false);
      expect(existsSync(join(appDirectory, 'node_modules'))).toBe(false);

      const updatedWorkspaceConfig = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
      expect(updatedWorkspaceConfig).toContain('# Keep this workspace comment');
      expect(updatedWorkspaceConfig).toContain('esbuild: false # Keep this approval decision');
      expect(updatedWorkspaceConfig).toContain('custom-build: true');
      expect(updatedWorkspaceConfig).toContain('better-sqlite3: false');
      expect(updatedWorkspaceConfig).toContain('sharp: true');
      expect(updatedWorkspaceConfig).toContain('workerd: true');
      expect(existsSync(join(root, 'pnpm-lock.yaml'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
