import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'pathslash';
import type { Plugin, PluginOption, ViteDevServer } from 'vite';
import { voidWarn } from './log.ts';

/**
 * Whether Vite is resolving the server that Vitest creates to run tests, whatever its `--mode`.
 * Vitest adds its own plugins (`vitest`, `vitest:*`) to that server's config; a server that a
 * test starts through Vite's API has none. Vitest runs test files in Node.js, so Void starts no
 * Worker there, applies no local migrations and asks no questions. Check these names again when
 * updating Vitest: `test/integration/vitest-app.test.ts` runs the tests of Void apps.
 */
export function isVitestServer(config: {
  readonly plugins?: ReadonlyArray<PluginOption>;
}): boolean {
  const pending = [...(config.plugins ?? [])];
  while (pending.length > 0) {
    const plugin = pending.pop();
    if (Array.isArray(plugin)) {
      pending.push(...plugin);
    } else if (
      plugin &&
      'name' in plugin &&
      typeof plugin.name === 'string' &&
      (plugin.name === 'vitest' || plugin.name.startsWith('vitest:'))
    ) {
      return true;
    }
  }
  return false;
}

/** Run `fn` shortly after Vite prints "ready" so dev messages stay visible. */
export function afterServerReady(server: ViteDevServer, fn: () => void): void {
  if (server.httpServer) {
    server.httpServer.once('listening', () => setTimeout(fn, 100));
  } else {
    fn();
  }
}

/**
 * Best-effort detection of `vite build` (and `vite preview`) so we can skip
 * dev-only side effects — writing the dev-trigger token and the dispatch
 * file — when no dev server will run. Vite's CLI passes the subcommand as
 * `process.argv[2]`; programmatic API users (and `vite` with no subcommand)
 * default to `dev`, which we detect as the absence of a build-shaped first
 * positional. This is intentionally permissive: when in doubt, we behave as
 * if we're in dev so first-request correctness is preserved.
 */
export function isViteBuildOrPreview(): boolean {
  const subcommand = process.argv[2];
  return subcommand === 'build' || subcommand === 'preview';
}

/**
 * Point Cloudflare remote bindings opened in this process at the login from
 * `void connect` and `void cloudflare login`. The Cloudflare Vite plugin and
 * Wrangler's platform proxy authenticate remote bindings here, in dev, preview
 * and build prerendering. They read cf's login only when `CLOUDFLARE_CF_AUTH`
 * is present (any value), and Wrangler's separate login otherwise. The keyring
 * flag selects the encrypted cf profile that Void's login writes. Environment
 * API tokens still take precedence, and the OAuth token stays in the store.
 */
export function selectVoidCloudflareLogin(): void {
  process.env.CLOUDFLARE_CF_AUTH = 'true';
  process.env.CLOUDFLARE_AUTH_USE_KEYRING = 'true';
}

const DEV_TRIGGER_TOKEN_FILE_MODE = 0o600;

/**
 * Persist the dev-trigger token at `<root>/.void/dev-trigger-token` so
 * every voidPlugin() invocation against the same project reads the same
 * value. This matters because `@cloudflare/vite-plugin` spawns a
 * worker-environment child Vite that re-imports vite.config.ts and calls
 * voidPlugin() again — without persistence the parent and child would
 * generate different UUIDs, the dispatch file would embed one and the
 * hint plugin would print the other, and curls would land on
 * `unauthorized`.
 *
 * The file persists across dev sessions and deploys so saved curl scripts
 * keep working. It lives under `.void/` (gitignored) and is safe to remove.
 *
 * The file is owner-only (0600). It is the one credential the dev-inbox
 * routes accept, and loopback is reachable by every account on the host,
 * so a default-umask 0644 file would hand any other local user the raw MIME,
 * the DELETE, and the capture endpoint. A file persisted by an earlier
 * release is tightened in place, never rotated. Windows has no group/other
 * bits — `mode` and `chmod` only toggle write there — so it is left alone.
 */
