import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import module from 'node:module';
import { dirname, join, normalize } from 'pathslash';
import { parseSync } from 'vite';
import { staticModuleReferences } from './shared/module-references.ts';

type PackageManifest = {
  readonly version?: string;
  readonly type?: string;
  readonly module?: unknown;
  readonly main?: unknown;
  readonly exports?: unknown;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
};

export function readManifest(dir: string): PackageManifest | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageManifest;
  } catch {
    return undefined;
  }
}

type PnpApi = { resolveToUnqualified(request: string, issuer: string): string | null };

/** The directory Node loads `name` from for code in `fromDir`. Ignores `exports`. */
export function findInstalledPackage(name: string, fromDir: string): string | undefined {
  // A Yarn Plug'n'Play install has no node_modules. Under `yarn`, its runtime adds
  // `findPnpApi` to `node:module` and serves the packages' files from its archives.
  const pnp = (module as { findPnpApi?: (path: string) => PnpApi | null }).findPnpApi?.(fromDir);
  if (pnp) {
    try {
      const manifest = pnp.resolveToUnqualified(`${name}/package.json`, `${fromDir}/`);
      return manifest ? dirname(manifest) : undefined;
    } catch {
      return undefined;
    }
  }
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) {
      return realpathSync(candidate);
    }
    if (dirname(dir) === dir) {
      return undefined;
    }
  }
}

function isVoidPackage(name: string): boolean {
  return name === 'void' || name.startsWith('@void/');
}

/** The `exports` conditions that an import matches in Vite's SSR graph. */
const IMPORT_CONDITIONS = new Set(['node', 'import', 'module', 'default']);

/**
 * Vite's SSR graph also matches `production` or `development`, as NODE_ENV says. Vite sets
 * NODE_ENV before it runs the plugin hooks that call this.
 */
function matchesImport(condition: string): boolean {
  const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development';
  return IMPORT_CONDITIONS.has(condition) || condition === mode;
}

