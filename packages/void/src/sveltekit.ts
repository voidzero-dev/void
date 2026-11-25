import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'pathslash';

type Tsconfig = Record<string, unknown>;
type TsconfigHook = (config: Tsconfig) => Tsconfig | void;

export type VoidSvelteKitTsconfigOptions = {
  /** Project root. Defaults to process.cwd(). */
  root?: string;
};

/**
 * Merge Void's generated tsconfig fragment into SvelteKit's generated
 * tsconfig. Use from `typescript.config` in `sveltekit()` or from
 * `kit.typescript.config` in `svelte.config.js`.
 */
export function mergeVoidSvelteKitTsconfig(
  config: Tsconfig,
  options: VoidSvelteKitTsconfigOptions = {},
): Tsconfig {
  const root = resolve(options.root ?? process.cwd());
  const voidDir = join(root, '.void');
  const voidTsconfigPath = join(voidDir, 'tsconfig.json');
  if (!existsSync(voidTsconfigPath)) {
    return config;
  }

  const voidConfig = JSON.parse(readFileSync(voidTsconfigPath, 'utf8')) as Tsconfig;

  const voidFiles = Array.isArray(voidConfig.files)
    ? voidConfig.files.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (voidFiles.length > 0) {
    const files = Array.isArray(config.files)
      ? config.files.filter((entry): entry is string => typeof entry === 'string')
      : [];
    config.files = uniqueStrings([
      ...files,
      ...voidFiles.map((entry) => resolveTsconfigEntry(voidDir, entry)),
    ]);
  }

  const voidPaths = readPathMap(readObject(readObject(voidConfig.compilerOptions)?.paths));
  if (Object.keys(voidPaths).length > 0) {
    const compilerOptions = ensureObject(config, 'compilerOptions');
    const paths = ensureObject(compilerOptions, 'paths');
    for (const [key, values] of Object.entries(voidPaths)) {
      // Kit 2 writes this config under .svelte-kit; Kit 3 writes it under
      // node_modules/$app. Absolute paths work from either generated location.
      paths[key] = values.map((entry) => resolveTsconfigEntry(voidDir, entry));
    }
  }

  return config;
}

/**
 * Compose a user SvelteKit tsconfig hook with Void's generated type aliases.
 */
export function withVoidTSConfig(
  hook?: TsconfigHook,
  options?: VoidSvelteKitTsconfigOptions,
): TsconfigHook {
  return (config) => mergeVoidSvelteKitTsconfig(hook?.(config) ?? config, options);
}

function readObject(value: unknown): Tsconfig | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Tsconfig) : null;
}

function ensureObject(target: Tsconfig, key: string) {
  const current = readObject(target[key]);
  if (current) {
    return current;
  }
  const next: Tsconfig = {};
  target[key] = next;
  return next;
}

function readPathMap(value: Tsconfig | null) {
  const result: Record<string, Array<string>> = {};
  if (!value) {
    return result;
  }
  for (const [key, entries] of Object.entries(value)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    const strings = entries.filter((entry): entry is string => typeof entry === 'string');
    if (strings.length > 0) {
      result[key] = strings;
    }
  }
  return result;
}

function resolveTsconfigEntry(baseDir: string, entry: string): string {
  return isAbsolute(entry) ? entry : resolve(baseDir, entry);
}

function uniqueStrings(values: Array<string>): Array<string> {
  return Array.from(new Set(values));
}
