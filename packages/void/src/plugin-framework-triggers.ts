import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'pathslash';
import { normalizePath, type Plugin } from 'vite';
import { readRootWranglerConfig } from './cli/wrangler.ts';
import { scanJobsSync, type JobDefinition } from './crons/scan.ts';
import { voidWarn } from './log.ts';
import { readProjectPaths } from './project-paths.ts';
import { scanQueuesSync, type QueueDefinition } from './queues/scan.ts';
import { ensureGitignoreLines } from './shared/gitignore.ts';

type FrameworkTriggersOptions = {
  devTriggerToken: string;
};

const DISPATCH_FILE_MODE = 0o600;

/** Absolute path of the generated dispatch file. Stable across the dev process. */
export function frameworkTriggersDispatchPath(root: string): string {
  return join(root, '.void', 'dev-triggers.ts');
}

/**
 * Synchronously emit `<root>/.void/dev-triggers.ts`. We expose this directly
 * (in addition to the Vite plugin below) so callers like the Class A entry
 * wrapper can guarantee the file exists at the moment they reference it,
 * without depending on `configResolved` ordering.
 */
export function writeFrameworkTriggersDispatch(root: string, devTriggerToken: string): void {
  const paths = readProjectPaths(root);
  const jobs = scanJobsSync(paths.cronsDir);
  const queues = scanQueuesSync(paths.queuesDir);
  const target = frameworkTriggersDispatchPath(root);
  mkdirSync(dirname(target), { recursive: true });
  // Owner-only, like `.void/dev-trigger-token`: this module embeds the same
  // token, and it is the inbox's whole credential (see `getOrCreateDevTriggerToken`).
  // `mode` applies only when the file is created, so a file left by an
  // earlier release is tightened after the rewrite — best-effort, and not on
  // Windows, where `chmod` has no group/other bits to clear.
  writeFileSync(
    target,
    generateModule(paths.cronsDir, paths.queuesDir, jobs, queues, devTriggerToken),
    { mode: DISPATCH_FILE_MODE },
  );
  if (process.platform !== 'win32') {
    try {
      chmodSync(target, DISPATCH_FILE_MODE);
    } catch {
      // ignore
    }
  }
}

/**
 * Writes a real file at `<root>/.void/dev-triggers.ts` exporting
 * `handleDevTrigger(request, env, ctx)`. We use a real file (not a Vite
 * virtual module) because Nitro has its own server bundler that doesn't go
 * through Vite's plugin pipeline. The framework injection code imports
 * this path at runtime to dispatch cron and queue handlers
 * with the framework adapter's real bindings.
 */
export function frameworkTriggersPlugin(root: string, options: FrameworkTriggersOptions): Plugin {
  const writeDispatch = () => writeFrameworkTriggersDispatch(root, options.devTriggerToken);
  const dispatchPath = frameworkTriggersDispatchPath(root);

  return {
    name: 'void:framework-triggers',
    apply: 'serve',
    configResolved() {
      writeDispatch();
    },
    configureServer(server) {
      // Re-emit on any cron/queue file mutation so add/remove and edits to
      // the schedule string or queue name (which are baked into the
      // generated `__jobs`/`__queues` table at codegen time) are picked up
      // without a full restart.
      //
      // Watcher paths are native (backslashes on Windows); normalize before comparing.
      const paths = readProjectPaths(root);
      const cronsPrefix = normalizePath(paths.cronsDir);
      const queuesPrefix = normalizePath(paths.queuesDir);
      const isInteresting = (file: string) => {
        const normalized = normalizePath(file);
        return normalized.startsWith(cronsPrefix) || normalized.startsWith(queuesPrefix);
      };
      const onChange = (file: string) => {
        if (!isInteresting(file)) {
          return;
        }
        writeDispatch();
        // In the Class A composition, `envPlugin.config` ignores `.void/` in the
        // watcher, so Vite never invalidates the cached dispatch module itself.
        for (const env of Object.values(server.environments)) {
          const mod = env.moduleGraph.getModuleById(dispatchPath);
          if (mod) {
            env.moduleGraph.invalidateModule(mod);
          }
        }
      };
      server.watcher.on('add', onChange);
      server.watcher.on('change', onChange);
      server.watcher.on('unlink', onChange);
    },
  };
}

