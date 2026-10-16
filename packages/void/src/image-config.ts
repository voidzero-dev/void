/**
 * Node-side `images` config handling: validation for `void.config.ts`,
 * Next.js 16 normalization, glob compilation and the subsets sent to the
 * endpoint and to `Image` components.
 */
import { existsSync } from 'node:fs';
import { isRecord } from '@void/deploy-core';
import { isAbsolute, join, resolve } from 'pathslash';
import picomatch from 'picomatch';
import {
  CLOUDFLARE_IMAGE_PATH,
  DEFAULT_IMAGE_PATH,
  IMAGE_CONFIG_KEYS,
  IMAGES_BINDING_MAX_INPUT_BYTES,
  VALID_IMAGE_FORMATS,
  VALID_IMAGE_LOADERS,
  imageConfigDefault,
  type CompiledLocalPattern,
  type CompiledRemotePattern,
  type ImageConfig,
  type LocalPattern,
  type RemotePattern,
  type ResolvedImageConfig,
} from './image/config.ts';
import { IMAGE_DOCS_URL } from './image/loader.ts';

export { toClientImageConfig } from './image/client-config.ts';

/** Next.js 16 `images` schema limits. */
export const IMAGE_CONFIG_LIMITS = {
  sizeMin: 1,
  sizeMax: 10000,
  deviceSizesMaxItems: 25,
  imageSizesMaxItems: 25,
  qualityMin: 1,
  qualityMax: 100,
  qualitiesMinItems: 1,
  qualitiesMaxItems: 20,
  formatsMaxItems: 4,
  domainsMaxItems: 50,
  remotePatternsMaxItems: 50,
  localPatternsMaxItems: 25,
  portMaxLength: 5,
  maximumRedirectsMax: 20,
} as const;

const BOOLEAN_KEYS = [
  'unoptimized',
  'dangerouslyAllowSVG',
  'dangerouslyAllowLocalIP',
  'disableStaticImages',
  'customCacheHandler',
] as const;

const STRING_KEYS = ['contentSecurityPolicy', 'loaderFile', 'path'] as const;

const REMOTE_PATTERN_KEYS = ['protocol', 'hostname', 'port', 'pathname', 'search'];
const LOCAL_PATTERN_KEYS = ['pathname', 'search'];

/** Vite's default `build.assetsDir`, where static `?image` imports are emitted. */
const DEFAULT_ASSETS_DIR = 'assets';

const NODE_TARGETS = new Set(['node', 'bun', 'deno']);

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function validateSizes(
  value: unknown,
  key: 'deviceSizes' | 'imageSizes',
  maxItems: number,
  configFile: string,
): void {
  const { sizeMin, sizeMax } = IMAGE_CONFIG_LIMITS;
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    !value.every((size) => isInteger(size, sizeMin, sizeMax))
  ) {
    throw new Error(
      `config: "images.${key}" in ${configFile} must be an array of at most ${maxItems} integers between ${sizeMin} and ${sizeMax}.`,
    );
  }
}

function validatePatternString(
  pattern: Record<string, unknown>,
  key: string,
  label: string,
  configFile: string,
): void {
  if (pattern[key] !== undefined && typeof pattern[key] !== 'string') {
    throw new Error(`config: "${label}.${key}" in ${configFile} must be a string.`);
  }
}

