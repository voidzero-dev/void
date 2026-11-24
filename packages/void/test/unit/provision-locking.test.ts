import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { acquireProvisionLock, WranglerQuarantineError } from '../../src/cli/provision.ts';
import type { RunWrangler } from '../../src/cli/provision.ts';
import {
  emptyDesired,
  fail,
  hex32,
  isCall,
  makeRunner,
  ok,
  passthruFs,
  provisionCloudflareResources,
  provisionOperationFixture,
  silentLog,
  setupProvisionTestDir,
} from './provision-fixtures.ts';

const { tmpDir, wranglerPath, setup, simulateUpdateConfig } = setupProvisionTestDir('locking');

describe('provisionCloudflareResources — whole-provision cross-process lock (proper-lockfile)', () => {
  // proper-lockfile uses a synthetic adjacent identity without creating that pathname;
  // the actual mutex is a `${target}.lock` DIRECTORY and is removed on release.
  const lockTarget = `${wranglerPath}.void-provision.lock`;
  const recoveryTarget = `${lockTarget}.recovery`;
  const lockMutex = `${lockTarget}.lock`;
  const recoveryMutex = `${recoveryTarget}.lock`;
  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  it('a SECOND in-process provision fails fast with a clear hard error (at most one per process)', async () => {
    setup(
      JSON.stringify({ account_id: 'acct', hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }] }),
    );
    let createCalls = 0;
    const run: RunWrangler = provisionOperationFixture((args) => {
      if (isCall(args, 'hyperdrive', 'create')) {
        createCalls++;
        simulateUpdateConfig('hyperdrive', { binding: 'HYPERDRIVE', id: hex32('hd-1') });
        return ok();
      }
      return ok();
    });
    const desired = {
      ...emptyDesired,
      hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
    };
    const opts = {
      runWrangler: run,
      log: silentLog,
      // Keep the first provision ACTIVE long enough that the second demonstrably starts
      // while it runs (the guard is taken synchronously at entry regardless).
      listHyperdriveConfigs: async (): Promise<Array<never>> => {
        await delay(60);
        return [];
      },
    };
    const first = provisionCloudflareResources(tmpDir, wranglerPath, desired, opts);
    // The second provision starts while the first is active → the process-wide guard
    // rejects it OUTRIGHT (no lock contention, no wrangler work, no config read).
    await expect(provisionCloudflareResources(tmpDir, wranglerPath, desired, opts)).rejects.toThrow(
      /a provision is already active in this process.*run provisions sequentially/s,
    );
    const result = await first;
    expect(result.resources.find((r) => r.kind === 'hyperdrive')?.action).toBe('created');
    expect(createCalls).toBe(1);
    // Mutex always released — no leak; and the slot freed: a THIRD (sequential) run works.
    expect(existsSync(lockMutex)).toBe(false);
    const third = await provisionCloudflareResources(tmpDir, wranglerPath, desired, opts);
    expect(third.resources.find((r) => r.kind === 'hyperdrive')?.action).toBe('reused');
    expect(createCalls).toBe(1);
  });

  it('leaves no persistent marker files and lets different app configs lock concurrently', async () => {
    setup(JSON.stringify({ name: 'app-a' }));
    const otherDir = join(tmpDir, 'other-app');
    const otherConfig = join(otherDir, 'wrangler.jsonc');
    const otherLockTarget = `${otherConfig}.void-provision.lock`;
    const otherRecoveryTarget = `${otherLockTarget}.recovery`;
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(otherConfig, JSON.stringify({ name: 'app-b' }));

    const first = await acquireProvisionLock(wranglerPath, { retries: 0 });
    const second = await acquireProvisionLock(otherConfig, { retries: 0 });
    try {
      // Both are held at once: lock identity is per canonical config, not machine-global.
      expect(existsSync(lockMutex)).toBe(true);
      expect(existsSync(`${otherLockTarget}.lock`)).toBe(true);
      // Synthetic identities never materialize as empty files in either project.
      expect(existsSync(lockTarget)).toBe(false);
      expect(existsSync(recoveryTarget)).toBe(false);
      expect(existsSync(otherLockTarget)).toBe(false);
      expect(existsSync(otherRecoveryTarget)).toBe(false);
    } finally {
      await Promise.all([first.release(), second.release()]);
    }

    expect(existsSync(lockMutex)).toBe(false);
    expect(existsSync(recoveryMutex)).toBe(false);
    expect(existsSync(`${otherLockTarget}.lock`)).toBe(false);
    expect(existsSync(`${otherRecoveryTarget}.lock`)).toBe(false);
  });

  it('two concurrent provisions in SEPARATE processes race — exactly ONE create, the other reuses, mutex released', async () => {
    // One provision runs per process, so a race needs two real processes.
    setup(
      JSON.stringify({ account_id: 'acct', hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }] }),
    );
    const probe = join(tmpDir, 'race-probe.mjs');
    const provisionUrl = `file://${join(import.meta.dirname, '../../src/cli/provision.ts')}`;
    writeFileSync(
      probe,
      `import { readFileSync, writeFileSync } from 'node:fs';\n` +
        `import { provisionCloudflareResources } from ${JSON.stringify(provisionUrl)};\n` +
        `const cfgPath = ${JSON.stringify(wranglerPath)};\n` +
        `const run = (args) => {\n` +
        `  if (args.type === 'hyperdrive.create') {\n` +
        `    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));\n` +
        `    cfg.hyperdrive = [{ binding: 'HYPERDRIVE', id: process.argv[2] }];\n` +
        `    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));\n` +
        `  }\n` +
        `  return { stdout: '', stderr: '', status: 0 };\n` +
        `};\n` +
        `provisionCloudflareResources(${JSON.stringify(tmpDir)}, cfgPath, {\n` +
        `  kvNamespaces: [],\n` +
        `  queues: [],\n` +
        `  hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },\n` +
        `}, {\n` +
        `  runWrangler: run,\n` +
        `  log: { info: () => {}, warn: () => {} },\n` +
        `  // Barrier: the winner holds the lock while LISTING, so the loser must block\n` +
        `  // on the on-disk lock (proving the LOCK, not sequencing, serializes them).\n` +
        `  listHyperdriveConfigs: () => new Promise((r) => setTimeout(() => r([]), 300)),\n` +
        `}).then(\n` +
        `  (res) => console.log('ACTION:' + res.resources.find((r) => r.kind === 'hyperdrive').action),\n` +
        `  (err) => { console.log('REJECTED:' + err.message); process.exitCode = 7; },\n` +
        `);\n`,
    );
    const { spawn } = await import('node:child_process');
    const runChild = (id: string): Promise<{ code: number | null; stdout: string }> =>
      new Promise((res) => {
        const child = spawn(process.execPath, [probe, hex32(id)], {
          cwd: tmpDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.on('close', (code) => res({ code, stdout }));
      });
    const [a, b] = await Promise.all([runChild('hd-a'), runChild('hd-b')]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    const actions = [a.stdout, b.stdout].map((s) => s.match(/ACTION:(\w+)/)?.[1]).sort();
    // Exactly one create; the loser's read-first (under the lock) reused the winner's id.
    expect(actions).toEqual(['created', 'reused']);
    // Mutex always released — no leak.
    expect(existsSync(lockMutex)).toBe(false);
  }, 30_000);

  it('recovers a STALE/abandoned lock (old mtime, crashed owner) and proceeds', async () => {
    setup(
      JSON.stringify({ account_id: 'acct', hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }] }),
    );
    // Simulate a crashed owner's abandoned mutex dir whose mtime is well past the 120s
    // stale window, so proper-lockfile compromises + steals it.
    mkdirSync(lockMutex);
    const old = new Date(Date.now() - 300_000);
    utimesSync(lockMutex, old, old);
    const { run } = makeRunner([
      {
        match: /^hyperdrive create /,
        reply: () => {
          simulateUpdateConfig('hyperdrive', { binding: 'HYPERDRIVE', id: hex32('hd-real') });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
      },
      { runWrangler: run, log: silentLog, listHyperdriveConfigs: async () => [] },
    );
    expect(result.resources.find((r) => r.kind === 'hyperdrive')?.action).toBe('created');
    expect(existsSync(lockMutex)).toBe(false);
  });

  it('always releases the lock even when the provision THROWS (no leak)', async () => {
    setup(
      JSON.stringify({ account_id: 'acct', hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }] }),
    );
    const { run } = makeRunner([{ match: /^hyperdrive create /, reply: () => fail('', 'boom') }]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
        },
        { runWrangler: run, log: silentLog, listHyperdriveConfigs: async () => [] },
      ),
    ).rejects.toThrow(/hyperdrive create myapp-hd.*failed/s);
    expect(existsSync(lockMutex)).toBe(false);
  });

  it('acquireProvisionLock serializes — a second acquire waits until the first releases, then proceeds; release always frees it', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const first = await acquireProvisionLock(wranglerPath);
    expect(existsSync(lockMutex)).toBe(true);
    let secondAcquired = false;
    const secondPromise = acquireProvisionLock(wranglerPath).then((lock) => {
      secondAcquired = true;
      return lock;
    });
    // While the first holds the lock the second cannot acquire (it retries/blocks).
    await delay(60);
    expect(secondAcquired).toBe(false);
    await first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    // Release is idempotent and always frees the mutex.
    await second.release();
    await second.release();
    expect(existsSync(lockMutex)).toBe(false);
  });

  it('a provision via a SYMLINK ALIAS contends on the SAME canonical lock and reuses the id written via the real path', async () => {
    // Without realpath canonicalization each lexical path would get its own mutex,
    // and an alias provision could create a duplicate.
    setup(
      JSON.stringify({ account_id: 'acct', hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }] }),
    );
    const aliasName = 'wrangler.alias.jsonc';
    symlinkSync(wranglerPath, join(tmpDir, aliasName));
    // Sanity: the alias and the real config canonicalize to the same real file.
    expect(realpathSync(join(tmpDir, aliasName))).toBe(realpathSync(wranglerPath));
    let createCalls = 0;
    const run: RunWrangler = provisionOperationFixture((args) => {
      if (isCall(args, 'hyperdrive', 'create')) {
        createCalls++;
        simulateUpdateConfig('hyperdrive', {
          binding: 'HYPERDRIVE',
          id: hex32('hd-' + createCalls),
        });
        return ok();
      }
      return ok();
    });
    const makeProv = (
      configArg: string,
      retries?: number,
    ): Promise<{ resources: Array<{ kind: string; action: string }> }> =>
      provisionCloudflareResources(
        tmpDir,
        configArg,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
        },
        {
          runWrangler: run,
          log: silentLog,
          listHyperdriveConfigs: async () => [],
          ...(retries !== undefined ? { lockOptions: { retries } } : {}),
        },
      );
    // While the canonical lock is held, an alias-path provision cannot acquire it.
    const held = await acquireProvisionLock(realpathSync(wranglerPath));
    await expect(makeProv(aliasName, 0)).rejects.toThrow(/already being held/);
    await held.release();
    // One underlying file: a create via the REAL path is read-first-REUSED via the alias.
    const a = await makeProv(wranglerPath);
    const b = await makeProv(aliasName);
    expect(a.resources.find((r) => r.kind === 'hyperdrive')?.action).toBe('created');
    expect(b.resources.find((r) => r.kind === 'hyperdrive')?.action).toBe('reused');
    expect(createCalls).toBe(1);
    // The single canonical mutex was released.
    expect(existsSync(`${realpathSync(wranglerPath)}.void-provision.lock.lock`)).toBe(false);
  });

  it('a wrangler call blocking past a SHORT stale window does NOT let a second process steal the mutex (async heartbeat keeps it fresh)', async () => {
    setup(JSON.stringify({ account_id: 'acct', kv_namespaces: [{ binding: 'KV', id: 'local' }] }));
    const run: RunWrangler = provisionOperationFixture(async (args) => {
      if (isCall(args, 'kv', 'namespace', 'list')) {
        // blocks (async) longer than the probe below, which is past the 2s stale window
        await delay(2400);
        return ok(JSON.stringify([{ id: hex32('kv'), title: 'myapp-kv' }]));
      }
      return ok();
    });
    const prov = provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
      { runWrangler: run, log: silentLog, lockOptions: { stale: 2000, update: 1000, retries: 0 } },
    );
    // 2.2s into the block — PAST the 2s stale window (proper-lockfile floors stale at 2000
    // and update at 1000, so 2.2s is the minimum that proves freshness). If the async
    // heartbeat did not keep the mutex fresh, a retries:0 acquire would STEAL it; it must
    // be REFUSED instead.
    await delay(2200);
    await expect(acquireProvisionLock(wranglerPath, { stale: 2000, retries: 0 })).rejects.toThrow();
    const result = await prov;
    expect(result.resources[0]).toMatchObject({ kind: 'kv', action: 'adopted', id: hex32('kv') });
    expect(existsSync(lockMutex)).toBe(false);
  }, 15_000);

  it('a genuine unlock failure REJECTS the provision (leaked mutex surfaced, not swallowed)', async () => {
    setup(JSON.stringify({ account_id: 'acct' }));
    const failingFs = {
      ...passthruFs,
      rmdir: (_p: string, cb: (e: Error | null) => void) =>
        cb(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })),
    };
    await expect(
      provisionCloudflareResources(tmpDir, wranglerPath, emptyDesired, {
        log: silentLog,
        lockOptions: { fs: failingFs },
      }),
    ).rejects.toThrow(/failed to release the cross-process provision lock/);
  });

  it('a body failure COMBINED with an unlock failure surfaces BOTH (AggregateError)', async () => {
    setup(
      JSON.stringify({ account_id: 'acct', hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }] }),
    );
    // rmdir fails → the mutex leaks on release; the body also fails (hyperdrive create).
    const failingFs = {
      ...passthruFs,
      rmdir: (_p: string, cb: (e: Error | null) => void) =>
        cb(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })),
    };
    const { run } = makeRunner([
      { match: /^hyperdrive create /, reply: () => fail('', 'boom-body') },
    ]);
    let caught: unknown;
    try {
      await provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
        },
        {
          runWrangler: run,
          log: silentLog,
          listHyperdriveConfigs: async () => [],
          lockOptions: { fs: failingFs },
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    const agg = caught as AggregateError;
    const messages = agg.errors
      .map((e) => (e instanceof Error ? e.message : String(e)))
      .join(' || ');
    // BOTH the body (hyperdrive create) error AND the leaked-mutex release error surface.
    expect(messages).toMatch(/hyperdrive create myapp-hd.*failed.*boom-body/s);
    expect(messages).toMatch(/failed to release the cross-process provision lock/);
    // The primary body error is also preserved as `cause` for cause-walking loggers.
    expect((agg.cause as Error).message).toMatch(/hyperdrive create/);
  });
});

