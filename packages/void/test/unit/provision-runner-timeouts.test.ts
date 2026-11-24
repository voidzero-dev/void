import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { packageFixturePath } from '../../../../test/fixture-dir.ts';
import {
  createDefaultRunWrangler,
  isAlreadyGoneKillError,
  WranglerQuarantineError,
} from '../../src/cli/provision.ts';
import {
  emptyDesired,
  makeRunner,
  provisionCloudflareResources,
  silentLog,
  setupProvisionTestDir,
  waitForDead,
} from './provision-fixtures.ts';

const { tmpDir, wranglerPath, setup } = setupProvisionTestDir('runner-timeouts');

describe('createDefaultRunWrangler — hard timeout kills the REAL process', () => {
  const TIMEOUT_TMP = packageFixturePath(import.meta.dirname, '.tmp-timeout-kill');
  beforeEach(() => {
    rmSync(TIMEOUT_TMP, { recursive: true, force: true });
    mkdirSync(TIMEOUT_TMP, { recursive: true });
  });
  afterEach(() => {
    rmSync(TIMEOUT_TMP, { recursive: true, force: true });
  });

  it('a DIRECT hung CLI is SIGKILLed and the runner REJECTS-as-hard-failure within the timeout', async () => {
    // A direct CLI entry that ignores SIGTERM and hangs forever.
    const hungCli = join(TIMEOUT_TMP, 'hung-cli.cjs');
    writeFileSync(
      hungCli,
      `process.on('SIGTERM', () => {});\n` + `setInterval(() => {}, 1 << 30);\n`,
    );
    let pid: number | undefined;
    const run = createDefaultRunWrangler(TIMEOUT_TMP, {
      launcher: [process.execPath, hungCli],
      onSpawnedChild: (child) => {
        pid = child.pid;
      },
      timeoutMs: 400,
    });
    const start = Date.now();
    const result = await run({ type: 'd1.list' }, { accountId: 'acct' });
    const elapsed = Date.now() - start;
    // A loose bound: the 400ms timer can fire late on a busy machine.
    expect(elapsed).toBeLessThan(15_000);
    expect(result.signal).toBe('SIGKILL');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/exceeded the 400ms command timeout/);
    // The SIGKILL reached the real CLI.
    expect(pid).toBeTypeOf('number');
    expect(await waitForDead(pid!, 10_000)).toBe(true);
  }, 20_000);

  it('a WRAPPER that re-spawns a hung grandchild: runner still settles in time AND the grandchild is reaped', async () => {
    // A `bin/wrangler.js`-style wrapper forwards only SIGTERM and reports a signal death as
    // exit 0, while its grandchild holds the pipes open. Only a process-group kill ends it.
    const gcPidFile = join(TIMEOUT_TMP, 'grandchild.pid');
    const grandchild = join(TIMEOUT_TMP, 'grandchild.cjs');
    writeFileSync(
      grandchild,
      `require('fs').writeFileSync(${JSON.stringify(gcPidFile)}, String(process.pid));\n` +
        `process.on('SIGTERM', () => {});\n` + // ignore the wrapper's forwarded SIGTERM
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const wrapper = join(TIMEOUT_TMP, 'wrapper.cjs');
    writeFileSync(
      wrapper,
      `const { spawn } = require('child_process');\n` +
        // A spawn can fail with EAGAIN under load. Retry, and keep the wrapper alive so the
        // timeout path still runs instead of a normal close.
        `let child;\n` +
        `function launch() {\n` +
        `  try {\n` +
        `    child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: ['inherit','inherit','inherit'] });\n` +
        `    child.on('error', () => { child = undefined; setTimeout(launch, 50); });\n` +
        `    child.on('exit', (code) => process.exit(code === null ? 0 : code));\n` + // mask signal death as exit 0
        `  } catch { setTimeout(launch, 50); }\n` +
        `}\n` +
        `launch();\n` +
        `process.on('SIGTERM', () => { if (child) child.kill(); });\n` + // forward only SIGTERM (default)
        `process.on('SIGINT', () => { if (child) child.kill(); });\n` +
        `setInterval(() => {}, 1 << 30);\n`, // keep the wrapper alive until the group is killed
    );
    const run = createDefaultRunWrangler(TIMEOUT_TMP, {
      launcher: [process.execPath, wrapper],
      // Long enough for the wrapper and grandchild to start under load.
      timeoutMs: 1500,
    });
    const start = Date.now();
    const result = await run({ type: 'd1.list' }, { accountId: 'acct' });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(20_000);
    expect(result.signal).toBe('SIGKILL');
    expect(result.status).not.toBe(0);
    // The process-group kill reaped the grandchild too.
    const gcPid = Number(readFileSync(gcPidFile, 'utf8'));
    expect(Number.isInteger(gcPid)).toBe(true);
    expect(await waitForDead(gcPid, 10_000)).toBe(true);
  }, 25_000);
});

