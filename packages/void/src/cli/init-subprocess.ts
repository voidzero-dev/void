import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  closeSync,
  createReadStream,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'pathslash';
import { createSpinner } from './output.ts';

type SubprocessResult = {
  /** The exit code, or null when a signal ended the command. */
  status: number | null;
  /** How long the command ran, in milliseconds. */
  durationMs: number;
};

// On POSIX, a terminal hangup does not reach the detached command group.
const STOP_SIGNALS: Array<NodeJS.Signals> =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** How long a command that init stops has to end by itself before init kills it. */
const STOP_GRACE_MS = 5000;
/** How long init waits for the killed processes to go. */
const KILL_WAIT_MS = 1000;
/** How often init checks whether a stopped command has ended. */
const STOP_POLL_MS = 25;

/** Wait without the event loop, which an `exit` listener cannot return to. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Read the process states from /proc, which works without `ps` (slim container images have none). */
function isRunningInProc(pgid: number): boolean | undefined {
  let entries: Array<string>;
  try {
    entries = readdirSync('/proc');
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    let stat: string;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'latin1');
    } catch {
      // The process has ended since the listing.
      continue;
    }
    // "pid (name) state ppid pgrp …". The name can contain spaces and parentheses.
    const [state, , group] = stat.slice(stat.lastIndexOf(')') + 2).split(' ', 3);
    if (Number(group) === pgid && state !== 'Z' && state !== 'X') {
      return true;
    }
  }
  return false;
}

function isRunningInPs(pgid: number): boolean | undefined {
  // By its path, so that init finds it whatever the user's PATH is. One `-o`
  // for each column: POSIX reads the rest of an argument after "=" as the
  // column's header, so "pgid=,state=" would print the group alone.
  const listed = spawnSync('/bin/ps', ['-A', '-o', 'pgid=', '-o', 'state='], { encoding: 'utf8' });
  if (listed.status !== 0) {
    return undefined;
  }
  return listed.stdout.split('\n').some((row) => {
    const [group, state] = row.trim().split(/\s+/);
    return Number(group) === pgid && state !== undefined && !state.startsWith('Z');
  });
}

/**
 * Whether a process group still has a running member.
 *
 * A process that has exited stays in its group until its parent collects it,
 * and Node cannot collect init's own child while an `exit` listener runs. For
 * such a group `kill(-pgid, 0)` keeps succeeding, so read the process states.
 */
export function isProcessGroupRunning(
  pgid: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const running = platform === 'linux' ? isRunningInProc(pgid) : isRunningInPs(pgid);
  if (running !== undefined) {
    return running;
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    // The group has already ended.
    return false;
  }
}

function waitForGroupToEnd(pgid: number, timeoutMs: number): boolean {
  const deadline = performance.now() + timeoutMs;
  while (isProcessGroupRunning(pgid)) {
    if (performance.now() >= deadline) {
      return false;
    }
    sleepSync(STOP_POLL_MS);
  }
  return true;
}

/**
 * Stop a command that init started, together with the processes it started,
 * and return when they have ended. Init exits next: a process that still ran
 * then would go on changing the project while the user retries.
 */
export function stopCommand(
  child: ChildProcess | undefined,
  graceMs: number = STOP_GRACE_MS,
): void {
  const pid = child?.pid;
  if (!pid) {
    return;
  }
  if (process.platform === 'win32') {
    // `child.kill()` would end only the shell that runs the command.
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  // The command leads its own process group.
  if (!signalGroup(pid, 'SIGTERM') || waitForGroupToEnd(pid, graceMs)) {
    return;
  }
  // A process can ignore SIGTERM, but not SIGKILL.
  signalGroup(pid, 'SIGKILL');
  waitForGroupToEnd(pid, KILL_WAIT_MS);
}

async function replayOutput(path: string): Promise<void> {
  const { size } = statSync(path);
  if (size === 0) {
    return;
  }
  // Stop at the size on exit even if a background child is still writing.
  const output = createReadStream(path, { encoding: 'utf8', end: size - 1 });
  let endsWithNewline = true;
  for await (const chunk of output) {
    endsWithNewline = chunk.endsWith('\n');
    if (!process.stdout.write(chunk)) {
      await once(process.stdout, 'drain');
    }
  }
  if (!endsWithNewline) {
    process.stdout.write('\n');
  }
}

/** Run a command behind a spinner and print its output if it fails. */
export async function runBehindSpinner(
  message: string,
  command: string,
  args: Array<string>,
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    shell?: boolean;
    /** The line to leave in place of the spinner when the command fails. */
    failed?: string;
    /** Removes partial changes after a failure or interruption. */
    undo?: () => void;
  },
): Promise<SubprocessResult> {
  const { failed, undo, ...spawnOptions } = options;
  const directory = mkdtempSync(join(tmpdir(), 'void-init-'));
  const path = join(directory, 'output.log');
  const cleanup = (): void => rmSync(directory, { recursive: true, force: true });
  let child: ChildProcess | undefined;
  const progress = createSpinner({ indicator: 'timer', cancelMessage: message });
  // A spinner reads Ctrl+C as a key press and exits the process. Mark the step
  // as stopped and finish rollback before the exit listener that reports init's work.
  const onExit = (code: number): void => {
    if (child) {
      progress.cancel(message);
      stopCommand(child);
      undo?.();
      // The prompt library exits with 0. A caller such as create-void should
      // see a cancellation and stop, too.
      if (code === 0) {
        process.exitCode = 130;
      }
    }
    cleanup();
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    process.exit(128 + constants.signals[signal]);
  };

  try {
    progress.start(message);
    process.prependListener('exit', onExit);
    for (const signal of STOP_SIGNALS) {
      process.on(signal, onSignal);
    }

    const startedAt = performance.now();
    let status: number | null = null;
    try {
      status = await new Promise<number | null>((resolve, reject) => {
        // Both writers share the same file offset. Inheriting a file instead
        // of a pipe lets init finish even if a background child keeps it open.
        const fd = openSync(path, 'wx');
        try {
          child = spawn(command, args, {
            ...spawnOptions,
            stdio: ['ignore', fd, fd],
            detached: process.platform !== 'win32',
          });
          child.once('error', reject);
          child.once('exit', resolve);
        } finally {
          closeSync(fd);
        }
      });
    } finally {
      if (status !== 0 && !progress.isCancelled && undo) {
        // A failed generator can still have children writing its outputs.
        stopCommand(child);
        undo();
      }
      child = undefined;
      if (status === 0 || !failed) {
        progress.clear();
      } else if (!progress.isCancelled) {
        progress.error(failed);
      }
    }
    const durationMs = performance.now() - startedAt;
    if (status !== 0 && !progress.isCancelled) {
      await replayOutput(path);
    }
    return { status, durationMs };
  } finally {
    process.removeListener('exit', onExit);
    for (const signal of STOP_SIGNALS) {
      process.removeListener(signal, onSignal);
    }
    cleanup();
  }
}