function validateRemotePatterns(value: unknown, configFile: string): void {
  const { remotePatternsMaxItems, portMaxLength } = IMAGE_CONFIG_LIMITS;
  if (!Array.isArray(value) || value.length > remotePatternsMaxItems) {
    throw new Error(
      `config: "images.remotePatterns" in ${configFile} must be an array of at most ${remotePatternsMaxItems} URL objects or patterns.`,
    );
  }
  value.forEach((pattern: unknown, index) => {
    // `isRecord` accepts URL instances, so check them first.
    if (pattern instanceof URL) {
      return;
    }
    const label = `images.remotePatterns[${index}]`;
    if (!isRecord(pattern)) {
      throw new Error(
        `config: "${label}" in ${configFile} must be a URL or an object with a "hostname".`,
      );
    }
    for (const key of Object.keys(pattern)) {
      if (!REMOTE_PATTERN_KEYS.includes(key)) {
        throw new Error(
          `config: Unknown key '${label}.${key}' in ${configFile}. Valid: ${REMOTE_PATTERN_KEYS.join(', ')}.`,
        );
      }
    }
    if (typeof pattern.hostname !== 'string') {
      throw new Error(`config: "${label}.hostname" in ${configFile} must be a string.`);
    }
    if (
      pattern.protocol !== undefined &&
      pattern.protocol !== 'http' &&
      pattern.protocol !== 'https'
    ) {
      throw new Error(`config: "${label}.protocol" in ${configFile} must be "http" or "https".`);
    }
    if (
      pattern.port !== undefined &&
      (typeof pattern.port !== 'string' || pattern.port.length > portMaxLength)
    ) {
      throw new Error(
        `config: "${label}.port" in ${configFile} must be a string of at most ${portMaxLength} characters.`,
      );
    }
    validatePatternString(pattern, 'pathname', label, configFile);
    validatePatternString(pattern, 'search', label, configFile);
  });
}

function validateLocalPatterns(value: unknown, configFile: string): void {
  const { localPatternsMaxItems } = IMAGE_CONFIG_LIMITS;
  if (!Array.isArray(value) || value.length > localPatternsMaxItems) {
    throw new Error(
      `config: "images.localPatterns" in ${configFile} must be an array of at most ${localPatternsMaxItems} patterns.`,
    );
  }
  value.forEach((pattern: unknown, index) => {
    const label = `images.localPatterns[${index}]`;
    if (!isRecord(pattern) || pattern instanceof URL) {
      throw new Error(`config: "${label}" in ${configFile} must be an object.`);
    }
    for (const key of Object.keys(pattern)) {
      if (!LOCAL_PATTERN_KEYS.includes(key)) {
        throw new Error(
          `config: Unknown key '${label}.${key}' in ${configFile}. Valid: ${LOCAL_PATTERN_KEYS.join(', ')}.`,
        );
      }
    }
    validatePatternString(pattern, 'pathname', label, configFile);
    validatePatternString(pattern, 'search', label, configFile);
  });
}

/**
 * Validate `images` with the limits of the Next.js 16 schema. Unknown keys are
 * rejected. `loader`/`path`/`loaderFile` combinations are checked when the
 * config is resolved.
 */
