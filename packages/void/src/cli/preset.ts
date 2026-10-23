import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'pathslash';
import { readProjectPaths, type ProjectPaths } from '../project-paths.ts';
import {
  getPackageDependencies,
  hasPackageDependency,
  readPackageJson,
} from '../shared/package-json.ts';
import { getSsrServerEntryPath, hasSsrEntry } from '../ssr/entry.ts';

/** Build output conventions for a known SSG (static site generator). */
export type SsgPreset = {
  /** Package name to detect in package.json dependencies. */
  dep: string;
  /** Default build command (binary name — localBin resolves the full path). */
  buildCommand: string;
  /** Default output directory, relative to project root. */
  outputDir: string;
  /** App type for the deploy manifest. */
  appType: 'static' | 'spa';
  /** Optional project-aware overrides. */
  resolve?: (root: string) => Partial<Pick<StaticPreset, 'buildCommand' | 'outputDir'>> | undefined;
};

/**
 * Known output conventions for SSGs.
 * Keyed by the SSG name — detection iterates in insertion order.
 */
export const SSG_PRESETS: Record<string, SsgPreset> = {
  vitepress: {
    dep: 'vitepress',
    buildCommand: 'vitepress build',
    outputDir: '.vitepress/dist',
    appType: 'static',
    resolve(root) {
      if (existsSync(join(root, 'docs/.vitepress'))) {
        return {
          buildCommand: 'vitepress build docs',
          outputDir: 'docs/.vitepress/dist',
        };
      }
    },
  },
  docusaurus: {
    dep: '@docusaurus/core',
    buildCommand: 'docusaurus build',
    outputDir: 'build',
    appType: 'static',
  },
};

/** Build output conventions for a meta-framework. */
export type FrameworkPreset = {
  /** How native Cloudflare deployment obtains the Wrangler artifact. */
  cloudflareArtifact: 'vite-plugin' | 'worker-output';
  /** Compatibility flags required by a standalone framework Worker. */
  cloudflareCompatibilityFlags?: ReadonlyArray<string>;
  /** Default build command (overridable via void.config.ts `build`). */
  buildCommand: string;
  /** Directory containing the worker entry, relative to project root. */
  workerDir: string;
  /** Worker entry module filename within workerDir. */
  workerMain: string;
  /** Directory containing static assets, relative to project root. */
  assetsDir: string;
  /** URL-level prefix for hashed/immutable assets (used by dispatch for cache headers + edge cache keys). */
  hashedAssetsPrefix?: string;
  /** Whether the worker entry needs bundling (bare imports not resolved by framework build). */
  bundle?: boolean;
  /** Assets `html_handling`; Cloudflare's default applies when unset. */
  htmlHandling?: 'auto-trailing-slash' | 'force-trailing-slash' | 'drop-trailing-slash' | 'none';
};

/**
 * Known output conventions for meta-frameworks.
 * Keyed by the framework name from `detectFramework()`.
 *
 * Class A frameworks (tanstack-start, react-router, vinext) use the project's
 * Vite-compatible build command (`vite build` or `vp build`) and have their
 * output structure determined by the framework's Vite plugin.
 *
 * Class B/C frameworks (sveltekit, nuxt, analog, astro, pracht) use their own build CLI
 * and have framework-specific output conventions.
 */