export function getOrCreateDevTriggerToken(root: string): string {
  const tokenPath = join(root, '.void', 'dev-trigger-token');
  const readExisting = (): string | undefined => {
    try {
      const existing = readFileSync(tokenPath, 'utf-8').trim();
      return existing.length > 0 ? existing : undefined;
    } catch {
      return undefined;
    }
  };
  // Best-effort: a token we can read but not chmod (foreign owner, read-only
  // mount) must still start the dev server.
  const tightenExisting = (): void => {
    if (process.platform === 'win32') {
      return;
    }
    try {
      if ((statSync(tokenPath).mode & 0o077) !== 0) {
        chmodSync(tokenPath, DEV_TRIGGER_TOKEN_FILE_MODE);
      }
    } catch {
      // ignore
    }
  };

  const existing = readExisting();
  if (existing) {
    tightenExisting();
    return existing;
  }

  // Atomic create — `wx` fails with EEXIST if the file appeared between the
  // read above and the write below (parent + child Vite both racing). On
  // EEXIST we re-read the winner's token and use that, so both processes
  // converge on the same UUID.
  mkdirSync(join(root, '.void'), { recursive: true });
  const fresh = crypto.randomUUID();
  try {
    const fd = openSync(tokenPath, 'wx', DEV_TRIGGER_TOKEN_FILE_MODE);
    try {
      writeSync(fd, fresh);
    } finally {
      closeSync(fd);
    }
    return fresh;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
    const winner = readExisting();
    if (winner) {
      return winner;
    }
    // EEXIST but file is empty — extreme edge case (interrupted writer).
    // Fall through and accept the fresh UUID; subsequent reads will win.
    return fresh;
  }
}

// Request paths that would return the dev-trigger token: `.void/dev-trigger-token`,
// the generated `.void/dev-triggers.ts`, Nitro's dev bundle (`.nuxt/dev/` for
// Nuxt, `dist/.nitro/dev/` for Analog), which inlines that module, and Astro's
// `.astro/dev.log`, which records the startup hint when `astro dev` runs in the
// background (`--background`, or started by a coding agent). Also
// `.void/drizzle.config.json`, where older CLI versions wrote database URLs.
// Matched anywhere in the decoded, lower-cased path so `/@fs/<abs>/`, `/@id/`,
// a base such as `/_nuxt/`, case-insensitive file systems, dot segments, `//`,
// `%2e`, `\` and Windows trailing dots/spaces all hit.
const DEV_TRIGGER_SECRET_PATH_RE =
  /(?:^|\/)\.void[. ]*\/(?:.*\/)?(?:dev-trigger|drizzle\.config\.json)|(?:^|\/)\.(?:nuxt|nitro)[. ]*\/(?:.*\/)?dev\/|(?:^|\/)\.astro[. ]*\/(?:.*\/)?dev\.log/;

export function isDevTriggerSecretRequest(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  let path = url.split(/[?#]/, 1)[0] ?? '';
  for (let i = 0; i < 3; i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      break;
    }
    if (decoded === path) {
      break;
    }
    path = decoded;
  }
  return DEV_TRIGGER_SECRET_PATH_RE.test(path.replaceAll('\\', '/').toLowerCase());
}

/**
 * Vite serves every root file that `server.fs.deny` does not list, and its default
 * CORS lets any localhost origin read the reply, so the files above would hand their
 * secrets to `--host` peers, other local accounts and other local dev servers.
 * `server.fs.deny` is not used: a plugin's list replaces Vite's defaults, and the
 * Cloudflare worker environment applies the same check when it imports
 * `.void/dev-triggers.ts`. The middleware is added in configureServer, so it runs
 * before Vite's transform, /@fs/ and static middlewares.
 */
export function devTriggerSecretGuardPlugin(): Plugin {
  return {
    name: 'void:dev-trigger-secret-guard',
    apply: 'serve',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!isDevTriggerSecretRequest(req.url)) {
          next();
          return;
        }
        res.statusCode = 404;
        res.end('Not Found');
      });
    },
  };
}

/**
 * Warn when the project's `package.json` does not declare `"type": "module"`.
 *
 * Vite's default `configLoader: "bundle"` bundles `vite.config.ts`,
 * externalizes deps, and then loads the bundle. When `package.json` is non-ESM
 * the bundle is written as `.js` and loaded via CJS `require()`, which throws
 * `ERR_REQUIRE_ASYNC_MODULE` if any externalized dep's ESM graph contains
 * top-level await. `@cloudflare/vite-plugin` (which voidPlugin pulls in) has
 * exactly such a TLA, so non-ESM consumers hit this on every Vite invocation.
 *
 * Runs once per Vite process (factory time), single sync read.
 */
export function warnIfPackageJsonIsNotEsm(root: string): void {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) {
    return;
  }
  let pkg: { type?: unknown };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    return;
  }
  if (pkg.type === 'module') {
    return;
  }
  voidWarn(
    'package.json is missing `"type": "module"`. Vite\'s default config loader ' +
      'will fail with ERR_REQUIRE_ASYNC_MODULE on transitive top-level await ' +
      '(e.g. @cloudflare/vite-plugin). Add `"type": "module"` to package.json, ' +
      'or run vite build with `--configLoader runner`.',
  );
}
