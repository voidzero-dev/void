import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join, relative } from 'pathslash';
import type { Plugin } from 'vite';
import { findInstalledPackage, findVoidDependentPackages } from './installed-packages.ts';
import { readProjectPaths } from './project-paths.ts';

/** Imports that require CF bindings and are not available in Node.js mode. */
export const CF_ONLY_IMPORTS: Array<string> = [
  'void/db',
  'void/kv',
  'void/auth',
  'void/storage',
  'void/ai',
  'void/sandbox',
  'void/env',
];

const CF_ONLY_REGEX = new RegExp(
  `^(${CF_ONLY_IMPORTS.map((s) => s.replace('/', '\\/')).join('|')})$`,
);

type NodeTarget = 'node' | 'bun' | 'deno';

/**
 * Bridge Node.js HTTP to Web API and serve via a Hono app.
 * Used by both dev server and preview server middleware.
 */
function honoMiddleware(
  getApp: () => Promise<{ fetch: (req: Request) => Promise<Response> } | null>,
) {
  return async (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    try {
      // Let Vite handle its own internal requests (HMR, modules, etc.)
      if (
        !req.url ||
        req.url.startsWith('/@') ||
        req.url.startsWith('/__') ||
        req.url.startsWith('/node_modules/')
      ) {
        next();
        return;
      }

      const app = await getApp();
      if (!app?.fetch) {
        next();
        return;
      }

      // Build a Request from the incoming Node.js http.IncomingMessage
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) {
          headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
      }

      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(url.toString(), {
        method: req.method,
        headers,
        body: hasBody ? (req as unknown as BodyInit) : undefined,
        // @ts-ignore Node.js specific
        duplex: hasBody ? 'half' : undefined,
      });

      const response = await app.fetch(request);

      // If Hono returned 404 (no matching route), fall through to Vite
      // so static assets and dev-time resources are served normally.
      if (response.status === 404) {
        next();
        return;
      }

      // Write the Response back to Node.js http.ServerResponse
      res.statusCode = response.status;
      response.headers.forEach((value: string, key: string) => {
        res.setHeader(key, value);
      });

      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          res.write(value);
        }
        res.end();
      } else {
        res.end();
      }
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Vite plugin for non-Cloudflare deploy targets (Node.js, Bun, Deno).
 *
 * Replaces `@cloudflare/vite-plugin` in the plugin composition. Provides:
 * 1. Binding guard — compile-time errors for CF-only void/* imports
 * 2. Dev server — Vite SSR middleware to run Hono in Node.js
 * 3. Preview server — serves from the built SSR entry
 * 4. Build — dual-environment build (client + SSR) for pages apps,
 *    single SSR build for API-only apps
 */