function generateModule(
  cronsDir: string,
  queuesDir: string,
  jobs: Array<JobDefinition>,
  queues: Array<QueueDefinition>,
  devTriggerToken: string,
): string {
  const jobImports = jobs
    .map(
      (job, jobIndex) =>
        `import __job${jobIndex} from ${JSON.stringify(join(cronsDir, job.filePath))};`,
    )
    .join('\n');
  const queueImports = queues
    .map(
      (queue, queueIndex) =>
        `import __queue${queueIndex} from ${JSON.stringify(join(queuesDir, queue.filePath))};`,
    )
    .join('\n');

  const jobTable = jobs
    .map((job, jobIndex) => `  { crons: ${JSON.stringify(job.crons)}, handler: __job${jobIndex} }`)
    .join(',\n');
  const queueTable = queues
    .map(
      (queue, queueIndex) =>
        `  { name: ${JSON.stringify(queue.name)}, handler: __queue${queueIndex} }`,
    )
    .join(',\n');

  return `// @ts-nocheck — Auto-generated by Void in dev. Do NOT edit. Regenerated on every config load.
${jobImports}
${queueImports}

const __DEV_TRIGGER_TOKEN = ${JSON.stringify(devTriggerToken)};

const __jobs = [
${jobTable}
];

const __queues = [
${queueTable}
];

function __json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Dev only: production framework Workers dispatch through cli/wrapper.ts.
function __authorize(request) {
  return request.headers.get("x-void-dev-trigger") === __DEV_TRIGGER_TOKEN;
}

function __wrapMessage(m, decisions) {
  let decided = false;
  return {
    id: m.id,
    timestamp: new Date(m.timestamp),
    body: m.body,
    attempts: m.attempts,
    ack() {
      if (!decided) {
        decided = true;
        decisions.set(m.id, { action: "ack" });
      }
    },
    retry(opts) {
      if (!decided) {
        decided = true;
        decisions.set(m.id, {
          action: "retry",
          ...(opts?.delaySeconds != null ? { delaySeconds: opts.delaySeconds } : {}),
        });
      }
    },
  };
}

async function __dispatchScheduled(request, env, ctx) {
  const { cron, scheduledTime } = await request.json();
  const jobs = __jobs.filter((j) => j.crons.includes(cron));
  if (jobs.length === 0) {
    return __json({ error: \`No cron handler matches "\${cron}"\` }, 404);
  }
  const controller = { cron, scheduledTime, noRetry() {} };
  const executionContext = ctx ?? { waitUntil() {}, passThroughOnException() {} };
  const results = await Promise.allSettled(jobs.map(async (job) => {
    await job.handler(controller, env, executionContext);
  }));
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, "Scheduled jobs failed");
  return __json({ ok: true });
}

async function __dispatchQueue(request, env) {
  const payload = await request.json();
  // Exact match only — payload.queue is the user-typed queue name from the
  // dev curl. The prod platform-side dispatch suffix-matches against
  // project-prefixed queue names, but that isn't relevant here and would
  // cause false positives between e.g. "events" and "user-events".
  const q = __queues.find((entry) => entry.name === payload.queue);
  if (!q) {
    return __json({ error: \`No queue handler matches "\${payload.queue}"\` }, 404);
  }
  const decisions = new Map();
  const messages = (payload.messages ?? []).map((m) => __wrapMessage(m, decisions));
  const batch = {
    queue: payload.queue,
    messages,
    ackAll() {
      for (const m of messages) m.ack();
    },
    retryAll(opts) {
      for (const m of messages) m.retry(opts);
    },
  };
  let ok = true;
  try {
    await q.handler(batch, env);
  } catch (err) {
    ok = false;
    console.error("[void] queue handler threw:", err);
  }
  return __json({
    ok,
    ...(decisions.size > 0 ? { decisions: Object.fromEntries(decisions) } : {}),
  });
}

/**
 * If \`request\` is a /__void/scheduled or /__void/queue trigger, validate auth,
 * dispatch, and return a \`Response\`. Otherwise return null so the caller can
 * forward to the framework's normal request handling.
 */
export async function handleDevTrigger(request, env, ctx) {
  if (request.method !== "POST") return null;
  const url = new URL(request.url);
  if (url.pathname !== "/__void/scheduled" && url.pathname !== "/__void/queue") {
    return null;
  }
  if (!__authorize(request)) {
    return __json({ error: "unauthorized" }, 401);
  }
  if (url.pathname === "/__void/scheduled") {
    return __dispatchScheduled(request, env, ctx);
  }
  return __dispatchQueue(request, env);
}
`;
}

