import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { createSpinner } from './output.ts';

export type QuietRun = {
  /** The exit code, or null when a signal ended the command. */
  status: number | null;
  /** What the command wrote to stdout and stderr, in the order it arrived. */
  output: string;
  /** Why the command did not start. */
  error?: Error;
};

/**
 * The signals that end init: Ctrl+C where no spinner reads the keyboard, and
 * `kill`. SIGHUP is left alone, since listening for it would undo `nohup`.
 */
const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/** How long a command that init stops has to end by itself before init kills it. */
const STOP_GRACE_MS = 5_000;
/** How long init waits for the killed processes to go. */
const KILL_WAIT_MS = 1_000;
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

/**
 * Run a command behind a spinner, with its output kept for the caller instead
 * of printed. `spawnSync` would block the event loop and freeze the spinner.
 * The spinner goes away when the command ends.
 */
export function runBehindSpinner(
  message: string,
  command: string,
  args: Array<string>,
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    shell?: boolean;
    /** The line to leave in place of the spinner when the command fails. */
    failed?: string;
    /**
     * Removes what the command wrote. Runs when the command fails, and when
     * init exits before the command ends, after the command has stopped.
     */
    undo?: () => void;
  },
): Promise<QuietRun> {
  const { failed, undo, ...spawnOptions } = options;
  return new Promise((resolve) => {
    let child: ChildProcess | undefined;
    const progress = createSpinner({ indicator: 'timer', cancelMessage: message });
    // A spinner reads Ctrl+C as a key press and exits the process, so the
    // terminal interrupts nothing. Go before the exit listener that reports
    // init's work: mark this step as stopped, then stop the command.
    const onExit = (code: number): void => {
      progress.cancel(message);
      stopCommand(child);
      undo?.();
      // The prompt library exits with 0 there. Keep the exit code of an
      // interrupt, so that a caller such as create-void does not carry on.
      if (code === 0) {
        process.exitCode = 130;
      }
    };
    // The command is not one of the terminal's foreground processes, so a
    // signal that ends init would leave it running. Exit instead, which runs
    // the listener above.
    const onSignal = (signal: NodeJS.Signals): void => {
      process.exit(128 + constants.signals[signal]);
    };
    const chunks: Array<Buffer> = [];
    let settled = false;
    const settle = (status: number | null, error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      process.removeListener('exit', onExit);
      for (const signal of STOP_SIGNALS) {
        process.removeListener(signal, onSignal);
      }
      const succeeded = !error && status === 0;
      if (!succeeded) {
        undo?.();
      }
      if (failed && !succeeded) {
        progress.error(failed);
      } else {
        progress.clear();
      }
      resolve({ status, output: Buffer.concat(chunks).toString('utf8'), error });
    };

    progress.start(message);
    process.prependListener('exit', onExit);
    for (const signal of STOP_SIGNALS) {
      process.on(signal, onSignal);
    }
    try {
      const started = spawn(command, args, {
        ...spawnOptions,
        // Without stdin or a terminal, a command that asks a question fails
        // instead of waiting for an answer behind the spinner.
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so that init can stop what the command starts.
        detached: process.platform !== 'win32',
      });
      child = started;
      started.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      started.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
      started.once('error', (error) => settle(null, error));
      started.once('close', (status) => settle(status));
    } catch (error) {
      settle(null, error instanceof Error ? error : new Error(String(error)));
    }
  });
}
