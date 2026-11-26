import type { execSync, spawnSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';

/** stdout's own write, and what takes its place while stdout is kept for results. */
let reservation:
  | { write: (text: string) => void; redirect: typeof process.stdout.write }
  | undefined;
let childProcessesRedirected = false;

/**
 * Keep stdout for a command's results (`void db execute --json`), and return the function that
 * writes them. Anything else written to stdout from then on goes to stderr until the process
 * exits: a console.log in void.config.ts runs each time the command loads the config, and a timer
 * the config starts may still write after the results. The same holds for a child process that
 * would inherit stdout, such as one void.config.ts starts with `execFileSync(..., { stdio:
 * 'inherit' })`: its stdout is stderr. A second command in the same process keeps the first
 * one's place, unless stdout's write has changed since.
 */
export function reserveStdoutForResults(): (text: string) => void {
  const { stdout, stderr } = process;
  if (reservation?.redirect !== stdout.write) {
    const redirect = ((...args: Parameters<typeof stderr.write>) =>
      stderr.write(...args)) as typeof stdout.write;
    reservation = { write: stdout.write.bind(stdout), redirect };
    stdout.write = redirect;
  }
  redirectChildProcessStdout();
  const { write } = reservation;
  return (text) => write(text);
}

/** Whether stdout is kept for a command's results, so nothing else may write to it. */
export function isStdoutReservedForResults(): boolean {
  return reservation !== undefined && reservation.redirect === process.stdout.write;
}

/**
 * Give child processes stderr where they would inherit stdout, while stdout is reserved. The
 * builtin's exports are wrapped, and synced to its ESM bindings, so every way of starting a child
 * goes through here: `spawn`, `exec`, `execFile` and `fork` start through
 * `ChildProcess.prototype.spawn`, and the synchronous functions are wrapped one by one.
 */
function redirectChildProcessStdout(): void {
  if (childProcessesRedirected) {
    return;
  }
  childProcessesRedirected = true;
  // The builtin itself, whose exports the ESM bindings follow, rather than a module mock.
  const childProcess = createRequire(import.meta.url)('node:child_process') as ChildProcessModule;

  const { prototype } = childProcess.ChildProcess;
  const spawn = prototype.spawn;
  prototype.spawn = function (options) {
    return spawn.call(this, withStdoutOnStderr(options));
  };
  childProcess.spawnSync = withOptionsAt(childProcess.spawnSync, optionsAfterArgs);
  childProcess.execFileSync = withOptionsAt(childProcess.execFileSync, optionsAfterArgs);
  childProcess.execSync = withOptionsAt(childProcess.execSync, () => 1);
  syncBuiltinESMExports();
}

/** The parts of `node:child_process` that start a child process. */
type ChildProcessModule = {
  ChildProcess: { prototype: ChildProcessStart };
  spawnSync: StartSync;
  execFileSync: StartSync;
  execSync: StartSync;
};

/**
 * The internal method that starts every asynchronous child process. It returns the spawn error
 * code, or undefined once the process starts.
 */
type ChildProcessStart = {
  spawn: (this: ChildProcessStart, options?: SpawnOptions) => number | undefined;
};

type StartSync = (
  ...args: Array<unknown>
) => ReturnType<typeof spawnSync> | ReturnType<typeof execSync>;

type SpawnOptions = { stdio?: unknown };

/**
 * spawnSync(command, args?, options?) and execFileSync(file, args?, options?) take options
 * second when args are left out.
 */
function optionsAfterArgs(args: Array<unknown>): number {
  return args[1] === undefined || args[1] === null || Array.isArray(args[1]) ? 2 : 1;
}

/** `run`, with stderr in place of an inherited stdout in the options at `optionsIndex`. */
function withOptionsAt(run: StartSync, optionsIndex: (args: Array<unknown>) => number): StartSync {
  return (...args) => {
    const index = optionsIndex(args);
    const options = args[index];
    if (typeof options === 'object' && options !== null && !Array.isArray(options)) {
      args[index] = withStdoutOnStderr(options);
    }
    return run(...args);
  };
}

/**
 * The options with stderr in place of stdout for each of the child's streams that would write to
 * it, while stdout is reserved: an inherited stdout, and any stream given stdout's fd or
 * `process.stdout`, such as a stderr sent to `process.stdout` while stdout is captured.
 */
function withStdoutOnStderr(options: SpawnOptions | undefined): SpawnOptions | undefined {
  if (!options || !isStdoutReservedForResults()) {
    return options;
  }
  const stdio: unknown = options.stdio;
  if (stdio === 'inherit') {
    return { ...options, stdio: ['inherit', 2, 'inherit'] };
  }
  if (!Array.isArray(stdio)) {
    return options;
  }
  const entries: Array<unknown> = Array.from(stdio as Array<unknown>);
  const redirected = entries.map((value, index) =>
    (index === 1 && value === 'inherit') || isStdout(value) ? 2 : value,
  );
  return redirected.some((value, index) => value !== entries[index])
    ? { ...options, stdio: redirected }
    : options;
}

/** Whether a stdio entry is stdout's fd, or a stream on it such as `process.stdout`. */
function isStdout(value: unknown): boolean {
  return (
    value === 1 || (typeof value === 'object' && value !== null && 'fd' in value && value.fd === 1)
  );
}