/** Remove `lines` from the project's `.gitignore`, if it still exists. */
function removeGitignoreLines(root: string, lines: ReadonlyArray<string>): void {
  const gitignorePath = join(root, '.gitignore');
  if (lines.length === 0 || !existsSync(gitignorePath)) {
    return;
  }
  const contents = readFileSync(gitignorePath, 'utf-8');
  const remove = new Set(lines);
  const next = contents
    .split('\n')
    .filter((line) => !remove.has(line.trim()))
    .join('\n');
  if (next !== contents) {
    writeFileSync(gitignorePath, next);
  }
}

const NITRO_MIDDLEWARE_FILENAME = '__void-dev-trigger.ts';

function nitroMiddlewareSource(dispatchPath: string): string {
  // Plain async default export, no h3 imports — kept dependency-free so the
  // same source compiles under Nuxt's real Nitro pipeline. Analog uses a
  // different injection path (`analogDevTriggerInjectPlugin` below) because
  // `@analogjs/vite-plugin-nitro` evaluates middleware via Vite SSR before
  // its `nitro-cloudflare-dev` plugin populates `event.context.cloudflare`,
  // so this middleware shape would never see CF bindings there.
  return `// @ts-nocheck — Auto-generated by Void in dev. Do NOT edit. Removed when the dev server stops.
import { handleDevTrigger } from ${JSON.stringify(dispatchPath)};

export default async function voidDevTrigger(event) {
  const req = event.node.req;
  if (req.method !== 'POST') return;
  const path = req.url || '';
  if (!path.startsWith('/__void/scheduled') && !path.startsWith('/__void/queue')) return;

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const webReq = new Request(\`http://localhost\${path}\`, { method: 'POST', headers, body });

  const cloudflare = event.context?.cloudflare;
  const response = await handleDevTrigger(webReq, cloudflare?.env ?? {}, cloudflare?.context);
  if (!response) return;

  const res = event.node.res;
  res.statusCode = response.status;
  for (const [k, v] of response.headers) res.setHeader(k, v);
  res.end(await response.text());
  return true;
}
`;
}

/**
 * Writes a tiny Nitro server middleware to the user's project so
 * `/__void/scheduled` and `/__void/queue` are intercepted inside Nitro's
 * request pipeline (where `event.context.cloudflare?.env` is populated).
 *
 * Nitro discovers middleware from `<serverDir>/middleware/*.ts`. Nuxt scans
 * `server/`, Analog scans `src/server/`, so the caller specifies which.
 * To keep the generated file out of git we append a `.gitignore` entry,
 * and the file is removed when the dev server stops.
 */