export function validateImagesConfig(value: unknown, configFile: string): void {
  if (value === undefined) {
    return;
  }
  // `isRecord` accepts URL instances, which have no own keys.
  if (!isRecord(value) || value instanceof URL) {
    throw new Error(`config: "images" in ${configFile} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!(IMAGE_CONFIG_KEYS as ReadonlyArray<string>).includes(key)) {
      throw new Error(
        `config: Unknown key 'images.${key}' in ${configFile}. Valid: ${IMAGE_CONFIG_KEYS.join(', ')}.`,
      );
    }
  }

  const images = value;
  const limits = IMAGE_CONFIG_LIMITS;

  if (images.deviceSizes !== undefined) {
    validateSizes(images.deviceSizes, 'deviceSizes', limits.deviceSizesMaxItems, configFile);
  }
  if (images.imageSizes !== undefined) {
    validateSizes(images.imageSizes, 'imageSizes', limits.imageSizesMaxItems, configFile);
  }
  if (images.qualities !== undefined) {
    const qualities = images.qualities;
    if (
      !Array.isArray(qualities) ||
      qualities.length < limits.qualitiesMinItems ||
      qualities.length > limits.qualitiesMaxItems ||
      !qualities.every((q) => isInteger(q, limits.qualityMin, limits.qualityMax))
    ) {
      throw new Error(
        `config: "images.qualities" in ${configFile} must be an array of ${limits.qualitiesMinItems} to ${limits.qualitiesMaxItems} integers between ${limits.qualityMin} and ${limits.qualityMax}.`,
      );
    }
  }
  if (images.formats !== undefined) {
    const formats = images.formats;
    if (
      !Array.isArray(formats) ||
      formats.length > limits.formatsMaxItems ||
      !formats.every((format) => (VALID_IMAGE_FORMATS as ReadonlyArray<unknown>).includes(format))
    ) {
      throw new Error(
        `config: "images.formats" in ${configFile} must be an array of at most ${limits.formatsMaxItems} of: ${VALID_IMAGE_FORMATS.join(', ')}.`,
      );
    }
  }
  if (images.minimumCacheTTL !== undefined) {
    if (!isInteger(images.minimumCacheTTL, 0, Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `config: "images.minimumCacheTTL" in ${configFile} must be a non-negative integer.`,
      );
    }
  }
  if (images.remotePatterns !== undefined) {
    validateRemotePatterns(images.remotePatterns, configFile);
  }
  if (images.localPatterns !== undefined) {
    validateLocalPatterns(images.localPatterns, configFile);
  }
  for (const key of BOOLEAN_KEYS) {
    if (images[key] !== undefined && typeof images[key] !== 'boolean') {
      throw new Error(`config: "images.${key}" in ${configFile} must be a boolean.`);
    }
  }
  for (const key of STRING_KEYS) {
    if (images[key] !== undefined && typeof images[key] !== 'string') {
      throw new Error(`config: "images.${key}" in ${configFile} must be a string.`);
    }
  }
  if (
    images.contentDispositionType !== undefined &&
    images.contentDispositionType !== 'inline' &&
    images.contentDispositionType !== 'attachment'
  ) {
    throw new Error(
      `config: "images.contentDispositionType" in ${configFile} must be "inline" or "attachment".`,
    );
  }
  if (images.maximumRedirects !== undefined) {
    if (!isInteger(images.maximumRedirects, 0, limits.maximumRedirectsMax)) {
      throw new Error(
        `config: "images.maximumRedirects" in ${configFile} must be an integer between 0 and ${limits.maximumRedirectsMax}.`,
      );
    }
  }
  if (images.maximumResponseBody !== undefined) {
    if (!isInteger(images.maximumResponseBody, 1, Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `config: "images.maximumResponseBody" in ${configFile} must be a positive integer.`,
      );
    }
  }
  if (images.maximumDiskCacheSize !== undefined) {
    if (!isInteger(images.maximumDiskCacheSize, 0, Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `config: "images.maximumDiskCacheSize" in ${configFile} must be a non-negative integer.`,
      );
    }
  }
  if (
    images.loader !== undefined &&
    !(VALID_IMAGE_LOADERS as ReadonlyArray<unknown>).includes(images.loader)
  ) {
    throw new Error(
      `config: "images.loader" in ${configFile} must be one of: ${VALID_IMAGE_LOADERS.join(', ')}.`,
    );
  }
  if (images.domains !== undefined) {
    if (
      !Array.isArray(images.domains) ||
      images.domains.length > limits.domainsMaxItems ||
      !images.domains.every((domain) => typeof domain === 'string')
    ) {
      throw new Error(
        `config: "images.domains" in ${configFile} must be an array of at most ${limits.domainsMaxItems} strings.`,
      );
    }
  }
}

/**
 * Warnings for `images` keys that are deprecated or have no effect in Void.
 * Emitted once by the plugin after the config is read.
 */
export function getImageConfigWarnings(
  images: ImageConfig | undefined,
  configFile: string,
): Array<string> {
  const warnings: Array<string> = [];
  if (!images) {
    return warnings;
  }
  if (images.domains?.length) {
    warnings.push(
      `\`images.domains\` is deprecated in favor of \`images.remotePatterns\`. Please update ${configFile} to protect your application from malicious users.`,
    );
  }
  if (images.maximumDiskCacheSize !== undefined) {
    warnings.push(
      `"images.maximumDiskCacheSize" in ${configFile} is ignored: optimized images are cached in the Cloudflare cache, not on disk.`,
    );
  }
  if (images.disableStaticImages) {
    warnings.push(
      `"images.disableStaticImages" in ${configFile} is ignored: image imports return URLs unless they end with "?image".`,
    );
  }
  if (images.customCacheHandler) {
    warnings.push(
      `"images.customCacheHandler" in ${configFile} is ignored: optimized images are cached in the Cloudflare cache.`,
    );
  }
  return warnings;
}

