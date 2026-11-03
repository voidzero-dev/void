import { mkdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'pathslash';
import { writeFileIfChanged } from './codegen/write-if-changed.ts';
import { type DatabaseDialect, type NotFoundHandling } from './config.ts';
import { isViteBuildOrPreview } from './plugin-dev-config.ts';
import {
  frameworkTriggersDispatchPath,
  writeFrameworkTriggersDispatch,
} from './plugin-framework-triggers.ts';
import { type Framework } from './plugin-inference.ts';
import { compileAssetFallbackHelper } from './router/compile.ts';

/**
 * Resolve the server entry module for a Class A framework. We always wrap
 * the framework's own entry with a tiny shim that intercepts
 * `/__void/{scheduled,queue}` in dev so cron and queue handlers run with
 * the worker's full CF bindings. `vite build` gets a dispatch-free shim
 * (see `generateClassATriggerWrapper`). Production deploys go through
 * `cli/wrapper.ts` instead.
 */
export function getFrameworkEntry(
  framework: Framework,
  root: string,
  devTriggerToken: string,
  dialect: DatabaseDialect,
  notFound?: NotFoundHandling,
  configuredMain?: unknown,
): string {
  const isBuild = isViteBuildOrPreview();
  // In dev, eagerly write the dispatch file so the wrapper's dynamic
  // import resolves on the very first request (the plugin's
  // `configResolved` hook also rewrites it, but we can't rely on that
  // having run before the first request hits the worker). The build
  // wrapper does not reference it, so it is not written there.
  if (!isBuild) {
    writeFrameworkTriggersDispatch(root, devTriggerToken);
  }
  return generateClassATriggerWrapper(
    root,
    framework,
    getOriginalFrameworkEntry(framework, root, configuredMain),
    isBuild,
    dialect,
    undefined,
    notFound,
  );
}

const TANSTACK_SERVER_ENTRY = '@tanstack/react-start/server-entry';

/**
 * Whether `main` names a file in the app rather than a package. A migrated TanStack config keeps
 * `main: "@tanstack/react-start/server-entry"`, and a package subpath may end in `.js`, so a
 * bare name counts as a file only when it exists in the app.
 */
function isFileEntry(root: string, main: string): boolean {
  if (main.startsWith('.') || isAbsolute(main)) {
    return true;
  }
  return statSync(resolve(root, main), { throwIfNoEntry: false })?.isFile() === true;
}

/** The framework's own server entry, before our trigger wrapper. */
export function getOriginalFrameworkEntry(
  framework: Framework,
  root: string,
  configuredMain?: unknown,
): string {
  switch (framework) {
    case 'tanstack-start': {
      if (
        configuredMain === undefined ||
        configuredMain === TANSTACK_SERVER_ENTRY ||
        configuredMain === `${TANSTACK_SERVER_ENTRY}.js`
      ) {
        return TANSTACK_SERVER_ENTRY;
      }
      if (typeof configuredMain !== 'string' || configuredMain.trim() === '') {
        throw new Error('config: cloudflare.main must be a non-empty Worker entry path.');
      }
      if (!isFileEntry(root, configuredMain)) {
        return configuredMain;
      }
      const original = resolve(root, configuredMain);
      if (original === resolve(root, '.void', 'tanstack-start-trigger-wrapper.ts')) {
        throw new Error(
          "config: cloudflare.main cannot point to Void's generated framework wrapper.",
        );
      }
      return original;
    }
    case 'react-router':
      return generateReactRouterEntry(root);
    case 'vinext-app':
      return 'vinext/server/app-router-entry';
    case 'vinext-pages':
      return generateVinextPagesEntry(root);
  }
}

/**
 * Generate `<root>/.void/<framework>-trigger-wrapper.ts`. This file becomes
 * `workerConfig.main` so the dev miniflare/workerd evaluates *our* fetch
 * first, dispatches `/__void/{scheduled,queue}` if it matches, and otherwise
 * delegates to the framework's original entry.
 *
 * For PostgreSQL and MySQL, both shapes run the framework inside Void's request scope
 * (`withRuntimeEnv`), as Void's own handlers do, so void/db keeps one client per request. D1 apps
 * keep the framework's own fetch: in a request scope, void/db reads D1 through a replica-capable
 * session instead of the primary.
 *
 * We emit two shapes of the wrapper depending on the Vite command:
 *
 * - Serve: dispatch is dynamically imported and gets a chance to handle
 *   `/__void/{scheduled,queue}` before falling through to the framework.
 * - Build: dispatch is omitted entirely. The wrapper just delegates fetch.
 *
 * We can't simply gate the dynamic import on `import.meta.env.DEV` and
 * trust DCE: rolldown emits chunks for dynamic imports during chunk
 * splitting, *before* constant folding removes the dead branch, so the
 * dispatch file (and its transitive user-cron/queue imports + dev token)
 * would still ship in the production bundle.
 */
export function generateClassATriggerWrapper(
  root: string,
  framework: Framework,
  original: string,
  isBuild: boolean,
  dialect: DatabaseDialect,
  assetsDir = 'assets',
  /**
   * Resolved `assetConfig.not_found_handling`. A Class A app deploys through
   * `runFullDeploy`, which honors `routing.notFound`, so this wrapper's
   * `serveWithAssets` has to honor it too or the asset binding's 404 page is
   * fetched and then thrown away.
   */
  notFound?: NotFoundHandling,
): string {
  const outDir = join(root, '.void');
  mkdirSync(outDir, { recursive: true });
  const wrapperPath = join(outDir, `${framework}-trigger-wrapper.ts`);
  const fetchBody = isBuild
    ? `    return serveWithAssets(request, env, await original.fetch(request, env, ctx));`
    : `    if (request.method === "POST") {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/__void/scheduled" || pathname === "/__void/queue") {
        const { handleDevTrigger } = await import(${JSON.stringify(frameworkTriggersDispatchPath(root))});
        const response = await handleDevTrigger(request, env, ctx);
        if (response) return response;
      }
    }
    return original.fetch(request, env, ctx);`;
  const scoped = dialect !== 'sqlite';
  const fetchMethod = scoped
    ? `  fetch(request, env, ctx) {
    return withRuntimeEnv(env, async () => {
${fetchBody.replace(/^/gm, '  ')}
    });
  },`
    : `  async fetch(request, env, ctx) {
${fetchBody}
  },`;
  const body = `// @ts-nocheck — Auto-generated by Void ${isBuild ? 'for vite build' : 'in dev'}. Do NOT edit.
import original from ${JSON.stringify(original)};
export * from ${JSON.stringify(original)};
${scoped ? 'import { withRuntimeEnv } from "void/_env";\n' : ''}
export default {
  ...original,
${fetchMethod}
};
${isBuild ? `${compileAssetFallbackHelper(assetsDir, false, notFound)}\n` : ''}`;
  writeFileIfChanged(wrapperPath, body);
  return wrapperPath;
}

/** Generate a worker entry for vinext Pages Router projects. */
function generateVinextPagesEntry(root: string): string {
  const outDir = join(root, '.void');
  mkdirSync(outDir, { recursive: true });
  const entryPath = join(outDir, 'vinext-pages-entry.ts');
  writeFileIfChanged(
    entryPath,
    `// Auto-generated by Void — vinext Pages Router worker entry
// @ts-expect-error virtual module resolved by vinext at build time
import { renderPage, handleApiRoute } from "virtual:vinext-server-entry";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname.replaceAll("\\\\", "/").startsWith("//")) {
      return new Response("404 Not Found", { status: 404 });
    }
    const urlWithQuery = pathname + url.search;
    if (pathname.startsWith("/api/") || pathname === "/api") {
      return await handleApiRoute(request, urlWithQuery);
    }
    return await renderPage(request, urlWithQuery, null);
  },
};
`,
  );
  return entryPath;
}

/** Generate a worker entry for React Router v7 projects. */
function generateReactRouterEntry(root: string): string {
  const outDir = join(root, '.void');
  mkdirSync(outDir, { recursive: true });
  const entryPath = join(outDir, 'react-router-entry.ts');
  writeFileIfChanged(
    entryPath,
    `// Auto-generated by Void — React Router v7 worker entry
import { createRequestHandler } from "react-router";

const requestHandler = createRequestHandler(
  // @ts-expect-error virtual module resolved by @react-router/dev at build time
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request: Request): Promise<Response> {
    return requestHandler(request);
  },
};
`,
  );
  return entryPath;
}
