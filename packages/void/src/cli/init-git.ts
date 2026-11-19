import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cancel, confirm, isCancel, log } from '@voidzero-dev/vite-plus-prompts';
import { dirname, join, resolve } from 'pathslash';
import { projectPathFromShell } from './init-shell.ts';

export async function setupGit(root: string, git?: boolean): Promise<boolean> {
  if (git === false) {
    return false;
  }

  // Init also configures existing apps. Preserve their repository, including
  // parent repositories and the .git files used by worktrees and submodules.
  let directory = resolve(root);
  while (true) {
    if (existsSync(join(directory, '.git'))) {
      return false;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  if (git === undefined) {
    // Match vp create: prompt with Yes selected in a terminal, but require an
    // explicit --git in CI or when stdin is not a terminal.
    if (process.env.CI || !process.stdin.isTTY) {
      return false;
    }
    const selected = await confirm({
      message: 'Initialize a git repository?',
      initialValue: true,
    });
    if (isCancel(selected)) {
      cancel('Setup cancelled.');
      process.exit(0);
    }
    if (!selected) {
      return false;
    }
  }

  const result = spawnSync('git', ['init'], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    log.warn('Failed to initialize git repository');
    const detail = result.stderr?.trim() || result.error?.message;
    if (detail) {
      log.info(detail);
    }
    return false;
  }
  return true;
}

export function initialCommitCommand(root: string): string {
  // Init can create a subfolder. Like `vp create`, name it relative to the
  // user's shell: the command repeats the path, and an absolute one wraps.
  const path = projectPathFromShell(root);
  const git = path === undefined ? 'git' : `git -C ${path}`;
  return `${git} add -A && ${git} commit -m "chore: initial commit"`;
}