/** Options for `resolveImageConfig`. */
export type ResolveImageConfigOptions = {
  /** Project root. `images.loaderFile` resolves from here and must exist. */
  root: string;
  /** True for the Vite dev server (`vp dev`), false for builds and preview. */
  dev: boolean;
  /** `target` from the Void config. `node`, `bun` and `deno` have no optimizer. */
  target?: string;
  /** `output` from the Void config. Static output has no optimizer. */
  output?: 'server' | 'static';
  /** A Void Platform build, which has no Images binding yet. */
  managed?: boolean;
  /**
   * Vite's `build.assetsDir` (default `assets`). User `localPatterns` get a
   * pattern for it so static `?image` imports stay allowed. The plugin
   * corrects it with `setImageAssetsDir` once Vite's config is resolved.
   */
  assetsDir?: string;
};

/** Normalize one remote pattern as Next.js does and compile its globs (picomatch v4). */
export function compileRemotePattern(p: URL | RemotePattern): CompiledRemotePattern {
  // Read the fields through getters so `URL` instances work.
  const { protocol, hostname, port, pathname, search } = p;
  const proto = protocol?.replace(/:$/, '');
  if (proto !== undefined && proto !== 'http' && proto !== 'https') {
    throw new Error(
      `Specified images.remotePatterns must have protocol "http" or "https" received "${proto}".`,
    );
  }
  const compiled: CompiledRemotePattern = {
    hostname,
    hostnameRe: picomatch.makeRe(hostname).source,
    pathnameRe: picomatch.makeRe(pathname ?? '**', { dot: true }).source,
  };
  if (proto !== undefined) {
    compiled.protocol = proto;
  }
  if (port !== undefined) {
    compiled.port = port;
  }
  if (pathname !== undefined) {
    compiled.pathname = pathname;
  }
  if (search !== undefined) {
    compiled.search = search;
  }
  return compiled;
}

/** Compile one local pattern's glob (picomatch v4). */
export function compileLocalPattern(p: LocalPattern): CompiledLocalPattern {
  const compiled: CompiledLocalPattern = {
    pathnameRe: picomatch.makeRe(p.pathname ?? '**', { dot: true }).source,
  };
  if (p.pathname !== undefined) {
    compiled.pathname = p.pathname;
  }
  if (p.search !== undefined) {
    compiled.search = p.search;
  }
  return compiled;
}

const ascending = (a: number, b: number): number => a - b;

/** The local pattern for static `?image` imports emitted under `assetsDir`. */
function staticImportPattern(assetsDir: string): LocalPattern {
  const dir = assetsDir.replace(/^\/+|\/+$/g, '');
  return { pathname: dir ? `/${dir}/**` : '/*', search: '' };
}

/**
 * The user's `localPatterns` and the static import pattern, or the default
 * `[{ pathname: '**', search: '' }]` when the user sets none.
 */
function resolveLocalPatterns(
  user: ReadonlyArray<LocalPattern> | undefined,
  assetsDir: string,
): Array<LocalPattern> {
  if (!user) {
    return [{ pathname: '**', search: '' }];
  }
  const patterns = user.map((p) => ({ ...p }));
  const staticImports = staticImportPattern(assetsDir);
  if (
    !patterns.some(
      (p) => p.pathname === staticImports.pathname && p.search === staticImports.search,
    )
  ) {
    // Static `?image` imports are always allowed.
    patterns.push(staticImports);
  }
  return patterns;
}