export function nitroDevTriggerInjectPlugin(
  root: string,
  options: { serverDir: 'server' | 'src/server' },
): Plugin {
  const middlewareRelative = `${options.serverDir}/middleware/${NITRO_MIDDLEWARE_FILENAME}`;
  const middlewarePath = join(root, middlewareRelative);
  const dispatchPath = frameworkTriggersDispatchPath(root);

  const ensureFile = () => {
    mkdirSync(dirname(middlewarePath), { recursive: true });
    writeFileSync(middlewarePath, nitroMiddlewareSource(dispatchPath));
  };

  const cleanup = () => {
    rmSync(middlewarePath, { force: true });
  };

  return {
    name: 'void:nitro-dev-trigger-inject',
    apply: 'serve',
    configureServer(server) {
      ensureFile();
      ensureGitignoreLines(root, [middlewareRelative]);
      server.httpServer?.once('close', cleanup);
      // Also clean up on process exit (Vite's close hook only fires on
      // graceful shutdown, not on Ctrl-C in some shells).
      process.once('exit', cleanup);
    },
  };
}

const ANALOG_ROUTE_DIR_RELATIVE = 'src/server/routes/api/__void';
// User-facing trigger path → Nitro route filename. We rename the underlying
// files because Nitro treats `scheduled` as a reserved name (its task system)
// and emits a TDZ-shaped circular-init error on `scheduled$1` otherwise. The
// user-facing URL stays `/__void/{scheduled,queue}` via the Vite proxy.
const ANALOG_TRIGGERS = [
  { user: 'scheduled', file: 'cron-trigger' },
  { user: 'queue', file: 'queue-trigger' },
] as const;

function analogRouteSource(dispatchPath: string, userTrigger: 'scheduled' | 'queue'): string {
  // Nitro-discovered route inside Nitro's full pipeline, so
  // nitro-cloudflare-dev has populated `event.context.cloudflare` by the time
  // this fires. Unlike Nuxt, @analogjs/vite-plugin-nitro doesn't apply
  // Nitro's auto-imports to user route files, so we import h3 helpers
  // explicitly. (h3 resolves here because Nitro itself bundles the file —
  // unlike the Vite-SSR'd middleware path that fails on `from 'h3'`.)
  return `// @ts-nocheck — Auto-generated by Void in dev. Do NOT edit. Removed when the dev server stops.
import { defineEventHandler } from 'h3';
import { handleDevTrigger } from ${JSON.stringify(dispatchPath)};

export default defineEventHandler(async (event) => {
  const req = event.node.req;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const webReq = new Request('http://localhost/__void/${userTrigger}', {
    method: 'POST',
    headers,
    body,
  });

  const cloudflare = event.context?.cloudflare;
  const response = await handleDevTrigger(webReq, cloudflare?.env ?? {}, cloudflare?.context);
  if (!response) return;

  const res = event.node.res;
  res.statusCode = response.status;
  for (const [k, v] of response.headers) res.setHeader(k, v);
  res.end(await response.text());
  return true;
});
`;
}

/**
 * Analog-specific injection. Analog's @analogjs/vite-plugin-nitro registers
 * user "server middleware" on Vite's connect pipeline (deliberately, to keep
 * some routes out of Nitro), so Nitro plugins like nitro-cloudflare-dev never
 * run for it and `event.context.cloudflare` is empty there.
 *
 * Workaround: put the actual handlers at `src/server/routes/api/__void/{cron,queue}-trigger.ts`
 * — Nitro *does* run plugins for routes — and proxy `/__void/{scheduled,queue}`
 * to `/api/__void/{cron,queue}-trigger` from a small Vite middleware so the
 * user-facing URL stays consistent with the other frameworks.
 */