describe('provisionCloudflareResources — quarantine retains the whole-provision lock', () => {
  const lockMutex = `${wranglerPath}.void-provision.lock.lock`;

  it('a quarantine rejection RETAINS the mutex (not released) and surfaces the quarantine error', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    // A runner whose child could not be confirmed dead — the default runner rejects
    // with a quarantine error in that state; injecting the same rejection exercises the
    // provision-level contract: NO release, mutex retained, error surfaced verbatim.
    const quarantineError = new WranglerQuarantineError(43_210, 'test: child unconfirmed');
    const run: RunWrangler = provisionOperationFixture(() => Promise.reject(quarantineError));
    let thrown: unknown;
    try {
      await provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(quarantineError);
    expect((thrown as Error).message).toMatch(/pid 43210/);
    expect((thrown as Error).message).toMatch(/intentionally RETAINED/);
    // The lock is not released while the wrangler child may still be alive.
    expect(existsSync(lockMutex)).toBe(true);
    // Later acquisitions gate on the recorded group instead of stealing the lock by age.
    const sidecar = `${wranglerPath}.void-provision.lock.quarantine.json`;
    expect(existsSync(sidecar)).toBe(true);
    const recorded = JSON.parse(readFileSync(sidecar, 'utf8')) as Record<string, unknown>;
    expect(recorded.pid).toBe(43_210);
    expect(String(recorded.reason)).toMatch(/pid 43210/);
    // quarantine() detached the lock from proper-lockfile, so removing it fires no callback.
    rmSync(lockMutex, { recursive: true, force: true });
    rmSync(sidecar, { force: true });
  });
});