describe('withListerDeadline — the deadline holds in a real process', () => {
  const LISTER_DEADLINE_TMP = packageFixturePath(import.meta.dirname, '.tmp-lister-deadline');
  beforeEach(() => {
    rmSync(LISTER_DEADLINE_TMP, { recursive: true, force: true });
    mkdirSync(LISTER_DEADLINE_TMP, { recursive: true });
  });
  afterEach(() => {
    rmSync(LISTER_DEADLINE_TMP, { recursive: true, force: true });
  });

  it('a never-settling lister REJECTS after the deadline — the process does NOT exit 0 early, lock released', async () => {
    // Nothing else keeps the event loop alive while the lister hangs, and Vitest's own
    // handles would hide that, so this runs in a separate process.
    const appRoot = join(LISTER_DEADLINE_TMP, 'app');
    const probe = join(LISTER_DEADLINE_TMP, 'probe.mjs');
    const provisionUrl = `file://${join(import.meta.dirname, '../../src/cli/provision.ts')}`;
    writeFileSync(
      probe,
      `import { mkdirSync, writeFileSync } from 'node:fs';\n` +
        `import { join } from 'node:path';\n` +
        `import { provisionCloudflareResources } from ${JSON.stringify(provisionUrl)};\n` +
        `const root = ${JSON.stringify(appRoot)};\n` +
        `mkdirSync(root, { recursive: true });\n` +
        `const cfg = join(root, 'wrangler.jsonc');\n` +
        `writeFileSync(cfg, JSON.stringify({ name: 'app', account_id: 'acct' }));\n` +
        `provisionCloudflareResources(root, cfg, {\n` +
        `  kvNamespaces: [],\n` +
        `  queues: [],\n` +
        `  hyperdrive: { binding: 'HYPERDRIVE', name: 'probe-hd', connectionString: 'postgres://u:pw@h/db' },\n` +
        `}, {\n` +
        `  runWrangler: () => ({ stdout: '', stderr: '', status: 0 }),\n` +
        `  listHyperdriveConfigs: () => new Promise(() => {}),\n` +
        `  listTimeoutMs: 500,\n` +
        `  log: { info: () => {}, warn: (m) => console.log('WARN:' + m) },\n` +
        `}).then(\n` +
        `  () => console.log('RESOLVED'),\n` +
        `  (err) => { console.log('REJECTED:' + err.message); process.exitCode = 7; },\n` +
        `);\n`,
    );
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [probe], {
      cwd: LISTER_DEADLINE_TMP,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try {
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((res) => {
        child.on('close', (c, s) => res([c, s]));
      });
      expect(signal).toBeNull();
      expect(code).toBe(7);
      expect(stdout).toContain('exceeded the 500ms deadline');
      expect(stdout).toContain('REJECTED:');
      expect(stdout).not.toContain('RESOLVED');
      expect(existsSync(join(appRoot, 'wrangler.jsonc.void-provision.lock.lock'))).toBe(false);
    } finally {
      clearTimeout(killTimer);
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }, 20_000);
});

describe('provisionCloudflareResources — Hyperdrive lister deadline', () => {
  it('the deadline signal is aborted when the deadline fires (so a real fetch would cancel)', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    let capturedSignal: AbortSignal | undefined;
    const { run } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
        },
        {
          runWrangler: run,
          log: silentLog,
          listHyperdriveConfigs: (ctx) => {
            capturedSignal = ctx.signal;
            return new Promise<never>(() => {});
          },
          listTimeoutMs: 150,
        },
      ),
    ).rejects.toThrow(/could not check whether/);
    expect(capturedSignal?.aborted).toBe(true);
  }, 10_000);
});