export function analogDevTriggerInjectPlugin(root: string): Plugin {
  const routeDir = join(root, ANALOG_ROUTE_DIR_RELATIVE);
  const routePaths = ANALOG_TRIGGERS.map(
    (trigger) => ({ ...trigger, path: join(routeDir, `${trigger.file}.ts`) }) as const,
  );
  const gitignoreLines = ANALOG_TRIGGERS.map(
    (trigger) => `${ANALOG_ROUTE_DIR_RELATIVE}/${trigger.file}.ts`,
  );
  const dispatchPath = frameworkTriggersDispatchPath(root);

  const ensureFiles = () => {
    mkdirSync(routeDir, { recursive: true });
    for (const { user, path } of routePaths) {
      writeFileSync(path, analogRouteSource(dispatchPath, user));
    }
  };

  const cleanup = () => {
    for (const { path } of routePaths) {
      rmSync(path, { force: true });
    }
  };

  return {
    name: 'void:analog-dev-trigger-inject',
    apply: 'serve',
    configureServer(server) {
      ensureFiles();
      ensureGitignoreLines(root, gitignoreLines);

      // Proxy /__void/{scheduled,queue} → /api/__void/{scheduled,queue} so
      // the user-facing URL is the same as for Nuxt/SvelteKit/Astro. The
      // proxy hop is local and only runs in dev.
      const proxy = async (
        req: import('node:http').IncomingMessage,
        res: import('node:http').ServerResponse,
        next: (err?: unknown) => void,
      ) => {
        if (req.method !== 'POST') {
          next();
          return;
        }
        const path = req.url ?? '';
        const match = ANALOG_TRIGGERS.find((trigger) => path === `/__void/${trigger.user}`);
        if (!match) {
          next();
          return;
        }
        // Target the address this dev server is bound to. The request Host
        // header comes from the client and must not choose where the proxy
        // sends the request.
        const address = server.httpServer?.address();
        if (!address || typeof address !== 'object') {
          next();
          return;
        }
        const hostname =
          address.address === '0.0.0.0'
            ? '127.0.0.1'
            : address.address === '::'
              ? 'localhost'
              : address.address.includes(':')
                ? `[${address.address}]`
                : address.address;
        try {
          const chunks: Array<Buffer> = [];
          for await (const chunk of req) {
            chunks.push(chunk as Buffer);
          }
          const body = Buffer.concat(chunks);
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') {
              headers.set(key, value);
            } else if (Array.isArray(value)) {
              headers.set(key, value.join(', '));
            }
          }
          const upstream = await fetch(
            `http://${hostname}:${address.port}/api/__void/${match.file}`,
            {
              method: 'POST',
              headers,
              body,
            },
          );
          res.statusCode = upstream.status;
          upstream.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await upstream.arrayBuffer()));
        } catch (err) {
          next(err);
        }
      };
      server.middlewares.use(proxy);

      server.httpServer?.once('close', cleanup);
      process.once('exit', cleanup);
    },
  };
}

const ASTRO_MIDDLEWARE_RELATIVE = 'src/middleware.ts';

function astroMiddlewareSource(dispatchPath: string): string {
  return `// @ts-nocheck — Auto-generated by Void in dev. Do NOT edit. Removed when the dev server stops.
import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { handleDevTrigger } from ${JSON.stringify(dispatchPath)};

export const onRequest = defineMiddleware(async (context, next) => {
  if (context.request.method !== 'POST') return next();
  const { pathname } = context.url;
  if (pathname !== '/__void/scheduled' && pathname !== '/__void/queue') return next();

  const response = await handleDevTrigger(context.request, env, context.locals.cfContext);
  return response ?? next();
});
`;
}

type AstroMiddlewareClaim = { servers: number; gitignoreLines: ReadonlyArray<string> };

const ASTRO_MIDDLEWARE_CLAIMS: unique symbol = Symbol.for('void.astroDevMiddleware.v1');

/**
 * The dev servers in this process that use the middleware Void wrote, by file path. Astro restarts
 * the dev server in the same process with a fresh config, so a new plugin instance (from a new
 * copy of this module, too) is set up before the old server closes. Kept on `globalThis` so both
 * see the same claim.
 */
function astroMiddlewareClaims(): Map<string, AstroMiddlewareClaim> {
  const store = globalThis as typeof globalThis & {
    [ASTRO_MIDDLEWARE_CLAIMS]?: Map<string, AstroMiddlewareClaim>;
  };
  return (store[ASTRO_MIDDLEWARE_CLAIMS] ??= new Map());
}

/**
 * Whether the Astro app has middleware that Void did not write. Void cannot add its dev trigger
 * middleware then, so the wrapper around Astro's Cloudflare server entry answers the triggers.
 */
