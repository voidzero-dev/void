import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'pathslash';
import pc from 'picocolors';
import { getApiUrl, getProxyUrl, getToken } from './cli/auth.ts';
import { ensurePlatformProxyAccess } from './cli/cf-access.ts';
import { readProjectIdField } from './cli/project.ts';
import { ensureWranglerCompat } from './cli/wrangler.ts';
import { readConfig } from './config.ts';
import { voidLog, voidWarn } from './log.ts';
import {
  outputFileForPath,
  readPrerenderPathsResponse,
  renderPrerenderPaths,
  type PrerenderResult,
} from './prerender-render.ts';
export type { PrerenderResult } from './prerender-render.ts';
import { renderDefaultErrorPage } from './runtime/error-pages/index.ts';
import { scopedAccessCredentials } from './shared/cf-access.ts';
import { collectFiles } from './shared/collect-files.ts';
import { stripInternalEnvKeys } from './shared/env.ts';
import { buildEnv } from './shared/untrusted-env.ts';

const PRERENDER_PATHS_ENDPOINT = '/__void/prerender-paths';
const nodeRendererUrl = new URL(
  import.meta.url.endsWith('.ts') ? './prerender-render.ts' : './prerender-render.mjs',
  import.meta.url,
).href;

type PrerenderWorkerModuleType = 'ESModule' | 'CommonJS' | 'CompiledWasm' | 'Text' | 'Data';

export type PrerenderWorkerModule = {
  path: string;
  type: PrerenderWorkerModuleType;
  contents: string | Uint8Array;
};

export type PrerenderRunResult = PrerenderResult & {
  paths: Array<string>;
};

export function writeDefaultNotFoundPage(clientDir: string): void {
  // Preserve a public/404.html or a page explicitly prerendered at /404.
  const path = join(clientDir, '404.html');
  if (!existsSync(path)) {
    mkdirSync(clientDir, { recursive: true });
    writeFileSync(path, renderDefaultErrorPage(404));
  }
}

function normalizeWorkerModulePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function resolveWorkerModuleType(relativePath: string): PrerenderWorkerModuleType | null {
  const normalized = normalizeWorkerModulePath(relativePath);

  if (normalized.includes('/.vite/') || normalized.startsWith('.vite/')) {
    return null;
  }
  if (normalized === 'wrangler.json' || normalized === 'wrangler.jsonc') {
    return null;
  }
  if (normalized.endsWith('.mjs') || normalized.endsWith('.js')) {
    return 'ESModule';
  }
  if (normalized.endsWith('.cjs')) {
    return 'CommonJS';
  }
  if (normalized.endsWith('.wasm')) {
    return 'CompiledWasm';
  }
  if (normalized.endsWith('.txt')) {
    return 'Text';
  }
  if (normalized.endsWith('.bin')) {
    return 'Data';
  }

  return null;
}

export function collectPrerenderWorkerModules(
  workerDir: string,
  workerMain: string,
): Array<PrerenderWorkerModule> {
  const normalizedEntry = normalizeWorkerModulePath(workerMain);
  type CollectedPrerenderWorkerModule = PrerenderWorkerModule & {
    relativePath: string;
  };

  const modules: Array<CollectedPrerenderWorkerModule> = collectFiles(workerDir).flatMap(
    (filePath) => {
      const relativePath = normalizeWorkerModulePath(relative(workerDir, filePath));
      const type = resolveWorkerModuleType(relativePath);
      if (!type) {
        return [];
      }

      const file = readFileSync(filePath);
      const contents: PrerenderWorkerModule['contents'] =
        type === 'CompiledWasm' || type === 'Data' ? new Uint8Array(file) : file.toString('utf-8');

      return [{ path: filePath, relativePath, type, contents }];
    },
  );

  modules.sort((a, b) => {
    if (a.relativePath === normalizedEntry) {
      return -1;
    }
    if (b.relativePath === normalizedEntry) {
      return 1;
    }
    return a.relativePath.localeCompare(b.relativePath);
  });

  if (!modules.some((module) => module.relativePath === normalizedEntry)) {
    throw new Error(`prerender: Worker entry '${normalizedEntry}' not found in '${workerDir}'.`);
  }

  return modules.map(({ relativePath: _relativePath, ...module }) => module);
}

export type PrerenderBindingsInput = {
  wranglerVars: Record<string, unknown> | undefined;
  voidToken: string | null | undefined;
  voidProjectId: string | undefined;
  voidProxyUrl?: string;
  accessEnv?: Record<string, unknown>;
  remoteMode: boolean | undefined;
};

