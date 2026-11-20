import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { packageFixturePath } from '../../../../test/fixture-dir.ts';
import {
  acquireProvisionLock,
  createDefaultRunWrangler,
  normalizeRunWranglerResult,
  WranglerQuarantineError,
} from '../../src/cli/provision.ts';
import { waitForDead } from './provision-fixtures.ts';

describe('normalizeRunWranglerResult — signal / spawn-error handling', () => {
  it('treats a SIGTERM-killed child (status null, signal set) as FAILURE, not success', () => {
    const r = normalizeRunWranglerResult({
      stdout: '',
      stderr: '',
      status: null,
      signal: 'SIGTERM',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('SIGTERM');
  });

  it('treats a spawn error as FAILURE and surfaces its message', () => {
    const r = normalizeRunWranglerResult({
      status: null,
      error: new Error('spawn wrangler ENOENT'),
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('ENOENT');
  });

  it('passes a clean exit through unchanged (0 stays success, a real non-zero is preserved)', () => {
    expect(normalizeRunWranglerResult({ status: 0, stdout: 'ok' }).status).toBe(0);
    expect(normalizeRunWranglerResult({ status: 2, stderr: 'boom' }).status).toBe(2);
  });

  it('carries structured signal/error provenance', () => {
    const killed = normalizeRunWranglerResult({ status: null, signal: 'SIGTERM' });
    expect(killed.signal).toBe('SIGTERM');
    expect(killed.error).toBeNull();
    const errored = normalizeRunWranglerResult({ status: null, error: new Error('ENOENT') });
    expect(errored.error).toContain('ENOENT');
    const clean = normalizeRunWranglerResult({ status: 0, stdout: 'ok' });
    expect(clean.signal).toBeNull();
    expect(clean.error).toBeNull();
  });
});

// Windows cannot deliver a signal to another process: libuv maps it to `TerminateProcess`,
// which runs no handler. Tests that signal a real parent process are POSIX-only.
const WINDOWS_NO_SIGNALS = 'signal delivery to another process is POSIX-only (see note above)';

async function waitForPid(pidFile: string, timeoutMs: number): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(pidFile)) {
      const raw = readFileSync(pidFile, 'utf-8');
      if (raw.length > 0) {
        return Number(raw);
      }
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

describe('createDefaultRunWrangler — normal close confirms the whole GROUP', () => {
  const GROUP_CLOSE_TMP = packageFixturePath(import.meta.dirname, '.tmp-group-close');
  beforeEach(() => {
    rmSync(GROUP_CLOSE_TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    mkdirSync(GROUP_CLOSE_TMP, { recursive: true });
  });
  afterEach(() => {
    // Windows may retain the exited child's cwd handle briefly after the
    // liveness assertion passes. Retry removal without weakening that assertion.
    rmSync(GROUP_CLOSE_TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  it('an exit-0 leader that leaves a SAME-GROUP grandchild alive: the runner resolves only after the group is dead', async () => {
    // `close` fires when the leader exits, but a same-group grandchild can outlive it.
    const gcPidFile = join(GROUP_CLOSE_TMP, 'gc.pid');
    const gc = join(GROUP_CLOSE_TMP, 'gc.cjs');
    writeFileSync(
      gc,
      `require('fs').writeFileSync(${JSON.stringify(gcPidFile)}, String(process.pid));\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const leader = join(GROUP_CLOSE_TMP, 'leader.cjs');
    writeFileSync(
      leader,
      `const { spawn } = require('child_process');\n` +
        `const fs = require('fs');\n` +
        // Same process group (not detached), but its OWN stdio — so the leader's exit
        // fires `close` while the grandchild lives on in the group.
        `const c = spawn(process.execPath, [${JSON.stringify(gc)}], { stdio: 'ignore' });\n` +
        `c.unref();\n` +
        `setInterval(() => {\n` +
        `  if (fs.existsSync(${JSON.stringify(gcPidFile)})) { console.log(JSON.stringify({ operationResult: 1 })); process.exit(0); }\n` +
        `}, 10);\n`,
    );
    const run = createDefaultRunWrangler(GROUP_CLOSE_TMP, {
      launcher: [process.execPath, leader],
      timeoutMs: 30_000,
    });
    const result = await run({ type: 'd1.list' }, { accountId: 'acct' });
    // The clean exit is reported only after the grandchild was reaped.
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    const gcPid = Number(readFileSync(gcPidFile, 'utf-8'));
    expect(Number.isInteger(gcPid)).toBe(true);
    let alive = true;
    try {
      process.kill(gcPid, 0);
    } catch {
      alive = false;
    }
    try {
      process.kill(gcPid, 'SIGKILL'); // never leak on assertion failure
    } catch {
      // already gone
    }
    expect(alive).toBe(false);
  }, 15_000);
});

describe('createDefaultRunWrangler — signal-path kill failure quarantines the lock (child-process)', () => {
  const SIGNAL_KILL_TMP = packageFixturePath(import.meta.dirname, '.tmp-signal-kill');
  beforeEach(() => {
    rmSync(SIGNAL_KILL_TMP, { recursive: true, force: true });
    mkdirSync(SIGNAL_KILL_TMP, { recursive: true });
  });
  afterEach(() => {
    rmSync(SIGNAL_KILL_TMP, { recursive: true, force: true });
  });

  it('SIGTERM + an injected kill FAILURE: the parent dies with mutex + sidecar RETAINED; the gate blocks until the child dies', async (ctx) => {
    ctx.skip(process.platform === 'win32', WINDOWS_NO_SIGNALS);
    // After a failed kill the parent must quarantine before re-raising; otherwise
    // proper-lockfile's exit hook removes the lock while the child still runs.
    const appRoot = join(SIGNAL_KILL_TMP, 'app');
    const pidFile = join(SIGNAL_KILL_TMP, 'child.pid');
    const hungCli = join(SIGNAL_KILL_TMP, 'hung.cjs');
    writeFileSync(
      hungCli,
      `require('fs').writeFileSync(process.argv[2], String(process.pid));\n` +
        `process.on('SIGTERM', () => {});\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const parentScript = join(SIGNAL_KILL_TMP, 'parent.mjs');
    const provisionUrl = `file://${join(import.meta.dirname, '../../src/cli/provision.ts')}`;
    writeFileSync(
      parentScript,
      `import { mkdirSync, writeFileSync } from 'node:fs';\n` +
        `import { join } from 'node:path';\n` +
        `import { provisionCloudflareResources, createDefaultRunWrangler } from ${JSON.stringify(provisionUrl)};\n` +
        `const root = ${JSON.stringify(appRoot)};\n` +
        `mkdirSync(root, { recursive: true });\n` +
        `const cfg = join(root, 'wrangler.jsonc');\n` +
        `writeFileSync(cfg, JSON.stringify({ name: 'app', account_id: 'acct' }));\n` +
        `const runner = createDefaultRunWrangler(root, {\n` +
        `  launcher: [process.execPath, ${JSON.stringify(hungCli)}, ${JSON.stringify(pidFile)}],\n` +
        `  killProcessGroup: () => {\n` +
        `    throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });\n` +
        `  },\n` +
        `});\n` +
        `provisionCloudflareResources(root, cfg, { kvNamespaces: [], queues: [], d1: { binding: 'DB', name: 'myapp-db' } }, {\n` +
        `  runWrangler: runner,\n` +
        `  log: { info: () => {}, warn: () => {} },\n` +
        `}).then(\n` +
        `  () => console.log('RESOLVED'),\n` +
        `  (e) => console.log('REJECTED:' + e.message),\n` +
        `);\n`,
    );
    const { spawn } = await import('node:child_process');
    const parent = spawn(process.execPath, [parentScript], {
      cwd: SIGNAL_KILL_TMP,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childPid: number | undefined;
    try {
      // The hung child wrote its pid, so the provision holds the lock.
      childPid = await waitForPid(pidFile, 10_000);
      expect(childPid).toBeDefined();
      parent.kill('SIGTERM');
      const [, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((res) => {
        parent.on('exit', (code, sig) => res([code, sig]));
      });
      expect(signal).toBe('SIGTERM');
      // The quarantine ran before the re-raise, so the exit sweep left the lock on disk.
      const cfgReal = realpathSync(join(appRoot, 'wrangler.jsonc'));
      const lockMutex = `${cfgReal}.void-provision.lock.lock`;
      const sidecar = `${cfgReal}.void-provision.lock.quarantine.json`;
      expect(existsSync(lockMutex)).toBe(true);
      expect(existsSync(sidecar)).toBe(true);
      const recorded = JSON.parse(readFileSync(sidecar, 'utf-8')) as Record<string, unknown>;
      expect(recorded.pid).toBe(childPid);
      expect(String(recorded.reason)).toMatch(/SIGTERM/);
      // The child is still alive, so the gate fails closed even on a stale mutex.
      expect(() => process.kill(childPid!, 0)).not.toThrow();
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(lockMutex, old, old);
      await expect(acquireProvisionLock(cfgReal, { stale: 2_000, retries: 0 })).rejects.toThrow(
        /QUARANTINED/,
      );
      // Kill the recorded group; the next acquisition clears the quarantine + proceeds.
      try {
        process.kill(-childPid!, 'SIGKILL');
      } catch {
        process.kill(childPid!, 'SIGKILL');
      }
      expect(await waitForDead(childPid!, 5_000)).toBe(true);
      const lock = await acquireProvisionLock(cfgReal, { stale: 2_000, retries: 5 });
      expect(existsSync(sidecar)).toBe(false);
      await lock.release();
      expect(existsSync(lockMutex)).toBe(false);
    } finally {
      // Never leak processes, even on assertion failure.
      try {
        parent.kill('SIGKILL');
      } catch {
        // already gone
      }
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }, 30_000);
});

describe('createDefaultRunWrangler — ONE signal coordinator: repeated signals coalesced, teardown bounded, spawns rejected', () => {
  const COORDINATOR_TMP = packageFixturePath(import.meta.dirname, '.tmp-signal-coordinator');
  beforeEach(() => {
    rmSync(COORDINATOR_TMP, { recursive: true, force: true });
    mkdirSync(COORDINATOR_TMP, { recursive: true });
  });
  afterEach(() => {
    rmSync(COORDINATOR_TMP, { recursive: true, force: true });
  });

  it('a SECOND concurrently-active wrangler child is rejected PRE-SPAWN (at most one registrant)', async () => {
    // Calls within a provision are sequential and one provision runs per process, so a
    // second active child is a caller bug.
    const slowChild = join(COORDINATOR_TMP, 'slow-child.cjs');
    writeFileSync(
      slowChild,
      `setTimeout(() => { console.log(JSON.stringify({ operationResult: 1 })); process.exit(0); }, 400);\n`,
    );
    const runA = createDefaultRunWrangler(COORDINATOR_TMP, {
      launcher: [process.execPath, slowChild],
      timeoutMs: 30_000,
    });
    const first = runA({ type: 'd1.list' }, { accountId: 'acct' });
    await new Promise((r) => setTimeout(r, 80)); // A's child is alive and registered
    const runB = createDefaultRunWrangler(COORDINATOR_TMP, {
      launcher: [process.execPath, slowChild],
      timeoutMs: 30_000,
    });
    await expect(runB({ type: 'd1.list' }, { accountId: 'acct' })).rejects.toThrow(
      /another one is already active in this process/,
    );
    // The first runner is unaffected and settles cleanly.
    const result = await first;
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
  }, 15_000);

  it('permits two immutable Worker uploads while rejecting a third upload or traffic mutation', async () => {
    const slowChild = join(COORDINATOR_TMP, 'parallel-upload.cjs');
    writeFileSync(
      slowChild,
      `setTimeout(() => { console.log(JSON.stringify({ operationResult: 1 })); process.exit(0); }, 400);\n`,
    );
    const spawned: Array<number | undefined> = [];
    const run = createDefaultRunWrangler(COORDINATOR_TMP, {
      launcher: [process.execPath, slowChild],
      onSpawnedChild: (child) => spawned.push(child.pid),
      parallelWorkerUpload: true,
      timeoutMs: 30_000,
    });
    const first = run({ type: 'versions.upload' }, { accountId: 'acct' });
    const second = run({ type: 'versions.upload' }, { accountId: 'acct' });
    expect(spawned).toHaveLength(2);
    await expect(run({ type: 'versions.upload' }, { accountId: 'acct' })).rejects.toThrow(
      /another one is already active in this process/,
    );
    await expect(
      run({ type: 'versions.deploy', versions: [] }, { accountId: 'acct' }),
    ).rejects.toThrow(/another one is already active in this process/);
    expect(spawned).toHaveLength(2);
    expect((await Promise.all([first, second])).map((result) => result.status)).toEqual([0, 0]);
    expect(
      (await run({ type: 'versions.deploy', versions: [] }, { accountId: 'acct' })).status,
    ).toBe(0);
  }, 15_000);

  it('confirms both parallel upload process groups have exited before forwarding SIGTERM', async (ctx) => {
    ctx.skip(process.platform === 'win32', WINDOWS_NO_SIGNALS);
    const pidFiles = [join(COORDINATOR_TMP, 'upload-a.pid'), join(COORDINATOR_TMP, 'upload-b.pid')];
    const childScript = join(COORDINATOR_TMP, 'upload-slow-exit.cjs');
    writeFileSync(
      childScript,
      `require('fs').writeFileSync(process.argv[2], String(process.pid));\n` +
        `process.on('SIGTERM', () => setTimeout(() => process.exit(0), 500));\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const parentScript = join(COORDINATOR_TMP, 'parallel-upload-parent.mjs');
    const provisionUrl = `file://${join(import.meta.dirname, '../../src/cli/provision.ts')}`;
    writeFileSync(
      parentScript,
      `import { createDefaultRunWrangler } from ${JSON.stringify(provisionUrl)};\n` +
        pidFiles
          .map(
            (pidFile) =>
              `createDefaultRunWrangler(process.cwd(), { launcher: [process.execPath, ${JSON.stringify(childScript)}, ${JSON.stringify(pidFile)}], parallelWorkerUpload: true })({ type: 'versions.upload' }, { accountId: 'acct' }).catch(() => {});\n`,
          )
          .join(''),
    );
    const { spawn } = await import('node:child_process');
    const parent = spawn(process.execPath, [parentScript], {
      cwd: COORDINATOR_TMP,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pids: Array<number> = [];
    try {
      for (const file of pidFiles) {
        const pid = await waitForPid(file, 10_000);
        expect(pid).toBeDefined();
        pids.push(pid!);
      }
      parent.kill('SIGTERM');
      const signal = await new Promise<NodeJS.Signals | null>((resolve) => {
        parent.on('exit', (_code, received) => resolve(received));
      });
      expect(signal).toBe('SIGTERM');
      for (const pid of pids) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally {
      parent.kill('SIGKILL');
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }, 20_000);

  it('one SIGTERM (+ a repeat mid-teardown) is coalesced: the parent re-raises only after the group is dead', async (ctx) => {
    ctx.skip(process.platform === 'win32', WINDOWS_NO_SIGNALS);
    // The handler stays installed through the teardown, so a repeated signal cannot take
    // Node's default action and kill the parent while the child is alive.
    const pidFile = join(COORDINATOR_TMP, 'a.pid');
    const childScript = join(COORDINATOR_TMP, 'slow-exit-child.cjs');
    writeFileSync(
      childScript,
      `require('fs').writeFileSync(process.argv[2], String(process.pid));\n` +
        `process.on('SIGTERM', () => setTimeout(() => process.exit(0), 600));\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const parentScript = join(COORDINATOR_TMP, 'parent.mjs');
    const provisionUrl = `file://${join(import.meta.dirname, '../../src/cli/provision.ts')}`;
    writeFileSync(
      parentScript,
      `import { createDefaultRunWrangler } from ${JSON.stringify(provisionUrl)};\n` +
        `const runA = createDefaultRunWrangler(process.cwd(), {\n` +
        `  launcher: [process.execPath, ${JSON.stringify(childScript)}, ${JSON.stringify(pidFile)}],\n` +
        `});\n` +
        `runA({ type: 'd1.list' }, { accountId: 'acct' }).then(\n` +
        `  (r) => console.log('A-settled', r.status, r.signal),\n` +
        `  (e) => console.log('A-rejected', e.message),\n` +
        `);\n`,
    );
    const { spawn } = await import('node:child_process');
    const parent = spawn(process.execPath, [parentScript], {
      cwd: COORDINATOR_TMP,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pid: number | undefined;
    try {
      pid = await waitForPid(pidFile, 10_000);
      expect(pid).toBeDefined();
      parent.kill('SIGTERM');
      // The repeat lands mid-teardown, while the child is still alive.
      setTimeout(() => {
        try {
          parent.kill('SIGTERM');
        } catch {
          // parent already gone (that itself would fail the assertions below)
        }
      }, 120);
      const [, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((res) => {
        parent.on('exit', (code, sig) => res([code, sig]));
      });
      expect(signal).toBe('SIGTERM');
      // The slow child was already dead when the parent exited.
      let alive = true;
      try {
        process.kill(pid!, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    } finally {
      try {
        parent.kill('SIGKILL');
      } catch {
        // already gone
      }
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }, 20_000);

  it('a spawn attempted AFTER teardown began is rejected fast (no child spawned, teardown unaffected)', async (ctx) => {
    ctx.skip(process.platform === 'win32', WINDOWS_NO_SIGNALS);
    const pidFile = join(COORDINATOR_TMP, 'c.pid');
    const childScript = join(COORDINATOR_TMP, 'slow-exit-child2.cjs');
    writeFileSync(
      childScript,
      `require('fs').writeFileSync(process.argv[2], String(process.pid));\n` +
        `process.on('SIGTERM', () => setTimeout(() => process.exit(0), 400));\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const outcomeFile = join(COORDINATOR_TMP, 'late-spawn-outcome.txt');
    const parentScript = join(COORDINATOR_TMP, 'parent-spawn-mid-teardown.mjs');
    const provisionUrl = `file://${join(import.meta.dirname, '../../src/cli/provision.ts')}`;
    writeFileSync(
      parentScript,
      `import { writeFileSync } from 'node:fs';\n` +
        `import { createDefaultRunWrangler } from ${JSON.stringify(provisionUrl)};\n` +
        `const run = createDefaultRunWrangler(process.cwd(), {\n` +
        `  launcher: [process.execPath, ${JSON.stringify(childScript)}, ${JSON.stringify(pidFile)}],\n` +
        `});\n` +
        `run({ type: 'd1.list' }, { accountId: 'acct' }).catch(() => {});\n` +
        // A once-listener cannot swallow the later re-raise. The outcome is written
        // synchronously so the re-raised signal cannot lose it.
        `process.once('SIGTERM', () => {\n` +
        `  setTimeout(() => {\n` +
        `    run({ type: 'd1.list' }, { accountId: 'acct' }).then(\n` +
        `      () => writeFileSync(${JSON.stringify(outcomeFile)}, 'LATE-SPAWN-ALLOWED'),\n` +
        `      (e) => writeFileSync(${JSON.stringify(outcomeFile)}, 'LATE-SPAWN-REJECTED:' + e.message),\n` +
        `    );\n` +
        `  }, 50);\n` +
        `});\n`,
    );
    const { spawn } = await import('node:child_process');
    const parent = spawn(process.execPath, [parentScript], {
      cwd: COORDINATOR_TMP,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pid: number | undefined;
    try {
      pid = await waitForPid(pidFile, 10_000);
      expect(pid).toBeDefined();
      parent.kill('SIGTERM');
      const [, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((res) => {
        parent.on('exit', (code, sig) => res([code, sig]));
      });
      expect(signal).toBe('SIGTERM');
      const outcome = readFileSync(outcomeFile, 'utf-8');
      expect(outcome).toContain('LATE-SPAWN-REJECTED:');
      expect(outcome).toMatch(
        /refusing to spawn a Cloudflare operation process.*fatal SIGTERM.*terminating/s,
      );
    } finally {
      try {
        parent.kill('SIGKILL');
      } catch {
        // already gone
      }
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }, 20_000);

  it('the coordinator-WIDE deadline bounds an unconfirmable teardown (quarantine + re-raise, never a wedge)', async (ctx) => {
    ctx.skip(process.platform === 'win32', WINDOWS_NO_SIGNALS);
    // The child never dies and the runner would wait 60s, so only the 800ms teardown
    // deadline can quarantine it and re-raise.
    const pidFile = join(COORDINATOR_TMP, 'd.pid');
    const hangScript = join(COORDINATOR_TMP, 'hang-child.cjs');
    writeFileSync(
      hangScript,
      `require('fs').writeFileSync(process.argv[2], String(process.pid));\n` +
        `process.on('SIGTERM', () => {});\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const parentScript = join(COORDINATOR_TMP, 'parent-deadline.mjs');
    const provisionUrl = `file://${join(import.meta.dirname, '../../src/cli/provision.ts')}`;
    writeFileSync(
      parentScript,
      `import { createDefaultRunWrangler } from ${JSON.stringify(provisionUrl)};\n` +
        `const run = createDefaultRunWrangler(process.cwd(), {\n` +
        `  launcher: [process.execPath, ${JSON.stringify(hangScript)}, ${JSON.stringify(pidFile)}],\n` +
        `  confirmKillGraceMs: 60_000,\n` +
        `  signalTeardownDeadlineMs: 800,\n` +
        `  killProcessGroup: () => {},\n` + // claims success, kills nothing
        `});\n` +
        `run({ type: 'd1.list' }, { accountId: 'acct' }).catch(() => {});\n`,
    );
    const { spawn } = await import('node:child_process');
    const parent = spawn(process.execPath, [parentScript], {
      cwd: COORDINATOR_TMP,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pid: number | undefined;
    try {
      pid = await waitForPid(pidFile, 10_000);
      expect(pid).toBeDefined();
      const killedAt = Date.now();
      parent.kill('SIGTERM');
      const [, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((res) => {
        parent.on('exit', (code, sig) => res([code, sig]));
      });
      const elapsed = Date.now() - killedAt;
      expect(signal).toBe('SIGTERM');
      expect(elapsed).toBeGreaterThanOrEqual(700);
      expect(elapsed).toBeLessThan(15_000);
      // The child is still alive, so the teardown ended through the deadline's quarantine.
      expect(() => process.kill(pid!, 0)).not.toThrow();
    } finally {
      try {
        parent.kill('SIGKILL');
      } catch {
        // already gone
      }
      if (pid !== undefined) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }
    }
  }, 20_000);
});

describe('createDefaultRunWrangler — post-spawn child `error` events confirm/quarantine', () => {
  const POST_SPAWN_TMP = packageFixturePath(import.meta.dirname, '.tmp-post-spawn-error');
  const spawnedChildren = new Set<import('node:child_process').ChildProcess>();
  beforeEach(() => {
    rmSync(POST_SPAWN_TMP, { recursive: true, force: true });
    mkdirSync(POST_SPAWN_TMP, { recursive: true });
  });
  afterEach(async () => {
    // A test deadline can interrupt the assertion before the runner's deadline.
    // Wait for actual close before removing a directory a Windows child uses as cwd.
    for (const child of spawnedChildren) {
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.kill('SIGKILL');
      await closed;
    }
    rmSync(POST_SPAWN_TMP, { recursive: true, force: true });
  });

  function createRunner(options: NonNullable<Parameters<typeof createDefaultRunWrangler>[1]>) {
    return createDefaultRunWrangler(POST_SPAWN_TMP, {
      ...options,
      onSpawnedChild: (child) => {
        spawnedChildren.add(child);
        child.once('close', () => spawnedChildren.delete(child));
        options.onSpawnedChild?.(child);
      },
    });
  }

  function writeHangScript(path: string): void {
    // Ignores SIGTERM; only the machine's SIGKILL can end it.
    writeFileSync(
      path,
      `require('fs').writeFileSync(process.argv[2], String(process.pid));\n` +
        `process.on('SIGTERM', () => {});\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
  }

  function reapPidFile(pidFile: string): number | undefined {
    if (!existsSync(pidFile)) {
      return undefined;
    }
    const pid = Number(readFileSync(pidFile, 'utf-8'));
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    return pid;
  }

  function injectErrorAfterChildStarts(
    child: import('node:child_process').ChildProcess,
    pidFile: string,
    message: string,
  ): void {
    // A fixed delay can fire before Node loads the child script on a busy runner.
    // Wait until the child has written its PID so this is truly a post-spawn error.
    void (async () => {
      const deadline = Date.now() + 5_000;
      while (!existsSync(pidFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      child.emit('error', new Error(message));
    })();
  }

  it('pre-spawn ENOENT still settles directly as a hard failure (the one carve-out: no pid, nothing to confirm)', async () => {
    const run = createRunner({
      launcher: [join(POST_SPAWN_TMP, 'no-such-wrangler-binary')],
    });
    const result = await run(
      {
        type: 'hyperdrive.create',
        name: 'missing-launcher-db',
        binding: 'HYPERDRIVE',
        configPath: 'literal config.jsonc',
      },
      { accountId: 'acct', input: 'postgres://user:secret@localhost/db' },
    );
    expect(result.status).toBe(1);
    expect(result.error).toContain('ENOENT');
    expect(result.signal).toBeNull();
  });

  it('an early closed stdin rejects a buffered success envelope and confirms child termination', async (ctx) => {
    // A live Node process on Windows keeps inherited pipe handles after closing fd 0.
    // The peer-exit and Writable-error tests below cover Windows.
    ctx.skip(
      process.platform === 'win32',
      'closing a live child stdin descriptor does not close inherited Windows pipe handles',
    );
    const script = join(POST_SPAWN_TMP, 'closed-stdin.cjs');
    const pidFile = join(POST_SPAWN_TMP, 'closed-stdin.pid');
    writeFileSync(
      script,
      `const fs = require('fs');\n` +
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `fs.writeSync(1, JSON.stringify({ operationResult: 1, data: { id: 'provider-id' } }));\n` +
        `fs.closeSync(0);\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const run = createRunner({
      launcher: [process.execPath, script],
      timeoutMs: 30_000,
    });
    try {
      const result = await run(
        {
          type: 'hyperdrive.create',
          name: 'closed-stdin-db',
          binding: 'HYPERDRIVE',
          configPath: 'literal config.jsonc',
        },
        { accountId: 'acct', input: 'x'.repeat(2 * 1024 * 1024) },
      );
      expect(result.status).toBe(1);
      expect(result.signal).toBe('SIGKILL');
      expect(result.stderr).toMatch(/EPIPE|broken pipe/i);
      expect(result.stdout).toContain('"operationResult":1');
      expect(result.data).toBeUndefined();
      const pid = Number(readFileSync(pidFile, 'utf-8'));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      reapPidFile(pidFile);
    }
  }, 15_000);

  it('a provider exiting after reporting success rejects unread stdin', async () => {
    const script = join(POST_SPAWN_TMP, 'exited-stdin.cjs');
    const pidFile = join(POST_SPAWN_TMP, 'exited-stdin.pid');
    writeFileSync(
      script,
      `const fs = require('fs');\n` +
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `fs.writeSync(1, JSON.stringify({ operationResult: 1, data: { id: 'provider-id' } }));\n` +
        // Exit closes every inherited handle on Windows as well as POSIX. The
        // oversized unread input is still pending. Node may report a pipe
        // error or silently destroy stdin; neither can count as success.
        `process.exit(0);\n`,
    );
    let observedOutput = '';
    let childClosed = Promise.resolve();
    const run = createRunner({
      launcher: [process.execPath, script],
      timeoutMs: 30_000,
      onSpawnedChild: (child) => {
        child.stdout!.on('data', (chunk: string) => {
          observedOutput += chunk;
        });
        childClosed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      },
    });
    let result: Awaited<ReturnType<typeof run>> | undefined;
    let failure: unknown;
    try {
      result = await run(
        {
          type: 'hyperdrive.create',
          name: 'exited-stdin-db',
          binding: 'HYPERDRIVE',
          configPath: 'literal config.jsonc',
        },
        { accountId: 'acct', input: 'x'.repeat(2 * 1024 * 1024) },
      );
    } catch (error) {
      failure = error;
    }
    if (failure !== undefined) {
      // macOS can return EPERM when signalling an already-exiting process group.
      // The runner must quarantine that unconfirmed group, never trust its output.
      expect(failure).toBeInstanceOf(WranglerQuarantineError);
      expect((failure as Error).message).toMatch(
        /post-spawn child error \(.*EPIPE.*\).*failed process-group kill/s,
      );
    } else {
      expect(result!.status).toBe(1);
      // The stdin error owns termination even if exit 0 is concurrently observed.
      expect(result!.signal).toBe('SIGKILL');
      expect(result!.stderr).toMatch(/write EOF|EPIPE|broken pipe|closed stdin before/i);
      expect(result!.stdout).toContain('"operationResult":1');
      expect(result!.data).toBeUndefined();
    }
    expect(observedOutput).toContain('"operationResult":1');
    await childClosed;
    const pid = Number(readFileSync(pidFile, 'utf-8'));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);

  it('rejects success when stdin closes without finishing or emitting an error', async () => {
    const script = join(POST_SPAWN_TMP, 'unfinished-stdin.cjs');
    writeFileSync(
      script,
      `process.stdout.write(JSON.stringify({ operationResult: 1, data: { id: 'provider-id' } }));\n`,
    );
    let stdinErrors = 0;
    const run = createRunner({
      launcher: [process.execPath, script],
      onSpawnedChild: (child) => {
        child.stdin!.on('error', () => stdinErrors++);
        // Node destroys stdin when the child exits. A destroyed Writable need
        // not emit an error, even when its input was never flushed.
        child.stdin!.destroy();
      },
    });
    const result = await run(
      {
        type: 'hyperdrive.create',
        name: 'unfinished-stdin',
        binding: 'HYPERDRIVE',
        configPath: 'config.jsonc',
      },
      { accountId: 'acct', input: 'unread input' },
    );
    expect(stdinErrors).toBe(0);
    expect(result.status).toBe(1);
    expect(result.data).toBeUndefined();
    expect(result.stderr).toContain('stdin');
  });

  it('accepts success after the provider reads all stdin', async () => {
    const script = join(POST_SPAWN_TMP, 'finished-stdin.cjs');
    writeFileSync(
      script,
      `let length = 0;\n` +
        `process.stdin.on('data', chunk => { length += chunk.length; });\n` +
        `process.stdin.on('end', () => process.stdout.write(JSON.stringify({ operationResult: 1, data: { length } })));\n`,
    );
    const run = createRunner({ launcher: [process.execPath, script] });
    const input = 'x'.repeat(2 * 1024 * 1024);
    const result = await run(
      {
        type: 'hyperdrive.create',
        name: 'finished-stdin',
        binding: 'HYPERDRIVE',
        configPath: 'config.jsonc',
      },
      { accountId: 'acct', input },
    );
    expect(result.status).toBe(0);
    expect(result.data).toEqual({ length: input.length });
  });

  it('a stdin Writable error rejects buffered success only after the child is confirmed dead', async () => {
    const script = join(POST_SPAWN_TMP, 'stdin-error.cjs');
    const pidFile = join(POST_SPAWN_TMP, 'stdin-error.pid');
    writeFileSync(
      script,
      `const fs = require('fs');\n` +
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `fs.writeSync(1, JSON.stringify({ operationResult: 1, data: { id: 'provider-id' } }));\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const run = createRunner({
      launcher: [process.execPath, script],
      timeoutMs: 30_000,
      onSpawnedChild: (child) => {
        child.stdout!.once('data', () => {
          // Drive Node's real Writable error event after the runner buffered success.
          // This separately covers the error path regardless of platform pipe behavior.
          child.stdin!.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        });
      },
    });
    const result = await run(
      {
        type: 'hyperdrive.create',
        name: 'stdin-error-db',
        binding: 'HYPERDRIVE',
        configPath: 'literal config.jsonc',
      },
      { accountId: 'acct', input: 'x'.repeat(2 * 1024 * 1024) },
    );
    expect(result.status).toBe(1);
    expect(result.signal).toBe('SIGKILL');
    expect(result.stderr).toContain('write EPIPE');
    expect(result.stdout).toContain('"operationResult":1');
    expect(result.data).toBeUndefined();
    const pid = Number(readFileSync(pidFile, 'utf-8'));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);

  it('an injected POST-spawn `error` routes through the termination machine: the group is DEAD before the promise settles', async () => {
    const pidFile = join(POST_SPAWN_TMP, 'child.pid');
    const hang = join(POST_SPAWN_TMP, 'hang.cjs');
    writeHangScript(hang);
    const run = createRunner({
      launcher: [process.execPath, hang, pidFile],
      timeoutMs: 30_000,
      onSpawnedChild: (child) => {
        injectErrorAfterChildStarts(child, pidFile, 'injected kill-delivery failure');
      },
    });
    const result = await run({ type: 'd1.list' }, { accountId: 'acct' });
    expect(result.status).toBe(1);
    expect(result.signal).toBe('SIGKILL');
    expect(result.stderr).toContain('injected kill-delivery failure');
    // The hung child was reaped before the promise settled.
    const pid = Number(readFileSync(pidFile, 'utf-8'));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    reapPidFile(pidFile); // never leak on assertion failure
    expect(alive).toBe(false);
  }, 15_000);

  it('a POST-spawn `error` + a FAILED group kill QUARANTINES (rejects; the caller retains the lock)', async () => {
    const pidFile = join(POST_SPAWN_TMP, 'child2.pid');
    const hang = join(POST_SPAWN_TMP, 'hang2.cjs');
    writeHangScript(hang);
    const run = createRunner({
      launcher: [process.execPath, hang, pidFile],
      timeoutMs: 30_000,
      killProcessGroup: () => {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      },
      onSpawnedChild: (child) => {
        injectErrorAfterChildStarts(child, pidFile, 'injected post-spawn failure');
      },
    });
    let thrown: unknown;
    try {
      await run({ type: 'd1.list' }, { accountId: 'acct' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WranglerQuarantineError);
    expect((thrown as Error).message).toMatch(
      /post-spawn child error \(injected post-spawn failure\).*could not be signalled|post-spawn child error \(injected post-spawn failure\).*failed process-group kill/s,
    );
    // The child is still alive; reap it and confirm it is gone.
    const pid = reapPidFile(pidFile);
    expect(pid).toBeDefined();
    expect(await waitForDead(pid!, 5_000)).toBe(true);
  }, 15_000);
});
