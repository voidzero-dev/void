import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { parse } from 'yaml';
import { getPnpmWorkspaceRoot, pmInitCommand, writePnpmBuildPolicy } from '../../src/pm.ts';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn() };
});

const temporaryDirectories: Array<string> = [];

afterEach(() => {
  vi.mocked(spawnSync).mockReset();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('create-void package manager bootstrap', () => {
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
        '--framework',
        'react',
        '--no-install',
      ],
    ],
    ['pnpm', ['pnpm', 'dlx', 'void@1.2.3', 'init', '--framework', 'react', '--no-install']],
    ['bun', ['bunx', 'void@1.2.3', 'init', '--framework', 'react', '--no-install']],
  ] as const)('runs void init with %s dlx when installation is skipped', (manager, expected) => {
    expect(pmInitCommand(manager, '1.2.3', true, ['--framework', 'react'])).toEqual(expected);
  });

  it.each([
    [
      'yarn/1.22.22 npm/? node/v24.22.1',
      [
        'npm',
        'exec',
        '--yes',
        '--package=void@1.2.3',
        '--',
        'void',
        'init',
        '--framework',
        'react',
        '--no-install',
      ],
    ],
    [
      'yarn/4.5.0 npm/? node/v24.22.1',
      ['yarn', 'dlx', 'void@1.2.3', 'init', '--framework', 'react', '--no-install'],
    ],
  ] as const)('uses the matching temporary runner for %s', (userAgent, expected) => {
    vi.stubEnv('npm_config_user_agent', userAgent);
    try {
      expect(pmInitCommand('yarn', '1.2.3', true, ['--framework', 'react'])).toEqual(expected);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ['npm', ['npx', 'void', 'init', '--framework', 'react']],
    ['pnpm', ['pnpm', 'exec', 'void', 'init', '--framework', 'react']],
    ['yarn', ['yarn', 'exec', 'void', 'init', '--framework', 'react']],
    ['bun', ['bunx', 'void', 'init', '--framework', 'react']],
  ] as const)(
    'uses the installed void CLI with %s when installing dependencies',
    (manager, expected) => {
      expect(pmInitCommand(manager, '1.2.3', false, ['--framework', 'react'])).toEqual(expected);
    },
  );

  it('writes the narrow Void build policy for a standalone pnpm project', () => {
    const root = mkdtempSync(join(tmpdir(), 'create-void-pnpm-'));
    temporaryDirectories.push(root);
    vi.mocked(spawnSync).mockReturnValue({
      pid: 1,
      output: [],
      stdout: '',
      stderr: 'No workspace found',
      status: 1,
      signal: null,
    });

    writePnpmBuildPolicy(root, 'pnpm');

    expect(parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf-8'))).toEqual({
      allowBuilds: {
        'better-sqlite3': false,
        esbuild: true,
        sharp: true,
        workerd: true,
      },
    });
  });

  it('merges build entries into the detected workspace root and preserves existing settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'create-void-workspace-'));
    const target = join(root, 'apps', 'site');
    temporaryDirectories.push(root);
    const workspaceFile = join(root, 'pnpm-workspace.yaml');
    const original = [
      '# Keep this workspace comment',
      'packages:',
      '  - apps/*',
      'catalog:',
      '  typescript: ^7.0.0',
      'allowBuilds:',
      '  esbuild: false # Preserve this decision',
      '  custom-build: true',
      '',
    ].join('\n');
    const firstRootOutput = `${root}\n`;
    vi.mocked(spawnSync).mockReturnValue({
      pid: 1,
      output: [],
      stdout: firstRootOutput,
      stderr: '',
      status: 0,
      signal: null,
    });
    mkdirSync(target, { recursive: true });
    writeFileSync(workspaceFile, original);

    const workspaceRoot = getPnpmWorkspaceRoot(target);
    expect(workspaceRoot).toBe(root);
    writePnpmBuildPolicy(workspaceRoot!, 'pnpm');

    const written = readFileSync(workspaceFile, 'utf-8');
    const parsed = parse(written) as Record<string, unknown>;
    expect(parsed.packages).toEqual(['apps/*']);
    expect(parsed.catalog).toEqual({ typescript: '^7.0.0' });
    expect(parsed.allowBuilds).toEqual({
      esbuild: false,
      'custom-build': true,
      'better-sqlite3': false,
      sharp: true,
      workerd: true,
    });
    expect(written).toContain('# Keep this workspace comment');
    expect(written).toContain('# Preserve this decision');
    expect(existsSync(join(target, 'pnpm-workspace.yaml'))).toBe(false);

    vi.mocked(spawnSync).mockReturnValue({
      pid: 1,
      output: [],
      stdout: firstRootOutput,
      stderr: '',
      status: 0,
      signal: null,
    });
    writePnpmBuildPolicy(workspaceRoot!, 'pnpm');
    expect(readFileSync(workspaceFile, 'utf-8')).toBe(written);
  });

  it('does not overwrite a malformed pnpm workspace file', () => {
    const root = mkdtempSync(join(tmpdir(), 'create-void-malformed-'));
    temporaryDirectories.push(root);
    const workspaceFile = join(root, 'pnpm-workspace.yaml');
    const original = 'allowBuilds: [\n';
    writeFileSync(workspaceFile, original);
    vi.mocked(spawnSync).mockReturnValue({
      pid: 1,
      output: [],
      stdout: '',
      stderr: 'No workspace found',
      status: 1,
      signal: null,
    });

    expect(() => writePnpmBuildPolicy(root, 'pnpm')).toThrow('Could not parse pnpm-workspace.yaml');
    expect(readFileSync(workspaceFile, 'utf-8')).toBe(original);
  });

  it('adds entries to an inline allowBuilds mapping', () => {
    const root = mkdtempSync(join(tmpdir(), 'create-void-inline-'));
    temporaryDirectories.push(root);
    const workspaceFile = join(root, 'pnpm-workspace.yaml');
    writeFileSync(workspaceFile, "packages: ['apps/*']\nallowBuilds: { custom-build: true }\n");
    vi.mocked(spawnSync).mockReturnValue({
      pid: 1,
      output: [],
      stdout: '',
      stderr: 'No workspace found',
      status: 1,
      signal: null,
    });

    writePnpmBuildPolicy(root, 'pnpm');

    const parsed = parse(readFileSync(workspaceFile, 'utf-8')) as Record<string, unknown>;
    expect(parsed.allowBuilds).toEqual({
      'custom-build': true,
      'better-sqlite3': false,
      esbuild: true,
      sharp: true,
      workerd: true,
    });
  });

  it('does not add pnpm policy files for other package managers', () => {
    for (const manager of ['npm', 'yarn', 'bun'] as const) {
      const root = mkdtempSync(join(tmpdir(), `create-void-${manager}-`));
      temporaryDirectories.push(root);

      writePnpmBuildPolicy(root, manager);

      expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(false);
    }
  });
});