export function buildPrerenderBindings(input: PrerenderBindingsInput): Record<string, unknown> {
  const { sanitized: wranglerVars, stripped } = stripInternalEnvKeys(input.wranglerVars);
  if (stripped.length > 0) {
    voidWarn(
      `Ignoring internal env keys in prerender inputs: ${stripped.join(', ')}. These are reserved for Void runtime use.`,
    );
  }

  const voidBindings: Record<string, string> = {};
  if (input.voidToken && input.voidProjectId) {
    voidBindings.__VOID_TOKEN = input.voidToken;
    voidBindings.__VOID_PROJECT_ID = input.voidProjectId;
    if (!input.voidProxyUrl) {
      throw new Error(
        'prerender: No connected platform proxy is available. Run `void connect <url>` first.',
      );
    }
    voidBindings.__VOID_PROXY_URL = input.voidProxyUrl;
    const access = scopedAccessCredentials(input.accessEnv ?? {}, voidBindings.__VOID_PROXY_URL!);
    if (access) {
      voidBindings.__VOID_ACCESS_CREDENTIALS = access;
    }
    if (input.remoteMode) {
      voidBindings.__VOID_REMOTE = '1';
    }
  }
  return { ...wranglerVars, ...voidBindings };
}

async function createCloudflarePrerenderRunner(options: {
  root: string;
  workerDir: string;
  persistDir: string;
  clientDir?: string;
  remoteMode?: boolean;
  projectId?: string;
  voidToken?: string;
}) {
  const { root, workerDir, persistDir, clientDir, remoteMode } = options;

  const wranglerPath = join(workerDir, 'wrangler.json');
  if (!existsSync(wranglerPath)) {
    throw new Error(`prerender: wrangler.json not found in '${workerDir}'.`);
  }
  const wranglerConfig = JSON.parse(readFileSync(wranglerPath, 'utf-8'));
  const wranglerCompat = ensureWranglerCompat(root, readConfig(root), workerDir);
  const workerMain = wranglerConfig.main ?? 'index.js';

  // Resolve Void projectId via a three-level chain:
  //   1. explicit options.projectId — passed from runFullDeploy so the
  //      `void deploy --project <slug>` flow works even when the in-memory
  //      config hasn't been persisted to .void/project.json yet.
  //   2. VOID_DEPLOY_PROJECT_ID env var — only when the caller exports it.
  //      Managed builds skip plugin prerender (VOID_DEPLOY_BUILD=1) and
  //      runFullDeploy passes projectId instead.
  //   3. .void/project.json — existing on-disk fallback for linked projects.
  let voidProjectId: string | undefined = options.projectId;
  if (!voidProjectId) {
    voidProjectId = process.env.VOID_DEPLOY_PROJECT_ID || undefined;
  }
  if (!voidProjectId) {
    voidProjectId = readProjectIdField(root);
  }
  // A token is only useful alongside a project ID. Avoid touching the system
  // keychain for ordinary unlinked builds, which also keeps parallel prerenders
  // from contending on the platform credential store.
  // Managed deploy passes a dedicated, short-lived prerender token explicitly.
  // Self-hosted `vite build` keeps the existing linked-project credential
  // fallback because it has no parent deploy orchestrator to mint one.
  const voidToken = voidProjectId ? (options.voidToken ?? getToken(root)) : null;
  const voidProxyUrl = voidToken && voidProjectId ? getProxyUrl(root) : undefined;

  if (voidProxyUrl) {
    ensurePlatformProxyAccess(getApiUrl(root), voidProxyUrl);
  }
  // Local `.env` values never enter a production prerender; production server
  // configuration is read at runtime from remote secrets.
  const bindings = buildPrerenderBindings({
    accessEnv: process.env,
    wranglerVars: wranglerConfig.vars,
    voidToken,
    voidProjectId,
    voidProxyUrl,
    remoteMode,
  });

  // Miniflare 5 only accepts its new multi-worker
  // config shape; the flat single-worker options below are the v4 shape, which it
  // still exports a converter for. `@cloudflare/vite-plugin` 1.54 builds its own
  // Miniflare instances the same way (`new Miniflare(convertV4MiniflareOptions(...))`).
  const { Miniflare, convertV4MiniflareOptions } = (await import('miniflare')) as unknown as {
    Miniflare: new (options: Record<string, unknown>) => {
      dispatchFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
      dispose(): Promise<void>;
    };
    convertV4MiniflareOptions: (options: Record<string, unknown>) => Record<string, unknown>;
  };

  const mfOptions: Record<string, unknown> = {
    modules: collectPrerenderWorkerModules(workerDir, workerMain),
    modulesRoot: workerDir,
    compatibilityDate: wranglerCompat.compatibilityDate,
    compatibilityFlags: wranglerCompat.compatibilityFlags ?? [],
    // Marks this Worker as the build-time prerender runner, the only place the
    // built app answers path discovery. Deployed Workers never carry it.
    bindings: { ...bindings, __VOID_PRERENDER: '1' },
  };
  if (clientDir) {
    mfOptions.serviceBindings = {
      [wranglerConfig.assets?.binding ?? 'ASSETS'](request: Request) {
        const url = new URL(request.url);
        const filePath = join(clientDir, url.pathname);
        try {
          const content = readFileSync(filePath);
          return new Response(content);
        } catch {
          return new Response('Not Found', { status: 404 });
        }
      },
    };
  }

  const d1 = wranglerConfig.d1_databases;
  if (Array.isArray(d1) && d1.length > 0) {
    const databases: Record<string, string> = {};
    for (const db of d1) {
      databases[db.binding] = db.database_id;
    }
    mfOptions.d1Databases = databases;
  }

  const kv = wranglerConfig.kv_namespaces;
  if (Array.isArray(kv) && kv.length > 0) {
    const namespaces: Record<string, string> = {};
    for (const ns of kv) {
      namespaces[ns.binding] = ns.id;
    }
    mfOptions.kvNamespaces = namespaces;
  }

  const r2 = wranglerConfig.r2_buckets;
  if (Array.isArray(r2) && r2.length > 0) {
    const buckets: Record<string, string> = {};
    for (const bucket of r2) {
      buckets[bucket.binding] = bucket.bucket_name;
    }
    mfOptions.r2Buckets = buckets;
  }

  // One persistence root for every local resource: miniflare 5 replaced the
  // per-product `d1Persist`/`kvPersist`/`r2Persist` with `resourcePersistencePath`,
  // which it splits into `<root>/d1`, `<root>/kv`, `<root>/r2`. The root is
  // `<persistDir>/v3`, the same one `@cloudflare/vite-plugin` derives from
  // `persistState: { path: '.void' }` for the dev server and the one
  // `getMiniflareDatabasePath` (migration runner, drizzle plugin, auth bootstrap)
  // addresses: `.void/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`. Passing
  // `persistDir` itself would open a second, empty database under `.void/d1`.
  // Set only when a resource is bound, as the per-product options were.
  if (mfOptions.d1Databases || mfOptions.kvNamespaces || mfOptions.r2Buckets) {
    mfOptions.resourcePersistencePath = join(persistDir, 'v3');
  }

  const mf = new Miniflare(convertV4MiniflareOptions(mfOptions));

  return {
    async collectPaths(): Promise<Array<string>> {
      return readPrerenderPathsResponse(
        await mf.dispatchFetch(`http://localhost${PRERENDER_PATHS_ENDPOINT}`, { method: 'POST' }),
      );
    },
    async fetchPath(path: string): Promise<Response> {
      return mf.dispatchFetch(`http://localhost${path}`);
    },
    async fetchPageData(path: string): Promise<Response> {
      return mf.dispatchFetch(`http://localhost${path}`, {
        headers: { Accept: 'application/json', Purpose: 'prefetch', 'X-VoidPages': 'true' },
      });
    },
    async close() {
      await mf.dispose();
    },
  };
}

