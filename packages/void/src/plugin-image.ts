import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import MagicString from 'magic-string';
import { basename, relative } from 'pathslash';
import {
  isFileLoadingAllowed,
  normalizePath,
  type ConfigEnv,
  type Plugin,
  type ResolvedConfig,
} from 'vite';
import { isNodeTarget, type VoidConfig } from './config.ts';
import {
  compileLocalPattern,
  isImageOptimizerActive,
  resolveImageConfig,
  setImageAssetsDir,
  toClientImageConfig,
  toMountedImageConfig,
} from './image-config.ts';
import { readImageSize, type ImageSize } from './image-size.ts';
import { IMAGE_REGISTRY_KEY, type ImageConfig, type ResolvedImageConfig } from './image/config.ts';

/** Registers the `images` config and `images.loaderFile` for `void/image` in each environment. */
export const IMAGE_CONFIG_MODULE_ID = 'virtual:void/image-config';
const RESOLVED_IMAGE_CONFIG_MODULE_ID = '\0' + IMAGE_CONFIG_MODULE_ID;

/** `import hero from './hero.png?image'`. */
const STATIC_IMAGE_QUERY = /[?&]image(?:&|$)/;

/** Extensions Vite turns into asset URLs without `assetsInclude` (`KNOWN_ASSET_TYPES`). */
const VITE_IMAGE_ASSET = /\.(?:apng|bmp|png|jpe?g|jfif|pjpeg|pjp|gif|svg|ico|webp|avif|cur)$/i;

/** Vite's dev server URL prefix for a file by absolute path. */
const VITE_FS_PREFIX = '/@fs/';

/**
 * The dev server serves an imported file from its source path, which the
 * `/assets/**` pattern added to user `images.localPatterns` (built files)
 * does not match. With user patterns, dev `?image` imports use the file's
 * `/@fs/` URL instead and the dev config allows that prefix, so static imports
 * stay allowed. Patterns only apply to the default loader.
 */
function usesFsStaticImageUrls(
  resolved: ResolvedImageConfig,
  images: ImageConfig | undefined,
): boolean {
  return resolved.dev && images?.localPatterns !== undefined && isImageOptimizerActive(resolved);
}