export const FRAMEWORK_PRESETS: Record<string, FrameworkPreset> = {
  // Class A
  'tanstack-start': {
    cloudflareArtifact: 'vite-plugin',
    buildCommand: 'vite build',
    workerDir: 'dist/server',
    workerMain: 'index.js',
    assetsDir: 'dist/client',
  },
  'react-router': {
    cloudflareArtifact: 'vite-plugin',
    buildCommand: 'vite build',
    workerDir: 'build/server',
    workerMain: 'index.js',
    assetsDir: 'build/client',
  },
  'vinext-app': {
    cloudflareArtifact: 'vite-plugin',
    buildCommand: 'vite build',
    workerDir: 'dist/server',
    workerMain: 'index.js',
    assetsDir: 'dist/client',
  },
  'vinext-pages': {
    cloudflareArtifact: 'vite-plugin',
    buildCommand: 'vite build',
    workerDir: 'dist/ssr',
    workerMain: 'index.js',
    assetsDir: 'dist/client',
  },
  // Class B/C
  sveltekit: {
    cloudflareArtifact: 'worker-output',
    cloudflareCompatibilityFlags: ['nodejs_als'],
    buildCommand: 'vite build',
    workerDir: '.svelte-kit/cloudflare',
    workerMain: '_worker.js',
    assetsDir: '.svelte-kit/cloudflare',
    hashedAssetsPrefix: '_app/immutable',
    bundle: true,
  },
  nuxt: {
    cloudflareArtifact: 'worker-output',
    cloudflareCompatibilityFlags: ['nodejs_als'],
    buildCommand: 'nuxt build',
    workerDir: '.output/server',
    workerMain: 'index.mjs',
    assetsDir: '.output/public',
    hashedAssetsPrefix: '_nuxt',
  },
  analog: {
    cloudflareArtifact: 'worker-output',
    cloudflareCompatibilityFlags: ['nodejs_compat', 'nodejs_als'],
    buildCommand: 'vite build',
    workerDir: 'dist/analog/server',
    workerMain: 'index.mjs',
    assetsDir: 'dist/analog/public',
    hashedAssetsPrefix: 'assets',
  },
  astro: {
    cloudflareArtifact: 'worker-output',
    cloudflareCompatibilityFlags: ['nodejs_als'],
    buildCommand: 'astro build',
    workerDir: 'dist/server',
    workerMain: 'entry.mjs',
    assetsDir: 'dist/client',
    hashedAssetsPrefix: '_astro',
  },
  pracht: {
    cloudflareArtifact: 'worker-output',
    cloudflareCompatibilityFlags: ['nodejs_als'],
    buildCommand: 'pracht build',
    workerDir: 'dist/server',
    workerMain: 'worker.js',
    assetsDir: 'dist/client',
    hashedAssetsPrefix: 'assets',
    // pracht links to `/about`, not `/about/`.
    htmlHandling: 'drop-trailing-slash',
  },
};

export type StaticPreset = {
  buildCommand: string | null;
  outputDir: string;
  appType: 'spa' | 'static';
};

/**
 * Resolve a project-local command, rewriting `vite` to `vp` when the project
 * depends on Vite+ and preferring node_modules/.bin when available.
 */
export function resolveProjectCommand(root: string, command: string): string {
  const [bin, ...args] = command.trim().split(/\s+/);
  const resolvedBin = shellQuoteExecutable(localBin(root, resolveCommandBin(root, bin)));
  return args.length > 0 ? `${resolvedBin} ${args.join(' ')}` : resolvedBin;
}

/**
 * Shell-quote a resolved executable path so it survives being concatenated into
 * a command string. The deploy path runs these via `execSync`/`spawnSync`,
 * which invoke a shell, so a bare absolute path containing a space (e.g. a
 * project root like `/tmp/my app`) would be word-split by the shell and try to
 * exec the wrong binary. Paths with no shell-significant characters are returned
 * unchanged, so ordinary paths stay byte-identical and copy-pasteable; only the
 * executable segment is quoted (the trailing subcommand args are known-safe
 * tokens). Platform-aware: cmd.exe (Windows) uses double quotes, POSIX shells
 * use single quotes.
 */