/** The user's `localPatterns` and how many leading entries `resolveImageConfig` compiled from them. */
const localPatternSources = new WeakMap<
  ResolvedImageConfig,
  { user: ReadonlyArray<LocalPattern> | undefined; count: number }
>();

/**
 * Allow static `?image` imports under Vite's resolved `build.assetsDir` in
 * place of the directory `resolved` was resolved with. Patterns appended to
 * `resolved.localPatterns` after resolution are kept.
 */
export function setImageAssetsDir(resolved: ResolvedImageConfig, assetsDir: string): void {
  const source = localPatternSources.get(resolved);
  if (!source?.user) {
    return;
  }
  const compiled = resolveLocalPatterns(source.user, assetsDir).map(compileLocalPattern);
  resolved.localPatterns.splice(0, source.count, ...compiled);
  source.count = compiled.length;
}

/**
 * Next.js joins `loaderFile` to the project directory, so `/lib/loader.ts`
 * is `<root>/lib/loader.ts`. An absolute path to an existing file outside it
 * also works.
 */
function resolveLoaderFile(root: string, loaderFile: string): string {
  const joined = join(root, loaderFile);
  if (!existsSync(joined) && isAbsolute(loaderFile) && existsSync(loaderFile)) {
    return resolve(loaderFile);
  }
  if (!existsSync(joined)) {
    throw new Error(`Specified images.loaderFile does not exist at "${joined}".`);
  }
  return joined;
}

/**
 * Apply defaults and Next.js 16 normalization to `images`, compile the
 * patterns, resolve `loaderFile`, and set `noOptimizer` where no optimizer
 * exists (`node`/`bun`/`deno` targets, static output, Void Platform builds)
 * unless a custom loader or `loaderFile` is set.
 */
export function resolveImageConfig(
  images: ImageConfig | undefined,
  options: ResolveImageConfigOptions,
): ResolvedImageConfig {
  const user: Partial<ImageConfig> = {};
  for (const [key, value] of Object.entries(images ?? {})) {
    if (value !== undefined && value !== null) {
      (user as Record<string, unknown>)[key] = value;
    }
  }
  const merged = { ...imageConfigDefault, ...user };

  const localPatterns = resolveLocalPatterns(
    merged.localPatterns,
    options.assetsDir ?? DEFAULT_ASSETS_DIR,
  );

  const loader = merged.loader || 'default';
  let path = merged.path;
  if (loader === 'cloudflare' && path === DEFAULT_IMAGE_PATH) {
    path = CLOUDFLARE_IMAGE_PATH;
  }
  if (
    loader !== 'default' &&
    loader !== 'custom' &&
    loader !== 'cloudflare' &&
    path === DEFAULT_IMAGE_PATH
  ) {
    throw new Error(
      `Specified images.loader property (${loader}) also requires images.path property to be assigned to a URL prefix.\nSee more info here: ${IMAGE_DOCS_URL}`,
    );
  }
  // Next.js appends a trailing slash for non-default loaders. Cloudflare URLs
  // add their own `/` separator.
  if (path && !path.endsWith('/') && loader !== 'default' && loader !== 'cloudflare') {
    path += '/';
  }

  let loaderFile = '';
  if (merged.loaderFile) {
    if (loader !== 'default' && loader !== 'custom') {
      throw new Error(
        `Specified images.loader property (${loader}) cannot be used with images.loaderFile property. Please set images.loader to "custom".`,
      );
    }
    loaderFile = resolveLoaderFile(options.root, merged.loaderFile);
  }

  const optimizerUnavailable =
    (options.target !== undefined && NODE_TARGETS.has(options.target)) ||
    options.output === 'static' ||
    options.managed === true;
  const customLoader = loader !== 'default' || loaderFile !== '';

  const deviceSizes = [...merged.deviceSizes].sort(ascending);
  const imageSizes = [...merged.imageSizes].sort(ascending);

  const resolved: ResolvedImageConfig = {
    deviceSizes,
    imageSizes,
    allSizes: [...deviceSizes, ...imageSizes].sort(ascending),
    qualities: [...merged.qualities].sort(ascending),
    formats: [...merged.formats],
    minimumCacheTTL: merged.minimumCacheTTL,
    remotePatterns: merged.remotePatterns.map(compileRemotePattern),
    localPatterns: localPatterns.map(compileLocalPattern),
    domains: [...merged.domains],
    dangerouslyAllowSVG: merged.dangerouslyAllowSVG,
    dangerouslyAllowLocalIP: merged.dangerouslyAllowLocalIP,
    contentSecurityPolicy: merged.contentSecurityPolicy,
    contentDispositionType: merged.contentDispositionType,
    maximumRedirects: merged.maximumRedirects,
    maximumResponseBody: Math.min(merged.maximumResponseBody, IMAGES_BINDING_MAX_INPUT_BYTES),
    loader,
    loaderFile,
    path,
    unoptimized: merged.unoptimized,
    noOptimizer: optimizerUnavailable && !customLoader,
    dev: options.dev,
  };
  localPatternSources.set(resolved, {
    user: merged.localPatterns,
    count: resolved.localPatterns.length,
  });
  return resolved;
}