/** The target an import picks from an `exports` value: its first matching key, as in Node. */
function importTarget(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = importTarget(item);
      if (target) {
        return target;
      }
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  for (const [key, item] of Object.entries(value)) {
    const target = matchesImport(key) ? importTarget(item) : undefined;
    if (target) {
      return target;
    }
  }
  return undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The file an import of the package loads: `exports` ".", then `module`, then `main`. */
function findImportEntry(dir: string, manifest: PackageManifest): string | undefined {
  const exports = manifest.exports;
  const root =
    exports &&
    typeof exports === 'object' &&
    Object.keys(exports).some((key) => key.startsWith('.'))
      ? (exports as Record<string, unknown>)['.']
      : exports;
  const entry =
    importTarget(root) ??
    (typeof manifest.module === 'string' ? manifest.module : undefined) ??
    (typeof manifest.main === 'string' ? manifest.main : 'index.js');
  // A `main` may leave out the extension or name a directory.
  for (const candidate of [entry, `${entry}.js`, `${entry}/index.js`]) {
    const file = join(dir, candidate);
    if (isFile(file)) {
      return file;
    }
  }
  return undefined;
}

/** Whether Node loads a `.mjs` or `.js` file in the package as an ES module. */
function isEsmFile(file: string, dir: string, manifest: PackageManifest): boolean {
  if (file.endsWith('.mjs')) {
    return true;
  }
  if (!file.endsWith('.js')) {
    return false;
  }
  // The nearest package.json sets the type, and a package can nest one in a subdirectory.
  for (let scope = dirname(file); scope.startsWith(`${dir}/`); scope = dirname(scope)) {
    const nested = readManifest(scope);
    if (nested) {
      return nested.type === 'module';
    }
  }
  return manifest.type === 'module';
}

/** A dynamic `import()` argument that is a single string literal naming a relative file. */
const RELATIVE_LITERAL = /^(["'])(\.{1,2}\/[^"']*)\1$/;

/** The relative files that a module's imports, re-exports and `import()` calls name. */
function relativeImports(code: string, parsed: ReturnType<typeof parseSync>): Array<string> {
  const specifiers = staticModuleReferences(parsed, code).map((reference) => reference.source);
  for (const { moduleRequest } of parsed.module.dynamicImports) {
    const literal = RELATIVE_LITERAL.exec(code.slice(moduleRequest.start, moduleRequest.end));
    if (literal) {
      specifiers.push(literal[2]!);
    }
  }
  return specifiers.filter((specifier) => /^\.{1,2}\//.test(specifier));
}

/** The most files of one package that the check reads. A package with more stays with Node. */
const MAX_PACKAGE_MODULES = 2000;

/**
 * Vite's SSR module runner evaluates an inlined package as ES modules. The package's import
 * entry and every file it reaches through relative imports must be one. So the ES module
 * wrapper in Node's dual-package guide, or any ES module of the package that imports a
 * CommonJS file, keeps the package with Node.
 */
function shipsEsm(packageDir: string, manifest: PackageManifest): boolean {
  const dir = normalize(packageDir);
  const entry = findImportEntry(dir, manifest);
  if (!entry) {
    return false;
  }
  const files = [entry];
  const seen = new Set(files);
  for (const file of files) {
    if (!isEsmFile(file, dir, manifest)) {
      return false;
    }
    let code: string;
    try {
      code = readFileSync(file, 'utf8');
    } catch {
      return false;
    }
    // Vite's SSR transform parses with the same parser and fails on any error, so the module
    // runner could not load a file that does not parse.
    const parsed = parseSync(file, code, { lang: 'js', sourceType: 'module' });
    if (parsed.errors.length > 0) {
      return false;
    }
    for (const specifier of relativeImports(code, parsed)) {
      const next = join(dirname(file), specifier);
      if (/\.[cm]?js$/.test(next) && !seen.has(next)) {
        if (seen.size >= MAX_PACKAGE_MODULES) {
          return false;
        }
        seen.add(next);
        files.push(next);
      }
    }
  }
  return true;
}

/**
 * Installed ES module packages that list `void` or an `@void/` package as a dependency, among
 * the app's own dependencies and, through them, the packages they depend on (the rule
 * vite-plugin-svelte applies to Svelte libraries). Vite leaves a package in node_modules to Node,
 * whose `void/*` imports then skip Void's plugins: the generated `void/db` and the Node target's
 * guard. Listing these packages in `ssr.noExternal` keeps them in Vite's graph.
 */
export function findVoidDependentPackages(root: string): Array<string> {
  const app = readManifest(root);
  if (!app) {
    return [];
  }
  const found = new Set<string>();
  const seen = new Set<string>();
  const visit = (names: Iterable<string>, fromDir: string) => {
    for (const name of names) {
      if (isVoidPackage(name)) {
        continue;
      }
      const dir = findInstalledPackage(name, fromDir);
      if (!dir || seen.has(dir)) {
        continue;
      }
      seen.add(dir);
      const manifest = readManifest(dir);
      const dependencies = {
        ...manifest?.dependencies,
        ...manifest?.optionalDependencies,
      };
      if (
        !manifest ||
        !Object.keys({ ...dependencies, ...manifest.peerDependencies }).some(isVoidPackage) ||
        !shipsEsm(dir, manifest)
      ) {
        continue;
      }
      found.add(name);
      visit(Object.keys(dependencies), dir);
    }
  };
  visit(
    Object.keys({ ...app.dependencies, ...app.devDependencies, ...app.optionalDependencies }),
    root,
  );
  return [...found].sort();
}

/** `name` and every package it depends on, as installed for code in `fromDir`. */
export function findDependencyClosure(name: string, fromDir: string): Array<string> {
  const found = new Set<string>();
  const seen = new Set<string>();
  const visit = (dependency: string, from: string) => {
    const dir = findInstalledPackage(dependency, from);
    if (!dir || seen.has(dir)) {
      return;
    }
    seen.add(dir);
    found.add(dependency);
    const manifest = readManifest(dir);
    for (const next of Object.keys({
      ...manifest?.dependencies,
      ...manifest?.optionalDependencies,
    })) {
      visit(next, dir);
    }
  };
  visit(name, fromDir);
  return [...found].sort();
}