describe('provisionCloudflareResources — dangling-symlink lock identity', () => {
  it('provisions via dangling-symlink aliases to the SAME not-yet-created target share ONE lock identity (one create)', async () => {
    // Two dangling symlinks point at the same not-yet-created config. Each must resolve to
    // the target's lock, not its own lexical path.
    const sharedDir = join(tmpDir, 'shared');
    mkdirSync(sharedDir, { recursive: true });
    const target = join(sharedDir, 'wrangler.jsonc'); // NOT created yet — dangling
    const aliasA = join(tmpDir, 'aliasA.jsonc');
    const aliasB = join(tmpDir, 'aliasB.jsonc');
    symlinkSync(target, aliasA);
    symlinkSync(target, aliasB);
    expect(existsSync(target)).toBe(false); // both aliases are dangling at start

    let createCalls = 0;
    const run: RunWrangler = provisionOperationFixture((args) => {
      if (isCall(args, 'hyperdrive', 'create')) {
        createCalls++;
        // --update-config writes to the CANONICAL target (both aliases resolve to it).
        simulateUpdateConfig(
          'hyperdrive',
          { binding: 'HYPERDRIVE', id: hex32('hd-' + createCalls) },
          target,
        );
        return ok();
      }
      return ok();
    });
    const makeProv = (
      aliasPath: string,
      retries?: number,
    ): Promise<{ resources: Array<{ kind: string; action: string }> }> =>
      provisionCloudflareResources(
        tmpDir,
        aliasPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
        },
        {
          runWrangler: run,
          log: silentLog,
          listHyperdriveConfigs: async () => [],
          ...(retries !== undefined ? { lockOptions: { retries } } : {}),
        },
      );
    // While the real-target lock is held, a dangling-alias provision cannot acquire it.
    const canonicalTarget = join(realpathSync(sharedDir), 'wrangler.jsonc');
    const held = await acquireProvisionLock(canonicalTarget);
    await expect(makeProv(aliasA, 0)).rejects.toThrow(/already being held/);
    await held.release();
    // One underlying (initially not-yet-created) file: a create via alias A is
    // read-first-REUSED via alias B.
    const a = await makeProv(aliasA);
    const b = await makeProv(aliasB);
    expect(a.resources.find((r) => r.kind === 'hyperdrive')?.action).toBe('created');
    expect(b.resources.find((r) => r.kind === 'hyperdrive')?.action).toBe('reused');
    expect(createCalls).toBe(1);
    // The ONE canonical mutex (keyed on the real target) is released.
    expect(existsSync(`${realpathSync(target)}.void-provision.lock.lock`)).toBe(false);
  }, 15_000);

  it('a non-ENOENT realpath error (a self-referential symlink cycle → ELOOP) SURFACES, not swallowed', async () => {
    // A symlink cycle makes realpath throw ELOOP, which must not fall back to the lexical path.
    mkdirSync(tmpDir, { recursive: true });
    const loop = join(tmpDir, 'loop.jsonc');
    symlinkSync(loop, loop);
    const { run } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        loop,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/ELOOP/);
  });
});
