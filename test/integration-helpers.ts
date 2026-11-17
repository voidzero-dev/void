import { execSync, type spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { basename, join, relative } from 'node:path/posix';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import crossSpawn from 'cross-spawn';

/**
 * Timeout multiplier for Windows CI runners, which are 2–3× slower
 * for builds and server startup.
 */
const CI_TIMEOUT_SCALE = process.platform === 'win32' ? 3 : 1;

/** How many ports startServer() tries before it gives up. */
const START_ATTEMPTS = 3;

const GENERATED_PLAYGROUND_ENTRIES = new Set([
  '.astro',
  '.cloudflare',
  '.next',
  '.nuxt',
  '.output',
  '.react-router',
  '.svelte-kit',
  '.tanstack',
  '.void',
  '.vite-cloud',
  '.wrangler',
  'build',
  'dist',
  'node_modules',
]);

export type IsolatedPlayground = {
  root: string;
  workspacePath: string;
  cleanup: () => void;
};

function shouldCopyPlaygroundPath(sourceRoot: string, path: string): boolean {
  const normalizedSourceRoot = sourceRoot.replaceAll('\\', '/');
  const normalizedPath = path.replaceAll('\\', '/');
  const relativePath = relative(normalizedSourceRoot, normalizedPath);
  const topLevelEntry = relativePath.split('/')[0];
  return relativePath === '' || !GENERATED_PLAYGROUND_ENTRIES.has(topLevelEntry);
}

/**
 * Copies a playground outside the workspace package globs so concurrent task-graph scans never
 * discover a manifest while the fixture is created or removed. Run Vite+ directly from the copy.
 * Dependencies stay linked to the installed source tree; generated state is deliberately not copied.
 */
export function createIsolatedPlayground(
  workspaceRoot: string,
  sourceWorkspacePath: string,
): IsolatedPlayground {
  const sourceRoot = join(workspaceRoot, sourceWorkspacePath);
  const playgroundLocal = join(workspaceRoot, 'playground-local', '.test-fixtures');
  mkdirSync(playgroundLocal, { recursive: true });
  const root = mkdtempSync(join(playgroundLocal, `test-${basename(sourceWorkspacePath)}-`));

  cpSync(sourceRoot, root, {
    recursive: true,
    filter(path) {
      // `cpSync` reports native backslash paths on Windows, while these workspace paths are
      // normalized to forward slashes. Normalize before using the POSIX path helpers or the
      // top-level `node_modules` directory is copied into the isolated dependency tree.
      return shouldCopyPlaygroundPath(sourceRoot, path);
    },
  });

  const sourceNodeModules = join(sourceRoot, 'node_modules');
  if (existsSync(sourceNodeModules)) {
    const fixtureNodeModules = join(root, 'node_modules');
    mkdirSync(fixtureNodeModules);
    const linkDependency = (source: string, destination: string) =>
      symlinkSync(
        realpathSync(source),
        destination,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    // Linking the whole directory leaves pnpm's relative package links behind
    // a Windows junction at a different depth. Pin each package's real target.
    for (const entry of readdirSync(sourceNodeModules, { withFileTypes: true })) {
      // Kit 3 writes project-specific generated configs here, not package dependencies.
      if (entry.name === '$app') {
        continue;
      }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      if (entry.name.startsWith('.') && entry.name !== '.bin') {
        continue;
      }
      const source = join(sourceNodeModules, entry.name);
      const destination = join(fixtureNodeModules, entry.name);
      if (entry.name.startsWith('@')) {
        mkdirSync(destination);
        for (const name of readdirSync(source)) {
          linkDependency(join(source, name), join(destination, name));
        }
      } else {
        linkDependency(source, destination);
      }
    }
  }

  // Avoid duplicate workspace package names when multiple copies exist concurrently.
  const packagePath = join(root, 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8')) as { name?: string };
  packageJson.name = `${packageJson.name ?? basename(sourceWorkspacePath)}-${basename(root)}`;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  return {
    root,
    workspacePath: relative(workspaceRoot, root),
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
}

/** Returns a port that is free right now. Another process can still take it before use. */
async function getFreePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, 'close');
  return port;
}

export type WaitForServerOptions = {
  expectBody?: string;
  rejectBody?: string;
  expectStatus?: number;
  isAlive?: () => boolean;
  /** Answers on the URL count only once this returns true. */
  isReady?: () => boolean;
  requestTimeoutMs?: number;
  diagnostics?: () => string;
};

export type StartServerOptions = Omit<
  WaitForServerOptions,
  'isAlive' | 'isReady' | 'diagnostics'
> & {
  /**
   * Pass `false` for a server that does not print its URL (Nuxt under Vitest). Answers then count
   * as soon as they match, so also pass an `expectBody` that only this app serves.
   */
  printsUrl?: boolean;
};

export type StartedServer = {
  child: ReturnType<typeof spawn>;
  port: number;
  /** `http://127.0.0.1:<port>` */
  base: string;
  /** The server's recent stdout and stderr. */
  output: () => string;
};

/**
 * Starts a server on a free port and waits until it answers.
 *
 * The server binds its port seconds after the port is chosen, and another process can take
 * the port in that time. `spawnServer` must make the server stop instead of moving to the
 * next port (pass `--strictPort` to Vite): a server that moves can take the port of another
 * test that is starting at the same time. When the server reports that its port is taken,
 * it is started again on a new port.
 *
 * Another process that takes the port can also answer on it. So answers count only after the
 * server prints its own URL with the port, which it does once it listens: Vite and Astro print
 * `Local: http://127.0.0.1:<port>/`, and the Node, Bun and Deno servers print
 * `Listening on http://…:<port>`.
 */
export async function startServer(
  spawnServer: (port: number) => ReturnType<typeof spawn>,
  timeoutMs: number,
  { printsUrl = true, ...options }: StartServerOptions = {},
): Promise<StartedServer> {
  for (let attempt = 1; ; attempt++) {
    const port = await getFreePort();
    const child = spawnServer(port);
    const output = collectServerOutput(child);
    const closed = new Promise((resolve) => child.once('close', resolve));
    const base = `http://127.0.0.1:${port}`;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    // Vite without `--strictPort` (Astro) keeps running and moves to the next port.
    const moved = () => output().includes(`Port ${port} is in use`);
    const listeningLine = new RegExp(
      String.raw`(?:Local:?|Listening on)\s+https?://[^\s/]+:${port}(?!\d)`,
    );
    let listening = false;
    try {
      await waitForServer(base, timeoutMs, {
        ...options,
        isAlive: () => !exited() && !moved(),
        isReady: () =>
          !printsUrl || (listening ||= listeningLine.test(stripVTControlCharacters(output()))),
        diagnostics: output,
      });
      return { child, port, base, output };
    } catch (error) {
      if (exited()) {
        // The last output can arrive after the exit.
        await Promise.race([closed, delay(1_000)]);
      }
      // Vite with `--strictPort`, Node, Bun and Deno exit with one of these messages.
      const portTaken = moved() || (exited() && /already in use|EADDRINUSE/.test(output()));
      await killChild(child);
      if (!portTaken) {
        throw error;
      }
      if (attempt === START_ATTEMPTS) {
        throw new Error(`Another process took the server port ${START_ATTEMPTS} times`, {
          cause: error,
        });
      }
      console.warn(`Another process took port ${port}; starting the server on a new port.`);
    }
  }
}

/** Spawns a workspace playground's `dev` or `preview` script; pass it to {@link startServer}. */
export function spawnPlaygroundServer(
  workspaceRoot: string,
  playground: string,
  script: 'dev' | 'preview',
  port: number,
): ReturnType<typeof spawn> {
  return crossSpawn(
    'vp',
    [
      'run',
      '--filter',
      `./playground/${playground}`,
      script,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      cwd: workspaceRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, VOID_INSPECTOR_PORT: 'false' },
    },
  );
}

export async function waitForServer(
  url: string,
  timeoutMs: number,
  options?: WaitForServerOptions,
): Promise<void> {
  const effectiveTimeout = timeoutMs * CI_TIMEOUT_SCALE;
  const start = Date.now();
  while (Date.now() - start < effectiveTimeout) {
    if (options?.isAlive && !options.isAlive()) {
      throw new Error(`Server stopped while waiting for ${url}\n${options.diagnostics?.() ?? ''}`);
    }
    if (options?.isReady && !options.isReady()) {
      await delay(200);
      continue;
    }
    try {
      const remainingMs = effectiveTimeout - (Date.now() - start);
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(options?.requestTimeoutMs ?? 5_000, remainingMs)),
      });
      const statusMatches =
        options?.expectStatus === undefined
          ? response.status > 0
          : response.status === options.expectStatus;
      if (statusMatches) {
        if (!options?.expectBody && !options?.rejectBody) {
          return;
        }
        const body = await response.text();
        if (
          (!options.expectBody || body.includes(options.expectBody)) &&
          (!options.rejectBody || !body.includes(options.rejectBody))
        ) {
          return;
        }
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Timed out waiting for server at ${url} (waited ${effectiveTimeout}ms, scale=${CI_TIMEOUT_SCALE})\n${options?.diagnostics?.() ?? ''}`,
  );
}

/** Drain both pipes during startup and retain bounded diagnostics for failures. */
export function collectServerOutput(child: ReturnType<typeof spawn>): () => string {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout = (stdout + String(chunk)).slice(-16000);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-16000);
  });
  return () => `Server stdout:\n${stdout}\nServer stderr:\n${stderr}`;
}

export async function killChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32' && child.pid) {
      // On Windows, SIGTERM doesn't propagate to child processes.
      // Use taskkill /T to kill the entire process tree (e.g. workerd.exe).
      try {
        execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        // Process may have already exited
      }
    } else if (child.pid) {
      // On Unix, SIGTERM only reaches the direct child (e.g. pnpm).
      // Grandchildren like vite → miniflare → workerd are NOT signalled
      // and become orphans that hold resource locks (D1 SQLite, ports).
      // Walk the process tree bottom-up so every descendant is killed.
      killTree(child.pid, 'SIGTERM');
    } else {
      child.kill('SIGTERM');
    }
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolve) => {
          deadline = setTimeout(resolve, 5_000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform !== 'win32' && child.pid) {
        killTree(child.pid, 'SIGKILL');
      } else {
        child.kill('SIGKILL');
      }
    }
  }
}

function killTree(pid: number, signal: NodeJS.Signals): void {
  // Find direct children before killing the parent, because once the
  // parent dies its children are reparented to init and pgrep -P won't
  // find them anymore.
  let childPids: Array<number> = [];
  try {
    childPids = execSync(`pgrep -P ${pid}`, { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    // pgrep exits 1 when no children are found
  }
  for (const childPid of childPids) {
    killTree(childPid, signal);
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Process may have already exited
  }
}
