import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  mkdir,
  mkdirSync,
  readFileSync,
  realpath,
  rmdir,
  rmdirSync,
  rmSync,
  stat,
  utimes,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parse as parseJsoncRaw } from 'jsonc-parser';
import { toSlash } from 'pathslash';
import { afterEach, beforeEach, vi } from 'vite-plus/test';
import { packageFixturePath } from '../../../../test/fixture-dir.ts';
import { operationFixture } from '../../../deploy-cloudflare/test/operation-fixture.ts';
import type {
  DesiredResourceSet,
  ProvisionLogger,
  RunWrangler,
  RunWranglerResult,
  WranglerCallContext,
} from '../../src/cli/provision.ts';

/** proper-lockfile's callback-style fs seam. Tests override single calls on top of it. */
export const passthruFs: {
  mkdir: typeof mkdir;
  stat: typeof stat;
  utimes: typeof utimes;
  rmdir: typeof rmdir;
  realpath: typeof realpath;
  rmdirSync: typeof rmdirSync;
} = { mkdir, stat, utimes, rmdir, realpath, rmdirSync };

/**
 * Remote work needs a resolvable account, as in a real deploy, so every test runs with this
 * ambient account. Tests of the no-account and mismatch paths stub it themselves.
 */
export const AMBIENT_ACCOUNT = 'ambient-test-account';

export interface ProvisionTestDir {
  tmpDir: string;
  wranglerPath: string;
  /** Recreate the project with `content` as its `wrangler.jsonc`. */
  setup: (content: string) => void;
  readConfig: () => Record<string, unknown>;
  /** Mimic `wrangler <res> create --update-config`: upsert a binding entry by binding. */
  simulateUpdateConfig: (field: string, entry: Record<string, unknown>, path?: string) => void;
}

/**
 * A temp project for one test file. Registers hooks that pin the ambient account before each
 * test and remove the project, env stubs and global stubs after it.
 */
export function setupProvisionTestDir(name: string): ProvisionTestDir {
  const tmpDir = packageFixturePath(import.meta.dirname, `.tmp-provision-test-${name}`);
  const wranglerPath = toSlash(join(tmpDir, 'wrangler.jsonc'));

  beforeEach(() => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', AMBIENT_ACCOUNT);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  return {
    tmpDir,
    wranglerPath,
    setup(content) {
      rmSync(tmpDir, { recursive: true, force: true });
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(wranglerPath, content);
    },
    readConfig() {
      return parseJsoncRaw(readFileSync(wranglerPath, 'utf8')) as Record<string, unknown>;
    },
    simulateUpdateConfig(field, entry, path = wranglerPath) {
      const cfg = parseJsoncRaw(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const list = Array.isArray(cfg[field]) ? (cfg[field] as Array<Record<string, unknown>>) : [];
      const index = list.findIndex((e) => e.binding === entry.binding);
      if (index >= 0) {
        list[index] = { ...list[index], ...entry };
      } else {
        list.push(entry);
      }
      cfg[field] = list;
      writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
    },
  };
}

/** The shared operation fixture, with the provision call context passed to `callback`. */
export function provisionOperationFixture(
  callback: (
    args: Array<string>,
    options: WranglerCallContext,
  ) => RunWranglerResult | Promise<RunWranglerResult>,
): RunWrangler {
  // The shared fixture forwards the runner's call context unchanged.
  return operationFixture((args, options) =>
    callback(args, options as unknown as WranglerCallContext),
  );
}

/** A logger that swallows output (the default one prints to console). */
export const silentLog: ProvisionLogger = { info: () => {}, warn: () => {} };

type Handler = { match: RegExp; reply: (sub: string) => RunWranglerResult };

/**
 * A runWrangler stub that records each operation as fixture argv. Handlers match on the
 * space-joined argv; unmatched operations succeed with empty output.
 */
export function makeRunner(handlers: Array<Handler>): {
  run: RunWrangler;
  calls: Array<Array<string>>;
} {
  const calls: Array<Array<string>> = [];
  const run: RunWrangler = provisionOperationFixture((args) => {
    calls.push(args);
    const sub = args.join(' ');
    for (const handler of handlers) {
      if (handler.match.test(sub)) {
        return handler.reply(sub);
      }
    }
    return { stdout: '', stderr: '', status: 0 };
  });
  return { run, calls };
}

/** Stub `fetch` with an empty Hyperdrive config list and record every requested URL. */
export function stubEmptyHyperdriveList(): Array<string> {
  const urls: Array<string> = [];
  vi.stubGlobal('fetch', async (url: string | URL) => {
    urls.push(String(url));
    return new Response(
      JSON.stringify({ success: true, result: [], result_info: { total_count: 0 } }),
      { status: 200 },
    );
  });
  return urls;
}

/** True when an argv array is a `wrangler <a> <b> …` invocation of a given kind. */
export function isCall(argv: Array<string>, ...prefix: Array<string>): boolean {
  return prefix.every((token, i) => argv[i] === token);
}

export function ok(stdout: string = ''): RunWranglerResult {
  return { stdout, stderr: '', status: 0 };
}

export function fail(stdout: string, stderr: string = ''): RunWranglerResult {
  return { stdout, stderr, status: 1 };
}

// Synthetic ids in the real formats: KV and Hyperdrive ids are 32 lowercase hex characters,
// D1 ids are UUIDs. Equal-length seeds keep their order, so tie-break tests stay valid.
export function hex32(seed: string): string {
  const raw = Buffer.from(seed, 'utf8').toString('hex').slice(0, 32);
  return (raw + '0'.repeat(32)).slice(0, 32);
}

export function uuid(seed: string): string {
  const h = hex32(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export const emptyDesired: DesiredResourceSet = { kvNamespaces: [], queues: [] };

export { provisionCloudflareResources } from '../../src/cli/provision.ts';

/** Poll until `pid` no longer exists, or `timeoutMs` passes. */
export async function waitForDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** A detached process group that hangs until killed. */
export function spawnHang(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
    detached: true,
    stdio: 'ignore',
  });
}

/** SIGKILL the child's process group, or the child alone where groups are unsupported. */
export function reap(child: ChildProcess): void {
  try {
    process.kill(-child.pid!, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}
