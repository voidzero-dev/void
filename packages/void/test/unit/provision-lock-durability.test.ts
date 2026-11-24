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
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { packageFixturePath } from '../../../../test/fixture-dir.ts';
import { acquireProvisionLock, WranglerQuarantineError } from '../../src/cli/provision.ts';
import type { RunWrangler } from '../../src/cli/provision.ts';
import {
  emptyDesired,
  makeRunner,
  ok,
  provisionCloudflareResources,
  provisionOperationFixture,
  reap,
  silentLog,
  spawnHang,
  setupProvisionTestDir,
  waitForDead,
} from './provision-fixtures.ts';

const { tmpDir, wranglerPath, setup } = setupProvisionTestDir('lock-durability');

describe('acquireProvisionLock — durable sidecar is a PRECONDITION for quarantine', () => {
  const sidecar = `${wranglerPath}.void-provision.lock.quarantine.json`;
  const lockMutex = `${wranglerPath}.void-provision.lock.lock`;
  // A directory at the sidecar's temp path makes the durable write fail with no sidecar.
  const tmpBlocker = `${sidecar}.tmp-${process.pid}`;

  // The retention watchdog frees the process-wide provision slot a microtask after the
  // mutex is gone. Poll a throwaway provision until it gets past the slot guard, so the
  // next test does not trip on a watchdog that is still resolving.
  async function drainRetentionWatchdog(timeoutMs = 20_000): Promise<void> {
    const probeDir = packageFixturePath(import.meta.dirname, '.tmp-provision-drain');
    const probeCfg = join(probeDir, 'wrangler.jsonc');
    const deadline = Date.now() + timeoutMs;
    try {
      for (;;) {
        rmSync(probeDir, { recursive: true, force: true });
        mkdirSync(probeDir, { recursive: true });
        writeFileSync(probeCfg, JSON.stringify({ account_id: 'acct', name: 'drain' }));
        let guardHeld = false;
        try {
          await provisionCloudflareResources(probeDir, probeCfg, emptyDesired, {
            runWrangler: provisionOperationFixture(() => ok('[]')),
            log: silentLog,
          });
        } catch (error) {
          // Only the slot-guard error means the watchdog is still active.
          guardHeld = /still retaining its lock|already active in this process/.test(
            (error as Error).message,
          );
        }
        if (!guardHeld) {
          return;
        }
        if (Date.now() >= deadline) {
          throw new Error('retention watchdog did not resolve within the drain window');
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  }

  afterEach(async () => {
    await drainRetentionWatchdog();
  });

  it('a sidecar-write failure keeps the lock TRACKED (heartbeat running, NOT stealable) and throws a hard error', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const lock = await acquireProvisionLock(wranglerPath, { stale: 2000 });
    try {
      mkdirSync(tmpBlocker);
      expect(() => lock.quarantine({ pid: 99_999, reason: 'sidecar blocked' })).toThrow(
        /intentionally STILL HELD/,
      );
      expect(existsSync(sidecar)).toBe(false);
      // The lock stays tracked, so its heartbeat keeps it fresh past proper-lockfile's
      // 2000ms stale floor.
      await new Promise((r) => setTimeout(r, 2300));
      await expect(acquireProvisionLock(wranglerPath, { stale: 2000, retries: 0 })).rejects.toThrow(
        /already being held/,
      );
    } finally {
      rmSync(tmpBlocker, { recursive: true, force: true });
      // Still tracked → release works normally and frees the mutex.
      await lock.release();
    }
    expect(existsSync(lockMutex)).toBe(false);
  }, 15_000);

  it('provision level: a persistence failure surfaces BOTH errors, arms the retention watchdog, and resolves by confirming the child DEAD (mutex released cleanly)', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    // A real child that is already dead stands in for the unconfirmed wrangler group.
    const child = spawnHang();
    const childPid = child.pid!;
    reap(child);
    expect(await waitForDead(childPid, 10_000)).toBe(true);
    const quarantineError = new WranglerQuarantineError(childPid, 'child unconfirmed');
    const run: RunWrangler = provisionOperationFixture(() => Promise.reject(quarantineError));
    let thrown: unknown;
    try {
      await provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        {
          runWrangler: run,
          log: silentLog,
          lockOptions: {
            stale: 2000,
            // Every persistence attempt fails, so only the death probe can resolve it.
            dirDurability: {
              fsyncSync: () => {
                throw Object.assign(new Error('ENOSPC: no space left on device, fsync'), {
                  code: 'ENOSPC',
                });
              },
            },
          },
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).message).toMatch(/intentionally still held/);
    expect((thrown as AggregateError).errors[0]).toBe(quarantineError);
    expect(String((thrown as AggregateError).errors[1])).toMatch(/could not persist/);
    expect(existsSync(lockMutex)).toBe(true);
    expect(existsSync(sidecar)).toBe(false);
    // The watchdog confirms the recorded group dead and releases the mutex. The bound is
    // generous because its tick is a real timer.
    const deadline = Date.now() + 15_000;
    while (existsSync(lockMutex) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(lockMutex)).toBe(false);
    expect(existsSync(sidecar)).toBe(false);
    await drainRetentionWatchdog();
    const { run: okRun } = makeRunner([{ match: /^d1 list/, reply: () => ok('[]') }]);
    await expect(
      provisionCloudflareResources(tmpDir, wranglerPath, emptyDesired, {
        runWrangler: okRun,
        log: silentLog,
      }),
    ).resolves.toBeDefined();
  }, 30_000);

  it('while the child LIVES, the watchdog retries persistence with backoff and detaches once it succeeds', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const live = spawnHang();
    let failPersistence = true;
    const quarantineError = new WranglerQuarantineError(live.pid, 'live child');
    const run: RunWrangler = provisionOperationFixture(() => Promise.reject(quarantineError));
    try {
      let thrown: unknown;
      try {
        await provisionCloudflareResources(
          tmpDir,
          wranglerPath,
          { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
          {
            runWrangler: run,
            log: silentLog,
            lockOptions: {
              stale: 2000,
              dirDurability: {
                fsyncSync: () => {
                  if (failPersistence) {
                    throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
                  }
                },
              },
            },
          },
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AggregateError);
      expect(existsSync(lockMutex)).toBe(true);
      expect(existsSync(sidecar)).toBe(false);
      // Once persistence works, the watchdog's next retry writes the sidecar and detaches
      // the lock. The bound is generous because the retry is a real backoff timer.
      failPersistence = false;
      const deadline = Date.now() + 15_000;
      while (!existsSync(sidecar) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(existsSync(sidecar)).toBe(true);
      const recorded = JSON.parse(readFileSync(sidecar, 'utf8')) as Record<string, unknown>;
      expect(recorded.pid).toBe(live.pid);
      expect(existsSync(lockMutex)).toBe(true); // retained, now safely detached
      // The retained mutex is guarded by the sidecar: an acquirer fails closed on the
      // live recorded group even with the mutex aged stale.
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(lockMutex, old, old);
      await expect(acquireProvisionLock(wranglerPath, { stale: 2000, retries: 0 })).rejects.toThrow(
        /QUARANTINED/,
      );
    } finally {
      reap(live);
      rmSync(lockMutex, { recursive: true, force: true });
      rmSync(sidecar, { force: true });
    }
  }, 30_000);

  it('the watchdog HOLDS the process at natural exit until the child dies, then releases and exits cleanly', async () => {
    // proper-lockfile's exit sweep removes every tracked mutex, so the watchdog must keep
    // the process alive until the child is confirmed dead.
    const WATCHDOG_EXIT_TMP = packageFixturePath(import.meta.dirname, '.tmp-watchdog-exit');
    rmSync(WATCHDOG_EXIT_TMP, { recursive: true, force: true });
    mkdirSync(WATCHDOG_EXIT_TMP, { recursive: true });
    const appRoot = join(WATCHDOG_EXIT_TMP, 'app');
    const probe = join(WATCHDOG_EXIT_TMP, 'probe.mjs');
    const provisionUrl = `file://${join(import.meta.dirname, '../../src/cli/provision.ts')}`;
    writeFileSync(
      probe,
      `import { mkdirSync, writeFileSync } from 'node:fs';\n` +
        `import { spawn } from 'node:child_process';\n` +
        `import { join } from 'node:path';\n` +
        `import { provisionCloudflareResources, WranglerQuarantineError } from ${JSON.stringify(provisionUrl)};\n` +
        `const root = ${JSON.stringify(appRoot)};\n` +
        `mkdirSync(root, { recursive: true });\n` +
        `const cfg = join(root, 'wrangler.jsonc');\n` +
        `writeFileSync(cfg, JSON.stringify({ name: 'app', account_id: 'acct' }));\n` +
        // A real detached child standing in for the unconfirmed wrangler group; it
        // exits BY ITSELF after 700ms.
        `const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 700)'], { detached: true, stdio: 'ignore' });\n` +
        `child.unref();\n` +
        `const startedAt = Date.now();\n` +
        `provisionCloudflareResources(root, cfg, { kvNamespaces: [], queues: [], d1: { binding: 'DB', name: 'myapp-db' } }, {\n` +
        `  runWrangler: () => Promise.reject(new WranglerQuarantineError(child.pid, 'unconfirmed')),\n` +
        `  log: { info: () => {}, warn: () => {} },\n` +
        `  lockOptions: {\n` +
        `    dirDurability: { fsyncSync: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } },\n` +
        `  },\n` +
        `}).then(\n` +
        `  () => writeFileSync(join(root, 'outcome.txt'), 'RESOLVED'),\n` +
        `  () => writeFileSync(join(root, 'outcome.txt'), 'REJECTED:' + (Date.now() - startedAt)),\n` +
        `);\n` +
        `process.on('exit', () => {\n` +
        `  let childAlive = true;\n` +
        `  try { process.kill(child.pid, 0); } catch { childAlive = false; }\n` +
        `  writeFileSync(join(root, 'exit.txt'), JSON.stringify({ elapsed: Date.now() - startedAt, childAlive }));\n` +
        `});\n`,
    );
    const { spawn } = await import('node:child_process');
    const parent = spawn(process.execPath, [probe], {
      cwd: WATCHDOG_EXIT_TMP,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    parent.stderr.setEncoding('utf8');
    parent.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const killTimer = setTimeout(() => parent.kill('SIGKILL'), 15_000);
    try {
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((res) => {
        parent.on('close', (c, s) => res([c, s]));
      });
      clearTimeout(killTimer);
      expect(signal).toBeNull();
      expect(code).toBe(0);
      expect(readFileSync(join(appRoot, 'outcome.txt'), 'utf8')).toContain('REJECTED:');
      // The watchdog held the process open past the child's 700ms lifetime.
      const exitState = JSON.parse(readFileSync(join(appRoot, 'exit.txt'), 'utf8')) as {
        elapsed: number;
        childAlive: boolean;
      };
      expect(exitState.childAlive).toBe(false);
      expect(exitState.elapsed).toBeGreaterThanOrEqual(650);
      expect(stderr).toMatch(/RETAINED by this process/);
      const cfgReal = realpathSync(join(appRoot, 'wrangler.jsonc'));
      expect(existsSync(`${cfgReal}.void-provision.lock.lock`)).toBe(false);
      expect(existsSync(`${cfgReal}.void-provision.lock.quarantine.json`)).toBe(false);
    } finally {
      clearTimeout(killTimer);
      try {
        parent.kill('SIGKILL');
      } catch {
        // already gone
      }
      rmSync(WATCHDOG_EXIT_TMP, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('acquireProvisionLock — sidecar DIRECTORY durability failures propagate', () => {
  const sidecar = `${wranglerPath}.void-provision.lock.quarantine.json`;
  const lockMutex = `${wranglerPath}.void-provision.lock.lock`;

  it('ENOSPC on the directory fsync is a PERSISTENCE FAILURE: no detach, lock stays tracked, hard error', async () => {
    // Without a durable directory entry the sidecar can vanish on a crash, so only
    // platform-unsupported codes may be ignored.
    setup(JSON.stringify({ name: 'app' }));
    const lock = await acquireProvisionLock(wranglerPath, {
      stale: 2000,
      dirDurability: {
        fsyncSync: () => {
          throw Object.assign(new Error('ENOSPC: no space left on device, fsync'), {
            code: 'ENOSPC',
          });
        },
      },
    });
    try {
      expect(() => lock.quarantine({ pid: 42_424, reason: 'enospc' })).toThrow(
        /could not persist quarantine metadata.*ENOSPC/s,
      );
      // The non-durable sidecar was rolled back.
      expect(existsSync(sidecar)).toBe(false);
      // The lock stays tracked, so its heartbeat keeps it fresh past the 2000ms stale floor.
      await new Promise((r) => setTimeout(r, 2300));
      await expect(acquireProvisionLock(wranglerPath, { stale: 2000, retries: 0 })).rejects.toThrow(
        /already being held/,
      );
    } finally {
      // Still tracked → release works normally and frees the mutex.
      await lock.release();
    }
    expect(existsSync(lockMutex)).toBe(false);
  }, 15_000);

  it('a platform-unsupported code (EINVAL) is ignored — the quarantine still detaches behind the verified sidecar', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const lock = await acquireProvisionLock(wranglerPath, {
      stale: 2000,
      dirDurability: {
        fsyncSync: () => {
          throw Object.assign(new Error('EINVAL: invalid argument, fsync'), { code: 'EINVAL' });
        },
      },
    });
    lock.quarantine({ pid: 42_425, reason: 'einval' }); // must not throw
    expect(existsSync(sidecar)).toBe(true);
    expect(existsSync(lockMutex)).toBe(true); // retained (detached from the exit sweep)
    await lock.release(); // no-op after a successful quarantine
    expect(existsSync(lockMutex)).toBe(true);
    rmSync(lockMutex, { recursive: true, force: true });
    rmSync(sidecar, { force: true });
  });
});