function cleanId(id: string): string {
  return id.replace(/[?#].*$/s, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type ImagePluginOptions = Pick<VoidConfig, 'images' | 'target' | 'output'> & {
  /** `inference.bindings.images`: mounts the endpoint without detected `Image` usage. */
  inferenceBinding?: boolean | string;
  /** The config file name used in error messages (`void.config.ts` or `void.json`). */
  configFile: string;
};

export type ImagePluginApi = {
  /**
   * Resolve `images` for a Vite command. The result is cached per command;
   * the plugin's `config` hook resolves it before other Void hooks read it.
   */
  resolve(env: Pick<ConfigEnv, 'command' | 'isPreview'>): ResolvedImageConfig;
  /** The config resolved for the running command, or `undefined` before the `config` hook. */
  getConfig(): ResolvedImageConfig | undefined;
  /**
   * The resolved config when the generated routes mount the optimizer
   * endpoint (see `shouldMountImageOptimizer`), else `undefined`. Its `path`
   * is the mount path (`toMountedImageConfig`).
   */
  getMountedConfig(usesImageOptimizer: boolean | undefined): ResolvedImageConfig | undefined;
  /** Root-relative POSIX paths of the files imported with `?image` (client manifest keys). */
  readonly imageSources: ReadonlySet<string>;
};

/**
 * `resolveImageConfig` for a Vite command: `dev` for the dev server (not
 * `vite preview`), and a Void Platform build (`VOID_DEPLOY_PROJECT_ID`) on
 * the Cloudflare target as `managed`. Resolution errors name the config file.
 */
export function resolveImageConfigForCommand(
  root: string,
  options: Pick<ImagePluginOptions, 'images' | 'target' | 'output' | 'configFile'>,
  env: Pick<ConfigEnv, 'command' | 'isPreview'>,
): ResolvedImageConfig {
  let resolved: ResolvedImageConfig;
  try {
    resolved = resolveImageConfig(options.images, {
      root,
      dev: env.command === 'serve' && env.isPreview !== true,
      target: options.target,
      output: options.output,
      managed:
        env.command === 'build' &&
        Boolean(process.env.VOID_DEPLOY_PROJECT_ID) &&
        !isNodeTarget(options.target),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`config: Invalid "images" in ${options.configFile}. ${message}`, {
      cause: error,
    });
  }
  if (usesFsStaticImageUrls(resolved, options.images)) {
    resolved.localPatterns.push(
      compileLocalPattern({ pathname: `${VITE_FS_PREFIX}**`, search: '' }),
    );
  }
  return resolved;
}

/**
 * Whether the generated routes serve `images.path`: a Cloudflare target, the
 * default loader without `unoptimized` (`isImageOptimizerActive`), and an app
 * that renders `Image` or calls `getImageProps`, or sets
 * `inference.bindings.images`.
 */
export function shouldMountImageOptimizer(
  resolved: ResolvedImageConfig,
  options: {
    nodeTarget: boolean;
    usesImageOptimizer: boolean | undefined;
    inferenceBinding?: boolean | string;
  },
): boolean {
  return (
    !options.nodeTarget &&
    isImageOptimizerActive(resolved) &&
    (options.usesImageOptimizer === true || Boolean(options.inferenceBinding))
  );
}

const REGISTRY_KEY_SOURCE = `Symbol.for(${JSON.stringify(Symbol.keyFor(IMAGE_REGISTRY_KEY))})`;

/**
 * The `virtual:void/image-config` module for one environment: it stores the
 * client config subset and the `images.loaderFile` default export where
 * `void/image` reads them. The loader file is imported as a namespace, as
 * Next.js does, so a file without a default export reaches `getImgProps`'s
 * "missing default export" error instead of failing to link.
 */
export function generateImageConfigModule(
  resolved: ResolvedImageConfig,
  consumer: 'client' | 'server',
): string {
  const config = JSON.stringify(toClientImageConfig(resolved, consumer));
  const lines: Array<string> = [];
  if (resolved.loaderFile) {
    lines.push(`import * as __voidImageLoaderModule from ${JSON.stringify(resolved.loaderFile)};`);
    lines.push(
      `globalThis[${REGISTRY_KEY_SOURCE}] = { config: ${config}, loader: Reflect.get(__voidImageLoaderModule, "default"), hasLoaderFile: true };`,
    );
  } else {
    lines.push(`globalThis[${REGISTRY_KEY_SOURCE}] = { config: ${config}, loader: undefined };`);
  }
  return lines.join('\n') + '\n';
}

/**
 * The module for `<file>?image`: Vite's asset URL plus the intrinsic size
 * (`StaticImageData`). With `fsUrl` (dev, see `usesFsStaticImageUrls`), `src`
 * is the file's `/@fs/` URL.
 */
export function generateStaticImageModule(
  file: string,
  size: Pick<ImageSize, 'width' | 'height'>,
  fsUrl = false,
): string {
  // Other image types (HEIC) are not Vite assets unless `assetsInclude` lists them.
  const specifier = VITE_IMAGE_ASSET.test(file) ? file : `${file}?url`;
  if (fsUrl) {
    const src = VITE_FS_PREFIX + file.replace(/^\/+/, '');
    // The import lets the dev server serve the file from `/@fs/` even outside
    // `server.fs.allow`, as for Vite's own URL (`safeModulePaths`).
    return (
      `import ${JSON.stringify(specifier)};\n` +
      `export default { src: ${JSON.stringify(src)}, width: ${size.width}, height: ${size.height} };\n`
    );
  }
  return (
    `import src from ${JSON.stringify(specifier)};\n` +
    `export default { src, width: ${size.width}, height: ${size.height} };\n`
  );
}

/**
 * Image support for Void apps:
 * - `virtual:void/image-config`, imported by the `void/image` entry in every
 *   environment, registers the resolved `images` config (client form) and the
 *   `images.loaderFile` loader for `Image` components;
 * - `import img from './a.png?image'` returns `{ src, width, height }`, read
 *   from the file header at build time.
 */
export function imagePlugin(
  root: string,
  options: ImagePluginOptions,
): Plugin & { api: ImagePluginApi } {
  const nodeTarget = isNodeTarget(options.target);
  // Pre-resolve the `void/image` entry like the other runtime paths, so the
  // module that receives the config import is the one adapters load.
  const imageEntry = normalizePath(fileURLToPath(import.meta.resolve('#self/image')));
  const imageEntryFilter = new RegExp(`${escapeRegExp(basename(imageEntry))}(?:[?#].*)?$`);
  let imageEntryRealPath: string | undefined;
  const realPaths = new Map<string, string>();
  let viteRoot = root;
  let viteConfig: ResolvedConfig | undefined;
  const imageSources = new Set<string>();
  const resolvedByCommand = new Map<string, ResolvedImageConfig>();
  let current: ResolvedImageConfig | undefined;

  function realPath(file: string): string {
    let real = realPaths.get(file);
    if (real === undefined) {
      try {
        real = normalizePath(realpathSync(file));
      } catch {
        real = file;
      }
      realPaths.set(file, real);
    }
    return real;
  }

  /**
   * Static `?image` imports are emitted under Vite's `build.assetsDir`, which
   * is known only once Vite's config is resolved (after the `config` hook).
   */
  function applyAssetsDir(resolved: ResolvedImageConfig): void {
    const assetsDir = viteConfig?.build?.assetsDir;
    if (assetsDir !== undefined) {
      setImageAssetsDir(resolved, assetsDir);
    }
  }

  function isImageEntry(id: string): boolean {
    const file = cleanId(id);
    if (file === imageEntry) {
      return true;
    }
    imageEntryRealPath ??= realPath(imageEntry);
    return file === imageEntryRealPath || realPath(file) === imageEntryRealPath;
  }

  const api: ImagePluginApi = {
    resolve(env) {
      const key = `${env.command}:${env.isPreview === true}`;
      let resolved = resolvedByCommand.get(key);
      if (!resolved) {
        resolved = resolveImageConfigForCommand(root, options, env);
        applyAssetsDir(resolved);
        resolvedByCommand.set(key, resolved);
      }
      current = resolved;
      return resolved;
    },
    getConfig: () => current,
    getMountedConfig(usesImageOptimizer) {
      return current &&
        shouldMountImageOptimizer(current, {
          nodeTarget,
          usesImageOptimizer,
          inferenceBinding: options.inferenceBinding,
        })
        ? toMountedImageConfig(current)
        : undefined;
    },
    imageSources,
  };

  return {
    name: 'void:image',
    // Before Vite's asset plugin, which would otherwise load `<file>?image` as a URL.
    enforce: 'pre',
    api,
    config(_config, env) {
      api.resolve(env);
    },
    configResolved(config) {
      viteConfig = config;
      viteRoot = config.root;
      // The config module and the routes read the resolved config after this.
      for (const resolved of resolvedByCommand.values()) {
        applyAssetsDir(resolved);
      }
    },
    configEnvironment(name, environment) {
      const consumer = environment.consumer ?? (name === 'client' ? 'client' : 'server');
      if (consumer === 'client') {
        // A prebundled copy of `void/image` would skip the config import below.
        return { optimizeDeps: { exclude: ['void/image'] } };
      }
    },
    resolveId: {
      filter: { id: /^virtual:void\/image-config$/ },
      handler() {
        return RESOLVED_IMAGE_CONFIG_MODULE_ID;
      },
    },
    load: {
      // eslint-disable-next-line no-control-regex -- Vite virtual module null-byte prefix
      filter: { id: [/^\0virtual:void\/image-config$/, STATIC_IMAGE_QUERY] },
      handler(id) {
        if (id === RESOLVED_IMAGE_CONFIG_MODULE_ID) {
          if (!current) {
            throw new Error(`${IMAGE_CONFIG_MODULE_ID} was loaded before Vite's config hooks ran.`);
          }
          const consumer = this.environment?.config.consumer === 'client' ? 'client' : 'server';
          return generateImageConfigModule(current, consumer);
        }
        if (!STATIC_IMAGE_QUERY.test(id) || id.startsWith('\0')) {
          return;
        }
        const file = cleanId(id);
        // Vite checks `server.fs` only for ids no plugin loads, and the module
        // below makes the file servable from `/@fs/` (`safeModulePaths`). A
        // request for `/@fs/<file>?image` must not expose files outside
        // `server.fs.allow`; real imports pass because the importer's import
        // analysis already marked the file safe. Vite answers this error with 403.
        if (
          this.environment?.mode === 'dev' &&
          viteConfig?.server?.fs &&
          !isFileLoadingAllowed(viteConfig, normalizePath(file))
        ) {
          throw Object.assign(new Error(`Denied ID ${id}`), { code: 'ERR_DENIED_ID', id });
        }
        const source = normalizePath(relative(viteRoot, file));
        let bytes: Uint8Array;
        try {
          bytes = readFileSync(file);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return this.error(`Could not read "${source}" imported with "?image": ${reason}`);
        }
        const size = readImageSize(bytes);
        if (!size) {
          return this.error(
            `Could not read the dimensions of "${source}" imported with "?image". Supported formats: PNG, JPEG, GIF, WebP, AVIF, HEIC, SVG, BMP and ICO.`,
          );
        }
        this.addWatchFile(file);
        imageSources.add(source);
        return generateStaticImageModule(
          file,
          size,
          current !== undefined && usesFsStaticImageUrls(current, options.images),
        );
      },
    },
    transform: {
      filter: { id: imageEntryFilter },
      handler(code, id) {
        if (!isImageEntry(id)) {
          return;
        }
        const output = new MagicString(code);
        output.prepend(`import ${JSON.stringify(IMAGE_CONFIG_MODULE_ID)};\n`);
        return { code: output.toString(), map: output.generateMap({ hires: 'boundary' }) };
      },
    },
  };
}