export async function collectPrerenderPaths(options: {
  root: string;
  workerDir: string;
  persistDir: string;
  clientDir?: string;
  remoteMode?: boolean;
  projectId?: string;
  voidToken?: string;
}): Promise<Array<string>> {
  const runner = await createCloudflarePrerenderRunner(options);
  try {
    return await runner.collectPaths();
  } finally {
    await runner.close();
  }
}

/**
 * Prerender pages by spinning up Miniflare with the built worker.
 * Collects paths through the built worker's internal endpoint and then
 * fetches each page, writing HTML responses to `clientDir`.
 */
export async function prerenderPages(options: {
  root: string;
  workerDir: string;
  clientDir: string;
  persistDir: string;
  remoteMode?: boolean;
  projectId?: string;
  voidToken?: string;
}): Promise<PrerenderRunResult> {
  const runner = await createCloudflarePrerenderRunner(options);
  try {
    const paths = await runner.collectPaths();
    const result = await renderPrerenderPaths(
      paths,
      options.clientDir,
      (path) => runner.fetchPath(path),
      (path) => runner.fetchPageData(path),
      (path, outputFile, error) => {
        if (error !== undefined) {
          voidWarn(`prerender ${path} failed: ${error}`);
        } else {
          voidLog(`prerender ${pc.blue(outputFile)}`);
        }
      },
    );
    writeDefaultNotFoundPage(options.clientDir);
    return { paths, ...result };
  } finally {
    await runner.close();
  }
}