/** `http(s)://host/...` or `//host/...`. */
const ABSOLUTE_URL = /^(?:https?:)?\/\//i;

/**
 * The request path the app serves the optimizer at for `images.path`: the
 * path itself, or the pathname of an absolute URL (an image CDN in front of
 * the app, which forwards requests to that path). `undefined` for other
 * values and for a bare origin, whose root path the app's pages own.
 */
function getImageOptimizerPath(path: string): string | undefined {
  if (!ABSOLUTE_URL.test(path)) {
    return path.startsWith('/') ? path : undefined;
  }
  let pathname: string;
  try {
    pathname = new URL(path, 'https://localhost').pathname;
  } catch {
    return undefined;
  }
  return pathname === '/' ? undefined : pathname;
}

/**
 * Whether the app should serve the optimizer endpoint: the default loader,
 * no `loaderFile`, not `unoptimized`, an optimizer for this target, and a
 * `path` with a mountable request path.
 */
export function isImageOptimizerActive(resolved: ResolvedImageConfig): boolean {
  return (
    !resolved.unoptimized &&
    !resolved.noOptimizer &&
    resolved.loader === 'default' &&
    !resolved.loaderFile &&
    getImageOptimizerPath(resolved.path) !== undefined
  );
}

/**
 * The config the endpoint and the generated routes use: `path` is the request
 * path the endpoint is mounted at (the pathname of an absolute
 * `images.path`). `Image` keeps the configured `path`.
 */
export function toMountedImageConfig(resolved: ResolvedImageConfig): ResolvedImageConfig {
  const path = getImageOptimizerPath(resolved.path);
  return path === undefined || path === resolved.path ? resolved : { ...resolved, path };
}

/**
 * `isImageOptimizerActive` from the authored config alone (no file system),
 * for binding inference: `Image` usage needs the Images binding only when
 * this is true.
 */
export function imageOptimizerConfigured(
  images: ImageConfig | undefined,
  project: { target?: string; output?: string; managed?: boolean },
): boolean {
  if (project.target !== undefined && NODE_TARGETS.has(project.target)) {
    return false;
  }
  if (project.output === 'static' || project.managed === true) {
    return false;
  }
  if (images?.unoptimized || images?.loaderFile) {
    return false;
  }
  if ((images?.loader || 'default') !== 'default') {
    return false;
  }
  return getImageOptimizerPath(images?.path ?? DEFAULT_IMAGE_PATH) !== undefined;
}