function shellQuoteExecutable(value: string): string {
  if (process.platform === 'win32') {
    // cmd.exe: wrap in double quotes when the path contains a space or a shell
    // metacharacter. Windows filenames cannot contain `"`, so there is no
    // embedded quote to escape.
    return /[\s&|<>^()"]/.test(value) ? `"${value}"` : value;
  }
  // POSIX sh: characters in the safe set need no quoting; otherwise single-quote
  // the path and escape any embedded single quote as '\''.
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Resolve the bundled cf transport without consulting project dependencies. */
export function resolveCloudflareOperationArgv(): Array<string> {
  const directory = dirname(fileURLToPath(import.meta.url));
  const entry = [
    join(directory, 'cloudflare-operation-process.ts'),
    join(directory, 'cloudflare-operation-process.mjs'),
    join(directory, 'cli', 'cloudflare-operation-process.mjs'),
  ].find((candidate) => existsSync(candidate));
  if (!entry) {
    throw new Error(
      `Void's bundled Cloudflare tooling is unavailable. Reinstall the project's dependencies from its trusted lockfile, then retry.`,
    );
  }
  return [process.execPath, entry];
}

/**
 * Format a user-facing command string, rewriting `vite` to `vp` when the
 * project depends on Vite+ without expanding to an absolute local bin path.
 */
export function formatProjectCommand(root: string, command: string): string {
  const [bin, ...args] = command.trim().split(/\s+/);
  const formattedBin = resolveCommandBin(root, bin);
  return args.length > 0 ? `${formattedBin} ${args.join(' ')}` : formattedBin;
}

/**
 * Detect a static deploy preset based on the project root.
 * Returns null when the project requires a full worker deploy.
 *
 * `strictBackend` refuses (throws) instead of returning an SSG preset when the
 * project ALSO has backend sources. SSG detection (step 2) deliberately runs
 * before the backend check (step 3), so without this an SSG repo that grew a
 * single `routes/api/*.ts` would deploy as a pure static site with the backend
 * silently dropped and no diagnostic. Opt-in because only the UNCONFIGURED
 * auto-detect path is ambiguous: `--dir` and a configured
 * `inference.appType: "static" | "spa"` are the user stating what they want, and
 * must keep working silently.
 */
export function detectPreset(
  root: string,
  options?: { dir?: string; spa?: boolean; strictBackend?: boolean },
): StaticPreset | null {
  // 1. Explicit --dir flag: skip build, use provided directory
  if (options?.dir) {
    return {
      buildCommand: null,
      outputDir: resolve(root, options.dir),
      appType: options.spa ? 'spa' : 'static',
    };
  }

  // 2. Known SSG detected
  const pkg = readPackageJson(root);
  if (pkg) {
    const allDeps = getPackageDependencies(pkg);
    for (const preset of Object.values(SSG_PRESETS)) {
      if (preset.dep in allDeps) {
        if (options?.strictBackend) {
          const backendSources = findBackendSources(root);
          if (backendSources.length > 0) {
            throw new Error(ssgWithBackendMessage(preset.dep, backendSources));
          }
        }
        const overrides = preset.resolve?.(root);
        const cmd = overrides?.buildCommand ?? preset.buildCommand;
        const out = overrides?.outputDir ?? preset.outputDir;
        return {
          buildCommand: resolveProjectCommand(root, cmd),
          outputDir: resolve(root, out),
          appType: preset.appType,
        };
      }
    }
  }

  // 3. Has backend files → full deploy
  if (hasBackendFiles(root)) {
    return null;
  }

  // 4. Vite/Vite+ in deps → static SPA
  if (pkg && hasViteLike(pkg)) {
    const buildCommand = resolveProjectScriptCommand(root, 'build');
    return {
      buildCommand: buildCommand ?? resolveProjectCommand(root, 'vite build'),
      outputDir: resolve(root, 'dist'),
      appType: 'spa',
    };
  }

  // 5. No build tool — look for pre-built output
  if (existsSync(join(root, 'dist/index.html'))) {
    return {
      buildCommand: null,
      outputDir: resolve(root, 'dist'),
      appType: options?.spa ? 'spa' : 'static',
    };
  }

  if (existsSync(join(root, 'index.html'))) {
    return {
      buildCommand: null,
      outputDir: root,
      appType: options?.spa ? 'spa' : 'static',
    };
  }

  return null;
}

/**
 * The refusal shown when an SSG project also carries backend sources and no
 * `inference.appType` says which one to deploy. Names the exact directories
 * found and both ways out.
 */
function ssgWithBackendMessage(ssgDep: string, backendSources: Array<string>): string {
  return [
    `deploy: "${ssgDep}" was detected, but this project also has backend code: ${backendSources.join(', ')}.`,
    'A static deploy would silently drop it, so Void will not guess. Pick one in void.config.ts:',
    '',
    '  Deploy the static output only (the backend is NOT deployed):',
    '    { "inference": { "appType": "static" } }',
    '',
    '  Deploy both — the SSG emits the site, then Void packages it with the worker:',
    '    { "inference": { "appType": "void", "build": "<ssg> build && vite build" } }',
    '    ...and in vite.config.ts add voidPlugin() plus `publicDir: "<ssg output dir>"`,',
    '    so the generated site is copied into the client build alongside the worker.',
  ].join('\n');
}

/**
 * Resolve a local node_modules/.bin executable path.
 * Falls back to bare command name if the bin doesn't exist locally.
 */
function localBin(root: string, name: string): string {
  const bin = join(root, 'node_modules', '.bin', name);
  return existsSync(bin) ? bin : name;
}

function resolveCommandBin(root: string, name: string): string {
  if (name === 'vite') {
    return detectViteBinary(root);
  }
  return name;
}

function detectPackageManager(root: string): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (existsSync(join(root, 'yarn.lock'))) {
    return 'yarn';
  }
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) {
    return 'bun';
  }
  return 'npm';
}

