import { existsSync, readFileSync, realpathSync } from 'node:fs';
import nodeModule, { type ResolveHookSync } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync, transformSync } from 'esbuild';
import { createPathsMatcher, getTsconfig } from 'get-tsconfig';
import { createJiti } from 'jiti';
import { basename, dirname, extname, isAbsolute, join, toSlash } from 'pathslash';

export type SeedModuleImporter = (path: string) => Promise<Record<string, unknown>>;

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
            [name, targets.filter((target) => !/\.d\.[cm]?ts$/.test(target))] as const,
        )
        .filter(([, targets]) => targets.length > 0),
    );
    if (!Object.keys(paths).length && options.baseUrl === undefined) {
      return null;
    }
    return createPathsMatcher({ ...project, config: { compilerOptions: { ...options, paths } } });
  } catch (error) {
    if (
      !existsSync(join(root, '.void/tsconfig.json')) &&
      error instanceof Error &&
      /File ['"].*[/\\]\.void[/\\]tsconfig\.json['"] not found/.test(error.message)
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

export function createSeedModuleLoader(
  root: string,
  seed: string,
): {
  importModule: SeedModuleImporter;
  close: () => void;
} {
  const match = seedPaths(root);
  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    moduleCache: false,
    interopDefault: false,
    tsconfigPaths: false,
  });
  if (!match || typeof nodeModule.registerHooks !== 'function') {
    return { importModule: (path) => jiti.import<Record<string, unknown>>(path), close: () => {} };
  }
  const owns = seedScope(root, seed);
  const modules = new Set<string>();

  const resolveImport: ResolveHookSync = (specifier, context, nextResolve) => {
    const parent = context.parentURL!;
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          code === 'MODULE_NOT_FOUND' ||
          code === 'ERR_MODULE_NOT_FOUND' ||
          code === 'ERR_UNSUPPORTED_DIR_IMPORT'
        ) {
          const target = new URL(specifier, parent);
          const resolved = jiti.esmResolve(fileURLToPath(target), { try: true });
          if (resolved) {
            return { shortCircuit: true, url: resolved + target.search + target.hash };
          }
        }
        throw error;
      }
    }
    if (
      owns(parent) &&
      !isAbsolute(specifier) &&
      !specifier.startsWith('.') &&
      !/^[\w+.-]+:/.test(specifier)
    ) {
      for (const target of match(specifier)) {
        const resolved = jiti.esmResolve(target, { try: true });
        if (resolved) {
          return { shortCircuit: true, url: resolved };
        }
      }
    }
    return nextResolve(specifier, context);
  };
  const hooks = nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      if (!parent || !modules.has(parent) || nodeModule.isBuiltin(specifier)) {
        return nextResolve(specifier, context);
      }
      const local = owns(parent) || /\.[cm]?ts$/.test(fileURLToPath(parent));
      const result = local
        ? resolveImport(specifier, context, nextResolve)
        : nextResolve(specifier, context);
      if (result.url.startsWith('file:')) {
        modules.add(result.url);
        if (
          local &&
          extname(fileURLToPath(result.url)) === '.json' &&
          !context.importAttributes?.type
        ) {
          return { ...result, importAttributes: { ...context.importAttributes, type: 'json' } };
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
          return { format: 'module', source, shortCircuit: true };
        }
      }
      if (!/\.[cm]?ts$/.test(sourcefile)) {
        return nextLoad(url, context);
      }
      const commonjs = sourcefile.endsWith('.cts');
      const { code } = transformSync(readFileSync(sourcefile, 'utf8'), {
        sourcefile,
        loader: 'ts',
        target: 'node24',
        platform: 'node',
        format: commonjs ? 'cjs' : 'esm',
        sourcemap: 'inline',
        ...(commonjs
          ? {}
          : {
              define: {
                require: 'import.meta.require',
                __filename: 'import.meta.filename',
                __dirname: 'import.meta.dirname',
              },
              banner:
                "import.meta.require = globalThis.process.getBuiltinModule('node:module').createRequire(import.meta.url);",
            }),
      });
      return { format: commonjs ? 'commonjs' : 'module', source: code, shortCircuit: true };
    },
  });
  return {
    async importModule(path) {
      const url = pathToFileURL(realpathSync(path)).href;
      modules.add(url);
      const mod = await import(url);
      const cjs = mod['module.exports'];
      return cjs && typeof cjs === 'object' ? cjs : mod;
    },
    close: () => hooks.deregister(),
  };
}