describe('createDefaultRunWrangler — confirmed child termination + kill classification', () => {
  // A unique directory per test: a pid file left by another run may name a reused pid.
  let killClassifyTmp = '';
  // Windows keeps a dead child's cwd and files busy for a moment, so retry the removal. A
  // leftover fails the test only while a recorded pid is still alive. Never kill by pid here.
  const rmTmp = (): void => {
    if (killClassifyTmp === '') {
      return;
    }
    try {
      rmSync(killClassifyTmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
      return;
    } catch (error) {
      const left = existsSync(killClassifyTmp) ? readdirSync(killClassifyTmp) : [];
      const live = left
        .filter((entry) => entry.endsWith('.pid'))
        .map((entry) => Number(readFileSync(join(killClassifyTmp, entry), 'utf8').trim()))
        .filter((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        });
      const detail =
        `${(error as Error).message}\n` +
        `  entries remaining: ${left.length > 0 ? left.join(', ') : '(none)'}\n` +
        `  recorded pids still resolving to a live process: ${live.length > 0 ? live.join(', ') : 'none'}`;
      if (live.length > 0) {
        throw new Error(`could not remove ${killClassifyTmp}: ${detail}`);
      }
      // Nothing of ours is running, so warn instead of failing on temp-file cleanup.
      console.warn(`warn: leaving ${killClassifyTmp} behind — ${detail}`);
    }
  };
  beforeEach(() => {
    killClassifyTmp = mkdtempSync(packageFixturePath(import.meta.dirname, '.tmp-kill-classify-'));
  });
  afterEach(() => {
    rmTmp();
  });

  it('isAlreadyGoneKillError: ESRCH → true (already gone), any other code → false (real failure)', () => {
    expect(isAlreadyGoneKillError(Object.assign(new Error('x'), { code: 'ESRCH' }))).toBe(true);
    expect(isAlreadyGoneKillError(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe(false);
    expect(isAlreadyGoneKillError(new Error('x'))).toBe(false);
    expect(isAlreadyGoneKillError(null)).toBe(false);
  });

  it('a REAL kill failure (EPERM) on timeout QUARANTINES: the runner REJECTS, never settle-and-release', async () => {
    const pidFile = join(killClassifyTmp, 'cli.pid');
    const hungCli = join(killClassifyTmp, 'hung.cjs');
    writeFileSync(
      hungCli,
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    let spawnedPid: number | undefined;
    const run = createDefaultRunWrangler(killClassifyTmp, {
      launcher: [process.execPath, hungCli],
      onSpawnedChild: (child) => {
        spawnedPid = child.pid;
      },
      timeoutMs: 300,
      // Simulate a kill that FAILS for a non-ESRCH reason (the child is still alive).
      killProcessGroup: () => {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      },
    });
    // The child may still run, so the runner rejects: resolving would let the caller release
    // the lock under a live child.
    let rejected: unknown;
    try {
      await run({ type: 'd1.list' }, { accountId: 'acct' });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(WranglerQuarantineError);
    const err = rejected as WranglerQuarantineError;
    expect(err.quarantine).toBe(true);
    expect(err.message).toMatch(/could not be killed: EPERM/);
    expect(err.message).toMatch(/intentionally RETAINED/);
    expect(err.message).toMatch(/pid \d+/);
    // The child is still alive; prove it, then clean up.
    const pid = spawnedPid!;
    expect(pid).toBeTypeOf('number');
    expect(() => process.kill(pid, 0)).not.toThrow();
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
    expect(await waitForDead(pid, 10_000)).toBe(true);
  }, 15_000);

  it('an unconfirmable termination (grace expiry, child still alive) QUARANTINES too', async () => {
    const pidFile = join(killClassifyTmp, 'cli3.pid');
    const hungCli = join(killClassifyTmp, 'hung3.cjs');
    writeFileSync(
      hungCli,
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    let spawnedPid: number | undefined;
    const run = createDefaultRunWrangler(killClassifyTmp, {
      launcher: [process.execPath, hungCli],
      onSpawnedChild: (child) => {
        spawnedPid = child.pid;
      },
      timeoutMs: 250,
      confirmKillGraceMs: 500,
      // A killer that CLAIMS success but kills nothing: the group stays alive, so
      // close/group-gone can never both be confirmed → quarantine at the grace expiry.
      killProcessGroup: () => {},
    });
    let rejected: unknown;
    try {
      await run({ type: 'd1.list' }, { accountId: 'acct' });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(WranglerQuarantineError);
    expect((rejected as Error).message).toMatch(/could not be confirmed terminated within 500ms/);
    expect((rejected as Error).message).toMatch(/intentionally RETAINED/);
    // Clean up the real child the fake killer left alive.
    const pid = spawnedPid!;
    expect(pid).toBeTypeOf('number');
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
    expect(await waitForDead(pid, 10_000)).toBe(true);
  }, 15_000);

  it('an ESRCH kill (already gone) is treated as SUCCESS — settles as the timeout hard-failure, no kill-error text', async () => {
    const pidFile = join(killClassifyTmp, 'cli2.pid');
    const hungCli = join(killClassifyTmp, 'hung2.cjs');
    writeFileSync(
      hungCli,
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    let spawnedPid: number | undefined;
    const run = createDefaultRunWrangler(killClassifyTmp, {
      launcher: [process.execPath, hungCli],
      onSpawnedChild: (child) => {
        spawnedPid = child.pid;
      },
      timeoutMs: 300,
      // Kill FOR REAL, then report ESRCH (the child exited in the race window) → treated as gone.
      killProcessGroup: (target, signal) => {
        process.kill(target, signal);
        throw Object.assign(new Error('ESRCH: no such process'), { code: 'ESRCH' });
      },
    });
    const result = await run({ type: 'd1.list' }, { accountId: 'acct' });
    expect(result.signal).toBe('SIGKILL');
    expect(result.status).not.toBe(0);
    // ESRCH is NOT a kill failure — no "could not be killed" surfaced.
    expect(result.stderr).not.toMatch(/could not be killed/);
    expect(result.error).toBeNull();
    const pid = spawnedPid!;
    expect(pid).toBeTypeOf('number');
    expect(await waitForDead(pid, 10_000)).toBe(true);
  }, 15_000);

  it('lock is released only AFTER confirmed child termination: a hung wrangler → provision rejects, child dead, mutex gone', async () => {
    const cfgDir = join(killClassifyTmp, 'app');
    mkdirSync(cfgDir, { recursive: true });
    const cfgPath = join(cfgDir, 'wrangler.jsonc');
    writeFileSync(cfgPath, JSON.stringify({ name: 'app', account_id: 'acct' }));
    const pidFile = join(killClassifyTmp, 'prov-cli.pid');
    const hungCli = join(killClassifyTmp, 'prov-hung.cjs');
    writeFileSync(
      hungCli,
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `process.on('SIGTERM', () => {});\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    let spawnedPid: number | undefined;
    const runner = createDefaultRunWrangler(cfgDir, {
      launcher: [process.execPath, hungCli],
      onSpawnedChild: (child) => {
        spawnedPid = child.pid;
      },
      timeoutMs: 400,
    });
    const lockMutex = `${realpathSync(cfgPath)}.void-provision.lock.lock`;
    await expect(
      provisionCloudflareResources(
        cfgDir,
        cfgPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: runner, log: silentLog },
      ),
    ).rejects.toThrow(/d1 list.*(failed|timeout)/s);
    const pid = spawnedPid!;
    expect(pid).toBeTypeOf('number');
    expect(await waitForDead(pid, 5000)).toBe(true);
    expect(existsSync(lockMutex)).toBe(false);
  }, 15_000);
});