export function hasOwnAstroMiddleware(root: string): boolean {
  const middlewarePath = join(root, ASTRO_MIDDLEWARE_RELATIVE);
  if (existsSync(middlewarePath)) {
    // A restart: the dev server being replaced wrote this file and still holds it.
    return !astroMiddlewareClaims().has(middlewarePath);
  }
  return existsSync(join(root, 'src', 'middleware', 'index.ts'));
}

/** The Worker entry from the app's Cloudflare config, unless it is Astro's server entry. */
function customAstroWorkerEntry(root: string): string | undefined {
  let main: unknown;
  try {
    main = readRootWranglerConfig(root)?.config.main;
  } catch {
    return undefined;
  }
  return typeof main === 'string' &&
    !/^@astrojs\/cloudflare\/entrypoints\/server(?:\.js)?$/.test(main)
    ? main
    : undefined;
}

/**
 * Writes a tiny Astro middleware to the user's project so
 * `/__void/scheduled` and `/__void/queue` are intercepted inside Astro's
 * request pipeline, with bindings from `cloudflare:workers`. Astro runs
 * middleware for a custom Worker entry too.
 *
 * Astro middleware lives at a single discoverable entry, so if the user
 * already has `src/middleware.ts` we don't overwrite it. The wrapper around
 * Astro's Cloudflare server entry answers the triggers then. A custom Worker
 * entry can skip that server entry, so we warn when the app sets one.
 *
 * If we wrote the file we remove it when the last dev server using it closes,
 * so the user's source tree stays clean. `src/middleware.ts` belongs to the
 * user, so the `.gitignore` line we add for it is removed too; otherwise a
 * middleware they write later would be silently left out of git.
 */
export function astroDevTriggerInjectPlugin(root: string): Plugin {
  const middlewarePath = join(root, ASTRO_MIDDLEWARE_RELATIVE);
  const claims = astroMiddlewareClaims();

  /** Whether the dev server being set up now holds the middleware Void wrote. */
  const ensureFile = (): boolean => {
    if (hasOwnAstroMiddleware(root)) {
      const entry = customAstroWorkerEntry(root);
      if (entry) {
        voidWarn(
          `Your Astro app has its own middleware and its own Worker entry (${entry}).\n` +
            '         In dev, /__void/scheduled and /__void/queue do not work if this entry calls\n' +
            '         handle() from @astrojs/cloudflare/handler. To use them, call fetch() on the\n' +
            '         default export of @astrojs/cloudflare/entrypoints/server instead.',
        );
      }
      return false;
    }
    const claim = claims.get(middlewarePath);
    if (claim && existsSync(middlewarePath)) {
      // A restart: the server being replaced wrote this file and still holds it.
      claim.servers++;
      return true;
    }
    mkdirSync(dirname(middlewarePath), { recursive: true });
    writeFileSync(middlewarePath, astroMiddlewareSource(frameworkTriggersDispatchPath(root)));
    if (claim) {
      // Removed while the server being replaced still holds it.
      claim.servers++;
    } else {
      claims.set(middlewarePath, {
        servers: 1,
        gitignoreLines: ensureGitignoreLines(root, [ASTRO_MIDDLEWARE_RELATIVE]),
      });
    }
    return true;
  };

  const release = () => {
    const claim = claims.get(middlewarePath);
    if (!claim || --claim.servers > 0) {
      return;
    }
    claims.delete(middlewarePath);
    rmSync(middlewarePath, { force: true });
    removeGitignoreLines(root, claim.gitignoreLines);
  };

  return {
    name: 'void:astro-dev-trigger-inject',
    apply: 'serve',
    configureServer(server) {
      if (!ensureFile()) {
        return;
      }
      // One release per dev server. Vite's own restart (after an .env edit) sets up this same
      // plugin for the new server before it closes the old one.
      let held = true;
      const cleanup = () => {
        if (held) {
          held = false;
          release();
        }
      };
      server.httpServer?.once('close', cleanup);
      process.once('exit', cleanup);
    },
  };
}