type NodeRunnerConfig =
  | { mode: 'collect'; ssrDir: string; clientDir?: string }
  | { mode: 'collect-and-render'; ssrDir: string; clientDir: string };

async function runNodePrerenderRunner<T>(root: string, config: NodeRunnerConfig): Promise<T> {
  const runnerPath = join(root, '.void', 'prerender-runner.mjs');
  mkdirSync(dirname(runnerPath), { recursive: true });
  writeFileSync(
    runnerPath,
    `
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { readPrerenderPathsResponse, renderPrerenderPaths } from ${JSON.stringify(nodeRendererUrl)};

const config = JSON.parse(process.argv[2]);
const { mode, ssrDir, clientDir } = config;

const appUrl = pathToFileURL(join(ssrDir, "app.js")).href;
const app = await import(appUrl);
const fetch = app.default?.fetch;
if (!fetch) {
  console.error("[void] No default export with fetch() found in app.js");
  process.exit(1);
}

// The second argument is the Hono env. Its marker is what lets the built app
// answer path discovery; HTTP servers never pass it.
async function collectPaths() {
  return readPrerenderPathsResponse(
    await fetch(
      new Request("http://localhost${PRERENDER_PATHS_ENDPOINT}", { method: "POST" }),
      { __VOID_PRERENDER: "1" },
    ),
  );
}

async function renderPaths(paths) {
  if (!clientDir) return { rendered: [], failed: [] };
  return renderPrerenderPaths(
    paths, clientDir,
    (path) => fetch(new Request("http://localhost" + path)),
    (path) => fetch(new Request("http://localhost" + path, {
      headers: { "Accept": "application/json", "Purpose": "prefetch", "X-VoidPages": "true" },
    })),
  );
}

if (mode === "collect") {
  process.stdout.write(JSON.stringify({ paths: await collectPaths() }));
} else {
  const paths = await collectPaths();
  const result = await renderPaths(paths);
  process.stdout.write(JSON.stringify({ paths, ...result }));
}
`,
  );

  try {
    return await new Promise<T>((resolve, reject) => {
      execFile(
        process.execPath,
        [runnerPath, JSON.stringify(config)],
        { env: buildEnv(), cwd: root, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (stderr) {
            process.stderr.write(stderr);
          }
          if (error) {
            reject(new Error(`Prerender child process failed: ${error.message}`));
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error(`Failed to parse prerender output: ${stdout}`));
          }
        },
      );
    });
  } finally {
    try {
      unlinkSync(runnerPath);
    } catch {
      // Ignore cleanup failures for the temporary prerender runner.
    }
  }
}

export async function collectPrerenderPathsNode(options: {
  root: string;
  ssrDir: string;
  clientDir?: string;
}): Promise<Array<string>> {
  const result = await runNodePrerenderRunner<{ paths: Array<string> }>(options.root, {
    mode: 'collect',
    ssrDir: options.ssrDir,
    clientDir: options.clientDir,
  });
  return result.paths;
}

/**
 * Prerender pages for Node.js targets by spawning a child process.
 *
 * Uses a child process to avoid mutating `process.env` in the parent Vite
 * build process. The child imports the built app, collects prerender paths
 * from the internal endpoint, renders each page, and returns the result.
 */
export async function prerenderPagesNode(options: {
  root: string;
  ssrDir: string;
  clientDir: string;
}): Promise<PrerenderRunResult> {
  const result = await runNodePrerenderRunner<PrerenderRunResult>(options.root, {
    mode: 'collect-and-render',
    ssrDir: options.ssrDir,
    clientDir: options.clientDir,
  });

  writeDefaultNotFoundPage(options.clientDir);

  for (const path of result.rendered) {
    voidLog(`prerender ${pc.blue(outputFileForPath(path))}`);
  }
  for (const { path, error } of result.failed) {
    voidWarn(`prerender ${path} failed: ${error}`);
  }

  return result;
}
