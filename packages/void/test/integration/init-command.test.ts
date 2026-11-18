import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { isProcessGroupRunning, stopCommand } from '../../src/cli/init-command.ts';

let root: string;
let beats: string;
const started: Array<ChildProcess> = [];

/** Block this thread, so that Node cannot collect a child that has exited. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Start a command that starts a script, as an installer starts a lifecycle
 * script. Both add a line to the beats file every 10ms while they run. A
 * "stubborn" script goes on after SIGTERM.
 */
function startCommand(script: 'polite' | 'stubborn'): ChildProcess {
  const file = join(root, 'command.cjs');
  writeFileSync(
    file,
    `const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const [beats, script, role = 'command'] = process.argv.slice(2);
if (role === 'command') {
  spawn(process.execPath, [__filename, beats, script, 'script'], { stdio: 'inherit' });
} else if (script === 'stubborn') {
  process.on('SIGTERM', () => {});
}
const beat = () => appendFileSync(beats, role + '\\n');
beat();
setInterval(beat, 10);
`,
  );
  const child = spawn(process.execPath, [file, beats, script], {
    detached: true,
    stdio: 'ignore',
  });
  started.push(child);
  return child;
}

async function commandAndScriptRun(): Promise<void> {
  await vi.waitFor(
    () => {
      const lines = readFileSync(beats, 'utf8');
      expect(lines).toContain('command');
      expect(lines).toContain('script');
    },
    { timeout: 10_000 },
  );
}

/** Whether a process still adds lines, 150ms after `stopCommand` returned. */
async function beatsGoOn(): Promise<boolean> {
  const atReturn = readFileSync(beats, 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 150));
  return readFileSync(beats, 'utf8') !== atReturn;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'void-init-command-'));
  beats = join(root, 'beats');
});

afterEach(() => {
  for (const child of started.splice(0)) {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      // The test has stopped it.
    }
  }
  rmSync(root, { recursive: true, force: true });
});

// Windows has no process groups: init stops a command there with `taskkill`.
describe.skipIf(process.platform === 'win32')('stopCommand (real processes)', () => {
  it('ends a command and what it started before it returns', async () => {
    const child = startCommand('polite');
    await commandAndScriptRun();

    const startedAt = performance.now();
    stopCommand(child);
    const elapsed = performance.now() - startedAt;

    expect(await beatsGoOn()).toBe(false);
    // It returned when the processes ended, not when the time to end ran out.
    expect(elapsed).toBeLessThan(2_000);
  });

  it('kills what goes on after SIGTERM when the time to end is over', async () => {
    const child = startCommand('stubborn');
    await commandAndScriptRun();

    const startedAt = performance.now();
    stopCommand(child, 300);
    const elapsed = performance.now() - startedAt;

    expect(await beatsGoOn()).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(300);
  });

  it('does nothing for a command that did not start', () => {
    expect(() => stopCommand(undefined)).not.toThrow();
  });
});

describe.skipIf(process.platform === 'win32')('isProcessGroupRunning (real processes)', () => {
  // Linux reads /proc and other systems read `ps`. Linux has both, so cover both there.
  const readers = [
    ...(process.platform === 'linux' ? [['/proc', 'linux']] : []),
    ...(existsSync('/bin/ps') ? [['ps', 'darwin']] : []),
  ] as Array<[string, NodeJS.Platform]>;

  it.each(readers)('finds a running process in %s', (_reader, platform) => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    started.push(child);

    expect(isProcessGroupRunning(child.pid!, platform)).toBe(true);
  });

  it.each(readers)(
    'does not count in %s a process that has exited but that Node has not collected',
    (_reader, platform) => {
      const done = join(root, 'done');
      const child = spawn('sh', ['-c', 'echo done > "$0"', done], {
        detached: true,
        stdio: 'ignore',
      });
      started.push(child);
      // Wait without the event loop, as an `exit` listener does.
      for (let waited = 0; !existsSync(done) && waited < 5_000; waited += 10) {
        sleepSync(10);
      }
      sleepSync(100);

      // Node has not seen the exit, and the process still answers a signal.
      expect(child.exitCode).toBeNull();
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      expect(isProcessGroupRunning(child.pid!, platform)).toBe(false);
    },
  );
});
