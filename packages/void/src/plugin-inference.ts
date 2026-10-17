import { existsSync, readFileSync } from 'node:fs';
import { join, relative, toSlash } from 'pathslash';
import { globSync } from 'tinyglobby';
import { applyBindingOverrides } from './application-features.ts';
import { inferBindingsFromSource, mergeBindings, type InferredBindings } from './inference/walk.ts';
import { readProjectPaths, type ProjectPaths } from './project-paths.ts';
import {
  isRouteEnabledForEnvironment,
  parseRouteFilename,
  parseWebSocketFilename,
  type RouteEnvironment,
} from './router/parse-filename.ts';
import { isWebSocketPatternFile } from './router/websocket.ts';
import { getSsrServerEntryPath } from './ssr/entry.ts';

const SOURCE_GLOB = '**/*.{ts,tsx,mts,js,jsx,mjs,astro}';

/** Framework class determines integration depth. */
export type FrameworkClass = 'a' | 'b' | 'c';

export type DetectedFramework = {
  name: string;
  class: FrameworkClass;
};

/** Class A framework names (used for entry point lookup). */
export type Framework = 'tanstack-start' | 'react-router' | 'vinext-app' | 'vinext-pages';

/** Directories to scan for binding inference in framework mode. */
export const FRAMEWORK_SCAN_DIRS = [
  'src',
  'app',
  'pages',
  'routes',
  'server',
  'crons',
  'queues',
  'durable-objects',
] as const;

/**
 * Directories to scan for binding inference in Void app mode.
 *
 * `email` is included so a `sendEmail()` call from inside an inbound handler
 * (`email/<addr>.ts`) registers `needsEmail = true`. Otherwise the manifest
 * flag and the dev-inbox plugin would miss those callsites.
 */
export const DEFAULT_SCAN_DIRS = [
  'routes',
  'middleware',
  'queues',
  'pages',
  'crons',
  'email',
  'durable-objects',
  'src',
] as const;

/**
 * Map from npm package name to framework identifier.
 * Only packages that unambiguously indicate framework mode are listed.
 * For example, `react-router` alone is a client-side router — only
 * `@react-router/dev` signals the framework (Vite plugin) mode.
 */
const FRAMEWORK_PACKAGES: Record<string, DetectedFramework> = {
  '@tanstack/react-start': { name: 'tanstack-start', class: 'a' },
  '@react-router/dev': { name: 'react-router', class: 'a' },
  vinext: { name: 'vinext-pages', class: 'a' },
  '@sveltejs/kit': { name: 'sveltekit', class: 'b' },
  nuxt: { name: 'nuxt', class: 'c' },
  '@analogjs/platform': { name: 'analog', class: 'c' },
  astro: { name: 'astro', class: 'c' },
  '@pracht/adapter-cloudflare': { name: 'pracht', class: 'c' },
};

/**
 * Detect a meta-framework by checking package.json dependencies.
 * Returns the detected framework with class info, or `undefined`.
 */
export function detectFramework(root: string): DetectedFramework | undefined {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
  } catch {
    return undefined;
  }
  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };
  for (const [pkgName, framework] of Object.entries(FRAMEWORK_PACKAGES)) {
    if (pkgName in deps) {
      // vinext has two modes: App Router (app/ exists) vs Pages Router
      if (framework.name === 'vinext-pages' && existsSync(join(root, 'app'))) {
        return { name: 'vinext-app', class: 'a' };
      }
      return framework;
    }
  }
  return undefined;
}

export type InferenceOptions = {
  /** Explicit binding overrides — takes precedence over inference */
  bindings?: {
    db?: boolean | string;
    kv?: boolean | string;
    storage?: boolean | string;
    ai?: boolean | string;
    email?: boolean;
  };
  paths?: ProjectPaths;
  /** Filter route files for a Vite serve/build environment. Other source files are always scanned. */
  environment?: RouteEnvironment;
};

function extractAstroFrontmatter(code: string): string {
  const match = code.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match?.[1] ?? '';
}

function inferBindingsFromFile(file: string, code: string): InferredBindings {
  const filename = file.split('/').pop() ?? 'unknown.ts';
  if (!filename.endsWith('.astro')) {
    return inferBindingsFromSource(code, filename);
  }

  const frontmatter = extractAstroFrontmatter(code);
  const virtualFilename = filename.replace(/\.astro$/, '.ts');
  return inferBindingsFromSource(frontmatter, virtualFilename);
}

/**
 * Synchronously infer which Cloudflare bindings the project needs
 * by scanning route/middleware files and optional src/main.ssr.ts with oxc-parser.
 *
 * Without an environment this scans the full source superset, which is used
 * during plugin construction for binding-name reservation and plugin setup.
 *
 * @param scanDirs - Override the default scan directories (e.g., for framework mode)
 */
export function inferProjectBindings(
  root: string,
  options?: InferenceOptions,
  scanDirs?: ReadonlyArray<string>,
): InferredBindings {
  const paths = options?.paths ?? readProjectPaths(root);
  const dirs =
    scanDirs ?? (paths.sourceDir ? [paths.sourceDir, 'durable-objects'] : DEFAULT_SCAN_DIRS);
  const allBindings: Array<InferredBindings> = [];
  const scannedFiles = new Set<string>();
  const routesPrefix = `${toSlash(paths.routesDir).replace(/\/$/, '')}/`;
  const addFile = (file: string): void => {
    const normalizedFile = toSlash(file);
    if (scannedFiles.has(normalizedFile)) {
      return;
    }
    scannedFiles.add(normalizedFile);
    if (
      options?.environment &&
      normalizedFile.startsWith(routesPrefix) &&
      /\.(?:ts|mts|js|mjs)$/.test(normalizedFile)
    ) {
      const routePath = relative(paths.routesDir, normalizedFile);
      const route = isWebSocketPatternFile(routePath)
        ? parseWebSocketFilename(routePath)
        : parseRouteFilename(routePath);
      if (!isRouteEnabledForEnvironment(route, options.environment)) {
        return;
      }
    }
    const code = readFileSync(file, 'utf-8');
    allBindings.push(inferBindingsFromFile(file, code));
  };

  for (const dir of dirs) {
    const dirPath = join(root, dir);
    let files: Array<string>;
    try {
      files = globSync(SOURCE_GLOB, { cwd: dirPath, absolute: true });
    } catch {
      continue;
    }

    for (const file of files) {
      addFile(file);
    }
  }

  const ssrEntry = getSsrServerEntryPath(root, paths);
  if (ssrEntry) {
    addFile(ssrEntry);
  }

  // Custom scan directories should still see client/auth helpers and colocated
  // server-only modules under src/.
  const dirsSet = new Set(dirs);
  const srcRel = paths.sourceDir ? paths.sourceDir : 'src';
  if (!dirsSet.has(srcRel)) {
    const srcPath = paths.sourceDir ? paths.sourceRoot : join(root, 'src');
    let srcFiles: Array<string>;
    try {
      srcFiles = globSync(SOURCE_GLOB, { cwd: srcPath, absolute: true });
    } catch {
      srcFiles = [];
    }
    for (const file of srcFiles) {
      addFile(file);
    }
  }

  // Overrides apply to their named binding only. Setting KV must not suppress
  // auth, Sandbox, queues, or any other feature found in the same application.
  return applyBindingOverrides(mergeBindings(allBindings), options?.bindings);
}
