import { existsSync, readFileSync, realpathSync } from 'node:fs';
import nodeModule from 'node:module';
import type { ResolveHookSync } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync, transformSync } from 'esbuild';
import { createPathsMatcher, getTsconfig } from 'get-tsconfig';
import { createJiti } from 'jiti';
import { basename, dirname, extname, isAbsolute, join, toSlash } from 'pathslash';

export type SeedModuleImporter = (path: string) => Promise<Record<string, unknown>>;

export interface SeedModuleLoader {
  importModule: SeedModuleImporter;
  /** Remove the module hooks once the seed has finished. */
  close: () => void;
}

const DECLARATION_SUFFIXES = ['.d.ts', '.d.mts', '.d.cts'];
const TYPESCRIPT_SUFFIXES = ['.ts', '.mts', '.cts', '.tsx'];
const MISSING_MODULE_CODES = new Set([
  'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND',
  'ERR_UNSUPPORTED_DIR_IMPORT',
]);

function isDeclarationFile(path: string): boolean {
  return DECLARATION_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

function isTypeScriptFile(path: string): boolean {
  return TYPESCRIPT_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

function isMissingModule(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && MISSING_MODULE_CODES.has(code);
}

/** Whether a specifier starts with a URL scheme such as `node:`, `data:`, or `file:`. */
function hasUrlScheme(specifier: string): boolean {
  const colon = specifier.indexOf(':');
  if (colon <= 0) {
    return false;
  }
  for (const char of specifier.slice(0, colon)) {
    const isLetter = (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z');
    const isDigit = char >= '0' && char <= '9';
    if (!isLetter && !isDigit && char !== '+' && char !== '.' && char !== '-' && char !== '_') {
      return false;
    }
  }
  return true;
}

function seedPaths(root: string) {
  const path = join(root, 'tsconfig.json');
  if (!existsSync(path)) {
    return null;
  }
  try {
    const project = getTsconfig(path);
    const options = project?.config.compilerOptions;
    if (!project || !options) {
      return null;
    }
    const paths = Object.fromEntries(
      Object.entries(options.paths ?? {})
        .map(
          ([name, targets]) =>
            [name, targets.filter((target) => !isDeclarationFile(target))] as const,
        )
        .filter(([, targets]) => targets.length > 0),
    );
    if (!Object.keys(paths).length && options.baseUrl === undefined) {
      return null;
    }
    return createPathsMatcher({ ...project, config: { compilerOptions: { ...options, paths } } });
  } catch (error) {
    // get-tsconfig reports a missing `extends` target as "File '<path>' not found."
    if (
      error instanceof Error &&
      error.message.includes('not found') &&
      toSlash(error.message).includes('/.void/tsconfig.json') &&
      !existsSync(join(root, '.void/tsconfig.json'))
    ) {
      throw new Error('db: Missing .void/tsconfig.json. Run `void prepare` before seeding.', {
        cause: error,
      });
    }
    throw error;
  }
}

function seedScope(root: string, seed: string) {
  const directories = new Map<string, boolean>([
    [toSlash(realpathSync(root)), true],
    [dirname(realpathSync(seed)), true],
  ]);
  function ownsDirectory(directory: string): boolean {
    const known = directories.get(directory);
    if (known !== undefined) {
      return known;
    }
    const parent = dirname(directory);
    const owned =
      parent !== directory &&
      basename(directory) !== 'node_modules' &&
      !existsSync(join(directory, 'package.json')) &&
      ownsDirectory(parent);
    directories.set(directory, owned);
    return owned;
  }
  return (url: string) => url.startsWith('file:') && ownsDirectory(dirname(fileURLToPath(url)));
}

/** Compile an app module to ESM that still has `require`, `__filename`, and `__dirname`. */
function compileToEsm(sourcefile: string, loader: 'js' | 'ts' | 'tsx'): string {
  return transformSync(readFileSync(sourcefile, 'utf8'), {
    sourcefile,
    loader,
    target: 'node24',
    platform: 'node',
    format: 'esm',
    sourcemap: 'inline',
    define: {
      require: 'import.meta.require',
      __filename: 'import.meta.filename',
      __dirname: 'import.meta.dirname',
    },
    banner:
      "import.meta.require = globalThis.process.getBuiltinModule('node:module').createRequire(import.meta.url);",
  }).code;
}

/** ESM that re-exports every named value, which Node's static CommonJS and JSON imports lack. */
function namedExports(value: unknown): string {
  const names =
    value !== null && (typeof value === 'object' || typeof value === 'function')
      ? Object.keys(value).filter((name) => name !== 'default' && name !== '__esModule')
      : [];
  return names
    .map((name, index) => {
      const key = JSON.stringify(name);
      return `const __voidExport${index} = __voidValue[${key}];\nexport { __voidExport${index} as ${key} };`;
    })
    .join('\n');
}

/** A JSON module that also has a named export for each top-level key, as jiti gave seeds. */
function jsonModule(url: string): string {
  const value: unknown = JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
  return `const __voidValue = ${JSON.stringify(value)};
export default __voidValue;
${namedExports(value)}`;
}

/**
 * A CommonJS module whose named exports are read from its `module.exports`, as jiti gave seeds.
 * Node only finds the names it can detect in the source, so `import { range } from 'lodash'`
 * would fail to link. The module runs here, and the wrapper gets the cached instance.
 */
function commonjsModule(url: string): string {
  const filename = JSON.stringify(fileURLToPath(url));
  const value: unknown = nodeModule.createRequire(url)(fileURLToPath(url));
  return `import { createRequire } from 'node:module';
const __voidValue = createRequire(import.meta.url)(${filename});
export default __voidValue && __voidValue.__esModule ? __voidValue.default : __voidValue;
export { __voidValue as 'module.exports' };
${namedExports(value)}`;
}

export function createSeedModuleLoader(root: string, seed: string): SeedModuleLoader {
  const match = seedPaths(root);
  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    moduleCache: false,
    interopDefault: false,
    tsconfigPaths: false,
  });
  // Bun has no `registerHooks`; there jiti loads the seed and Bun applies the tsconfig paths itself.
  const { registerHooks } = nodeModule as Partial<typeof nodeModule>;
  if (!match || typeof registerHooks !== 'function') {
    return { importModule: (path) => jiti.import<Record<string, unknown>>(path), close: () => {} };
  }
  const owns = seedScope(root, seed);
  const modules = new Set<string>();
  // Modules that an app module imports with `import`, which get jiti's named-export interop.
  const imported = new Set<string>();

  const resolveImport = (
    specifier: string,
    parent: string,
    context: Parameters<ResolveHookSync>[1],
    nextResolve: Parameters<ResolveHookSync>[2],
  ): ReturnType<ResolveHookSync> => {
    const file =
      specifier.startsWith('./') ||
      specifier.startsWith('../') ||
      specifier.startsWith('/') ||
      specifier.startsWith('file:');
    if (file) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        // Add the extension that jiti added for an extensionless path, such as `./users`.
        if (isMissingModule(error)) {
          const target = new URL(specifier, parent);
          const resolved = jiti.esmResolve(fileURLToPath(target), { try: true });
          if (resolved) {
            return { shortCircuit: true, url: resolved + target.search + target.hash };
          }
        }
        throw error;
      }
    }
    const bare = !isAbsolute(specifier) && !specifier.startsWith('.') && !hasUrlScheme(specifier);
    if (bare && owns(parent)) {
      for (const target of match(specifier)) {
        const resolved = jiti.esmResolve(target, { try: true });
        // TypeScript adds code extensions to a path target, never `.json`.
        if (resolved && (!resolved.endsWith('.json') || target.endsWith('.json'))) {
          return { shortCircuit: true, url: resolved };
        }
      }
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      // Allow extensionless subpaths into packages without `exports`, such as `lodash/range`.
      if (bare && isMissingModule(error)) {
        const resolved = jiti.esmResolve(specifier, { parentURL: parent, try: true });
        if (resolved) {
          return { shortCircuit: true, url: resolved };
        }
      }
      throw error;
    }
  };
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      if (!parent || !modules.has(parent) || nodeModule.isBuiltin(specifier)) {
        return nextResolve(specifier, context);
      }
      const local = owns(parent) || isTypeScriptFile(fileURLToPath(parent));
      const result = local
        ? resolveImport(specifier, parent, context, nextResolve)
        : nextResolve(specifier, context);
      if (result.url.startsWith('file:')) {
        modules.add(result.url);
        if (local && !context.conditions.includes('require')) {
          imported.add(result.url);
        }
      }
      return result;
    },
    load(url, context, nextLoad) {
      if (!modules.has(url)) {
        return nextLoad(url, context);
      }
      const sourcefile = fileURLToPath(url);
      if (sourcefile.endsWith('.js') && context.format === 'commonjs' && owns(url)) {
        const source = readFileSync(sourcefile, 'utf8');
        const { metafile } = buildSync({
          stdin: { sourcefile, contents: source },
          write: false,
          metafile: true,
          platform: 'node',
          target: 'node24',
        });
        if (Object.values(metafile.inputs)[0]?.format === 'esm') {
          return { format: 'module', source: compileToEsm(sourcefile, 'js'), shortCircuit: true };
        }
      }
      const interop = imported.has(url) && !context.conditions.includes('require');
      if (interop && extname(sourcefile) === '.json' && !context.importAttributes.type) {
        return { format: 'module', source: jsonModule(url), shortCircuit: true };
      }
      if (!isTypeScriptFile(sourcefile)) {
        const result = nextLoad(url, context);
        return interop && result.format === 'commonjs'
          ? { format: 'module', source: commonjsModule(url), shortCircuit: true }
          : result;
      }
      if (sourcefile.endsWith('.cts')) {
        const { code } = transformSync(readFileSync(sourcefile, 'utf8'), {
          sourcefile,
          loader: 'ts',
          target: 'node24',
          platform: 'node',
          format: 'cjs',
          sourcemap: 'inline',
        });
        return { format: 'commonjs', source: code, shortCircuit: true };
      }
      const loader = sourcefile.endsWith('.tsx') ? 'tsx' : 'ts';
      return { format: 'module', source: compileToEsm(sourcefile, loader), shortCircuit: true };
    },
  });
  return {
    async importModule(path) {
      const url = pathToFileURL(realpathSync(path)).href;
      modules.add(url);
      const mod = (await import(url)) as Record<string, unknown>;
      // A CommonJS module imported natively exposes its whole `module.exports` under this key.
      const cjs = mod['module.exports'];
      return cjs && typeof cjs === 'object' ? (cjs as Record<string, unknown>) : mod;
    },
    close: () => hooks.deregister(),
  };
}