function resolveProjectScriptCommand(root: string, scriptName: string): string | null {
  const pkg = readPackageJson(root);
  const script = pkg?.scripts;
  if (!script || typeof script !== 'object' || Array.isArray(script)) {
    return null;
  }
  if (typeof (script as Record<string, unknown>)[scriptName] !== 'string') {
    return null;
  }

  switch (detectPackageManager(root)) {
    case 'pnpm':
      return `pnpm ${scriptName}`;
    case 'yarn':
      return `yarn ${scriptName}`;
    case 'bun':
      return `bun run ${scriptName}`;
    default:
      return `npm run ${scriptName}`;
  }
}

function hasViteLike(pkg: Record<string, unknown>): boolean {
  return hasPackageDependency(pkg, 'vite') || hasPackageDependency(pkg, 'vite-plus');
}

function detectViteBinary(root: string): 'vite' | 'vp' {
  const pkg = readPackageJson(root);
  if (pkg && hasPackageDependency(pkg, 'vite-plus')) {
    return 'vp';
  }
  return 'vite';
}

/**
 * Every backend source in the project that requires a full worker deploy, named
 * relative to the root (e.g. `routes/`, `src/main.ssr.tsx`).
 *
 * Returned as a list rather than a boolean so a caller that has to REJECT a
 * static deploy can tell the user exactly what would have been dropped.
 */
export function findBackendSources(root: string): Array<string> {
  const paths = readProjectPaths(root);
  const found: Array<string> = [];
  for (const dir of backendDirs(paths)) {
    if (existsSync(dir)) {
      found.push(`${relative(root, dir)}/`);
    }
  }
  const ssrEntry = getSsrServerEntryPath(root, paths);
  if (ssrEntry) {
    found.push(relative(root, ssrEntry));
  }
  return found;
}

/**
 * Check whether the project has backend files that require a full worker deploy.
 */
export function hasBackendFiles(root: string): boolean {
  const paths = readProjectPaths(root);
  return backendDirs(paths).some((dir) => existsSync(dir)) || hasSsrEntry(root, paths);
}

function backendDirs(paths: ProjectPaths): Array<string> {
  return [
    paths.routesDir,
    paths.pagesDir,
    paths.middlewareDir,
    paths.cronsDir,
    paths.queuesDir,
    paths.emailDir,
  ];
}