export function nodeTargetPlugin(target: NodeTarget): Array<Plugin> {
  const unavailable = (id: string, root: string, importer: string | undefined) => {
    // The import can come from an installed package, so name the file.
    const source = importer ? ` Imported by ${relative(root, importer)}.` : '';
    return new Error(
      `target: '${id}' is not available with target '${target}'. ` +
        `CF bindings require target: "cloudflare".${source}`,
    );
  };

  const guardPlugin: Plugin = {
    name: 'void:node-target',
    enforce: 'pre',

    resolveId: {
      filter: { id: CF_ONLY_REGEX },
      handler(id, importer) {
        throw unavailable(id, this.environment.config.root, importer);
      },
    },

    renderChunk(code, chunk) {
      if (!code.includes('import.meta.voidClientDirectory')) {
        return null;
      }
      // app.js may re-export a shared module under assets/. Compute from the
      // actual emitted chunk rather than the source entry or process cwd.
      const clientPath = relative(dirname(chunk.fileName), '../client');
      return {
        code: code.replaceAll(
          'import.meta.voidClientDirectory',
          `new URL(${JSON.stringify(`${clientPath}/`)}, import.meta.url)`,
        ),
        map: null,
      };
    },

    config(_, { command }) {
      const root = process.cwd();
      // Vite's SSR graph leaves a bare import that resolves into node_modules to Node before
      // any plugin sees it. An installed void would then skip the guard above, and in a build
      // the app's `void/handler` would load beside the copy that the generated routes bundle,
      // so its ValidationError is not the class the routes check. Inline void, its adapters
      // and installed packages that import void in the dev server, Vitest and the build alike,
      // as with a workspace link.
      const ssr = {
        noExternal: ['void', /^@void\//, ...findVoidDependentPackages(root)],
      };
      if (command !== 'build') {
        return { ssr };
      }

      const voidDir = join(root, '.void');
      const ssrBuildOptions = {
        outDir: 'dist/ssr',
        rollupOptions: {
          input: {
            app: join(voidDir, 'app.ts'),
            index: join(voidDir, 'index.ts'),
          },
          external: [/^node:/, '@hono/node-server', '@hono/node-server/serve-static'],
        },
      };

      // Pages apps need dual builds: client (React hydration) + SSR (server entry).
      // API-only apps need a single SSR build.
      if (existsSync(readProjectPaths(root).pagesDir)) {
        return {
          ssr,
          build: { outDir: 'dist/client' },
          environments: {
            ssr: { build: ssrBuildOptions },
          },
          // Opt into Vite's multi-environment builder (without this,
          // Vite uses the legacy single-environment builder).
          builder: {},
        };
      }

      return {
        ssr,
        build: {
          ssr: true,
          ...ssrBuildOptions,
        },
      };
    },

    // Orchestrate the builds. Vite runs this hook with either builder. API-only apps use
    // the legacy single-environment builder, which creates only the `ssr` environment.
    async buildApp(builder) {
      // SSR must build first so that dist/ssr/app.js exists when the
      // prerender plugin runs in the client environment's closeBundle hook.
      await builder.build(builder.environments.ssr);
      if (builder.environments.client) {
        await builder.build(builder.environments.client);
      }
    },

    configureServer(server) {
      // Middleware runs BEFORE Vite's built-in middleware so API routes
      // and SSR pages are handled before Vite's SPA fallback sends a 404.
      // The honoMiddleware helper skips /@, /__, and /node_modules/ paths
      // so Vite's HMR and module serving still work normally.
      server.middlewares.use(
        honoMiddleware(async () => {
          const mod = await server.ssrLoadModule('virtual:void-routes');
          return mod.default;
        }),
      );
    },

    configurePreviewServer(server) {
      // Import the built app module (not index.js which starts a server).
      const entryPath = join(process.cwd(), 'dist', 'ssr', 'app.js');
      let appPromise: Promise<{ fetch: (req: Request) => Promise<Response> } | null> | null = null;

      server.middlewares.use(
        honoMiddleware(() => {
          if (!appPromise) {
            const entryUrl = pathToFileURL(entryPath).href;
            appPromise = import(/* @vite-ignore */ entryUrl).then(
              (m) => m.default,
              () => null,
            );
          }
          return appPromise;
        }),
      );
    },
  };

  // The build bundles void, whose runtime loads `cloudflare:` modules with import() only when it
  // runs in workerd. Keep those external. Node cannot load a static one, so fail the build.
  const cloudflareModulesPlugin: Plugin = {
    name: 'void:node-target-cloudflare-modules',
    apply: 'build',
    enforce: 'pre',
    resolveId: {
      filter: { id: /^cloudflare:/ },
      handler(id, importer, options) {
        if (options.kind === 'dynamic-import') {
          return { id, external: true };
        }
        throw unavailable(id, this.environment.config.root, importer);
      },
    },
  };

  // void/og renders with takumi-js, which loads its renderer from files next to its own code (a
  // native addon on Node.js and Bun) that a bundle cannot carry. A build leaves a package that
  // resolves from the app root to the runtime, so the app must install a version that void/og
  // supports. With pnpm, void's own copy does not resolve from the root and would be bundled.
  const imageRendererPlugin: Plugin = {
    name: 'void:node-target-image-renderer',
    apply: 'build',
    enforce: 'pre',
    resolveId: {
      filter: { id: /^takumi-js(?:\/|$)/ },
      handler() {
        const range = readTakumiRange();
        const installed = findInstalledPackage('takumi-js', this.environment.config.root);
        const version = installed && readPackageVersion(installed);
        if (version && satisfiesCaret(version, range)) {
          return;
        }
        const found = version ? ` The app has takumi-js ${version}.` : '';
        throw new Error(
          `void/og needs takumi-js@${range} in your app's dependencies with target '${target}', so ` +
            `the build leaves it to ${RUNTIME_NAMES[target]}.${found} Install it, for example with ` +
            `\`npm install takumi-js@${range}\`.`,
        );
      },
    },
  };

  return [guardPlugin, cloudflareModulesPlugin, imageRendererPlugin];
}

const RUNTIME_NAMES: Record<NodeTarget, string> = {
  node: 'Node.js',
  bun: 'Bun',
  deno: 'Deno',
};

/** The takumi-js range void/og is built and tested against, from void's package.json. */
function readTakumiRange(): string {
  const manifest = findPackageJSON(import.meta.url);
  return readPackageManifest(manifest!).dependencies!['takumi-js']!;
}

function readPackageVersion(dir: string): string | undefined {
  return readPackageManifest(join(dir, 'package.json')).version;
}

function readPackageManifest(path: string): {
  version?: string;
  dependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Whether `version` is in the caret `range` (a major version above 0, as takumi-js uses). */
function satisfiesCaret(version: string, range: string): boolean {
  const parse = (value: string) => /^\^?(\d+)\.(\d+)\.(\d+)/.exec(value)?.slice(1).map(Number);
  const actual = parse(version);
  const minimum = parse(range);
  if (!actual || !minimum || actual[0] !== minimum[0]) {
    return false;
  }
  for (const part of [1, 2]) {
    if (actual[part] !== minimum[part]) {
      return actual[part]! > minimum[part]!;
    }
  }
  return true;
}
