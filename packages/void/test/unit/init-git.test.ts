import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANCEL_SYMBOL, cancel, confirm, log } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { initialCommitCommand, setupGit } from '../../src/cli/init-git.ts';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

vi.mock('@voidzero-dev/vite-plus-prompts', async (importOriginal) => {
  const { CANCEL_SYMBOL, isCancel } =
    await importOriginal<typeof import('@voidzero-dev/vite-plus-prompts')>();
  return {
    CANCEL_SYMBOL,
    cancel: vi.fn(),
    confirm: vi.fn(),
    isCancel,
    log: { warn: vi.fn(), info: vi.fn() },
  };
});

let root: string;
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

beforeEach(() => {
  vi.mocked(confirm).mockReset();
  root = mkdtempSync(join(tmpdir(), 'void-init-git-'));
  vi.stubEnv('CI', '');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, get: () => true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  if (ttyDescriptor) {
    Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
  } else {
    Reflect.deleteProperty(process.stdin, 'isTTY');
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('init Git setup', () => {
  it('prompts with Yes selected and creates a real repository without staging or committing', async () => {
    vi.mocked(confirm).mockResolvedValueOnce(true);
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'init.defaultBranch');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'custom-default');
    writeFileSync(join(root, 'app.ts'), 'export {};\n');

    expect(await setupGit(root)).toBe(true);
    expect(confirm).toHaveBeenCalledWith({
      message: 'Initialize a git repository?',
      initialValue: true,
    });
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(existsSync(join(root, '.git'))).toBe(true);
    expect(
      spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).stdout.trim(),
    ).toBe('custom-default');
    expect(spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }).status).not.toBe(0);
    expect(spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).stdout).toBe('');
  });

  it.each(['decline', 'no-git', 'CI', 'non-TTY'])('skips initialization for %s', async (reason) => {
    vi.mocked(confirm).mockResolvedValueOnce(false);
    if (reason === 'CI') {
      vi.stubEnv('CI', 'true');
    }
    if (reason === 'non-TTY') {
      vi.spyOn(process.stdin, 'isTTY', 'get').mockReturnValue(false);
    }

    expect(await setupGit(root, reason === 'no-git' ? false : undefined)).toBe(false);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(existsSync(join(root, '.git'))).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(reason === 'decline' ? 1 : 0);
  });

  it('honors --git in CI without a prompt', async () => {
    vi.stubEnv('CI', 'true');
    vi.spyOn(process.stdin, 'isTTY', 'get').mockReturnValue(false);
    expect(await setupGit(root, true)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(existsSync(join(root, '.git'))).toBe(true);
  });

  it.each(['directory', 'file'])(
    'preserves an existing repository and its subfolders when .git is a %s',
    async (kind) => {
      if (kind === 'directory') {
        mkdirSync(join(root, '.git'));
      } else {
        writeFileSync(join(root, '.git'), 'gitdir: /worktree/metadata\n');
      }
      const child = join(root, 'apps', 'web');
      mkdirSync(child, { recursive: true });

      expect(await setupGit(root)).toBe(false);
      expect(await setupGit(child, true)).toBe(false);
      expect(confirm).not.toHaveBeenCalled();
      expect(spawnSync).not.toHaveBeenCalled();
      expect(existsSync(join(child, '.git'))).toBe(false);
    },
  );

  it('cancels before running Git', async () => {
    vi.mocked(confirm).mockResolvedValueOnce(CANCEL_SYMBOL);
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('cancelled');
    });
    await expect(setupGit(root)).rejects.toThrow('cancelled');
    expect(cancel).toHaveBeenCalledWith('Setup cancelled.');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it.each([
    { status: 1, stderr: 'permission denied\n', error: undefined },
    { status: null, stderr: null, error: new Error('spawn git ENOENT') },
  ])('warns without failing setup when Git fails: $status', async (failure) => {
    vi.mocked(spawnSync).mockReturnValueOnce(failure as ReturnType<typeof spawnSync>);
    expect(await setupGit(root, true)).toBe(false);
    expect(log.warn).toHaveBeenCalledWith('Failed to initialize git repository');
    expect(log.info).toHaveBeenCalledWith(failure.stderr?.trim() ?? failure.error?.message);
  });
});

describe('initial commit hint', () => {
  it('suggests the Vite+ commit command in the current directory', () => {
    expect(initialCommitCommand(process.cwd())).toBe(
      'git add -A && git commit -m "chore: initial commit"',
    );
  });

  it('targets a created subfolder by its path from the shell', () => {
    // The user's shell stays in the parent directory.
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    expect(initialCommitCommand(join(root, 'my-app'))).toBe(
      'git -C my-app add -A && git -C my-app commit -m "chore: initial commit"',
    );
  });

  it('quotes shell metacharacters in the subfolder name', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const name = "app's $name `value`";
    const argument =
      process.platform === 'win32' ? `"${name}"` : `'${name.replaceAll("'", "'\\''")}'`;
    const git = `git -C ${argument}`;
    expect(initialCommitCommand(join(root, name))).toBe(
      `${git} add -A && ${git} commit -m "chore: initial commit"`,
    );
  });

  it('keeps git from reading the subfolder name as an option', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    expect(initialCommitCommand(join(root, '-app'))).toBe(
      'git -C ./-app add -A && git -C ./-app commit -m "chore: initial commit"',
    );
  });
});
