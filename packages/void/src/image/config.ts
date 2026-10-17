/**
 * Image configuration shared by `void.config.ts`, the `/_void/image` endpoint and
 * every adapter's `Image` component. Keys, types and defaults follow `images` in
 * Next.js 16 `next.config.js`; the endpoint path is `/_void/image`.
 *
 * Worker- and browser-safe: no Node.js imports.
 */

/** Output formats the endpoint may negotiate from `Accept`. */
export type ImageFormat = 'image/avif' | 'image/webp';

/**
 * Built-in loader names. `cloudflare` is a Void addition that emits Cloudflare
 * zone transformation URLs (`/cdn-cgi/image/...`).
 */
export type ImageLoaderName =
  | 'default'
  | 'imgix'
  | 'cloudinary'
  | 'akamai'
  | 'custom'
  | 'cloudflare';

/** A remote source allowed by the endpoint. Fields other than `hostname` are optional. */
export type RemotePattern = {
  protocol?: 'http' | 'https';
  hostname: string;
  port?: string;
  pathname?: string;
  search?: string;
};

/** A local source allowed by the endpoint. */
export type LocalPattern = {
  pathname?: string;
  search?: string;
};

/** `images` in `void.config.ts`. Every key is optional. */
export type ImageConfig = {
  /** Widths used for `w` descriptors when `sizes` or `fill` is set. */
  deviceSizes?: Array<number>;
  /** Widths combined with `deviceSizes` for fixed-width and `sizes` images. */
  imageSizes?: Array<number>;
  /** Allowed `q` values. */
  qualities?: Array<number>;
  /** Output formats to negotiate from `Accept`, in order of preference. */
  formats?: Array<ImageFormat>;
  /** Minimum `Cache-Control` max-age, in seconds, for optimized images. */
  minimumCacheTTL?: number;
  /** Remote sources the endpoint may fetch. Accepts `URL` instances. */
  remotePatterns?: Array<URL | RemotePattern>;
  /** Local sources the endpoint may load. All paths without a query when unset. */
  localPatterns?: Array<LocalPattern>;
  /** Serve SVG sources (unchanged) instead of rejecting them. */
  dangerouslyAllowSVG?: boolean;
  /** Allow remote sources that resolve to private or loopback IP literals. */
  dangerouslyAllowLocalIP?: boolean;
  /** `Content-Security-Policy` sent with every endpoint response. */
  contentSecurityPolicy?: string;
  /** `Content-Disposition` type sent with every endpoint response. */
  contentDispositionType?: 'inline' | 'attachment';
  /** Redirects followed for remote sources. */
  maximumRedirects?: number;
  /** Largest remote source body, in bytes. Capped at 20 MB. */
  maximumResponseBody?: number;
  /** Loader used to build image URLs. */
  loader?: ImageLoaderName;
  /** Module whose default export is the loader for every `Image`, relative to the project root. */
  loaderFile?: string;
  /** URL prefix of the optimizer (default loader) or image CDN (other loaders). */
  path?: string;
  /** Render every image with its original `src`. */
  unoptimized?: boolean;
  /** @deprecated Use `remotePatterns`. */
  domains?: Array<string>;
  /** Accepted for Next.js compatibility. Workers have no disk cache, so it has no effect. */
  maximumDiskCacheSize?: number;
  /** Accepted for Next.js compatibility. Has no effect. */
  disableStaticImages?: boolean;
  /** Accepted for Next.js compatibility. Has no effect. */
  customCacheHandler?: boolean;
};

/** `ImageConfig` with every key resolved to its default. */
export type ImageConfigComplete = Required<
  Omit<
    ImageConfig,
    | 'localPatterns'
    | 'maximumDiskCacheSize'
    | 'remotePatterns'
    | 'disableStaticImages'
    | 'customCacheHandler'
  >
> & {
  remotePatterns: Array<URL | RemotePattern>;
  localPatterns: Array<LocalPattern> | undefined;
  maximumDiskCacheSize: number | undefined;
  disableStaticImages: boolean;
  customCacheHandler: boolean;
};

/** Default `images.path` for the default loader. */
export const DEFAULT_IMAGE_PATH = '/_void/image';

/** Default `images.path` for `loader: 'cloudflare'`. */
export const CLOUDFLARE_IMAGE_PATH = '/cdn-cgi/image';

/** Largest stream the Cloudflare Images binding accepts in `.input()`. */
export const IMAGES_BINDING_MAX_INPUT_BYTES = 20_000_000;

/** Cloudflare Images encodes AVIF only up to this width. */
export const AVIF_MAX_WIDTH = 1200;

/** Next.js 16 `imageConfigDefault`, with Void's endpoint path. */
export const imageConfigDefault: ImageConfigComplete = {
  deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
  imageSizes: [32, 48, 64, 96, 128, 256, 384],
  path: DEFAULT_IMAGE_PATH,
  loader: 'default',
  loaderFile: '',
  domains: [],
  disableStaticImages: false,
  minimumCacheTTL: 14400,
  formats: ['image/webp'],
  maximumDiskCacheSize: undefined,
  maximumRedirects: 3,
  maximumResponseBody: 50_000_000,
  dangerouslyAllowLocalIP: false,
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: `script-src 'none'; frame-src 'none'; sandbox;`,
  contentDispositionType: 'attachment',
  localPatterns: undefined,
  remotePatterns: [],
  qualities: [75],
  unoptimized: false,
  customCacheHandler: false,
};

export const VALID_IMAGE_LOADERS: ReadonlyArray<ImageLoaderName> = [
  'default',
  'imgix',
  'cloudinary',
  'akamai',
  'custom',
  'cloudflare',
];

export const VALID_IMAGE_FORMATS: ReadonlyArray<ImageFormat> = ['image/avif', 'image/webp'];

/** Every key accepted under `images`, in documentation order. */
export const IMAGE_CONFIG_KEYS: ReadonlyArray<keyof ImageConfig> = [
  'deviceSizes',
  'imageSizes',
  'qualities',
  'formats',
  'minimumCacheTTL',
  'remotePatterns',
  'localPatterns',
  'dangerouslyAllowSVG',
  'dangerouslyAllowLocalIP',
  'contentSecurityPolicy',
  'contentDispositionType',
  'maximumRedirects',
  'maximumResponseBody',
  'loader',
  'loaderFile',
  'path',
  'unoptimized',
  'domains',
  'maximumDiskCacheSize',
  'disableStaticImages',
  'customCacheHandler',
];

/**
 * A remote pattern with its globs compiled at build time (picomatch v4
 * semantics, as Next.js uses). `protocol` has no trailing colon.
 */
export type CompiledRemotePattern = RemotePattern & {
  /** `RegExp` source for `hostname` (picomatch, default options). */
  hostnameRe: string;
  /** `RegExp` source for `pathname ?? '**'` (picomatch, `{ dot: true }`). */
  pathnameRe: string;
};

/** A local pattern with its glob compiled at build time. */
export type CompiledLocalPattern = LocalPattern & {
  /** `RegExp` source for `pathname ?? '**'` (picomatch, `{ dot: true }`). */
  pathnameRe: string;
};

/**
 * The full configuration the server uses: defaults applied, sizes and
 * qualities sorted, patterns compiled, Next.js normalization applied, and
 * `noOptimizer` set where no optimizer exists (non-Cloudflare targets, static
 * output, Void Platform builds) unless a custom loader is set.
 * JSON-serializable, so it can be baked into generated code.
 */
export type ResolvedImageConfig = {
  deviceSizes: Array<number>;
  imageSizes: Array<number>;
  /** `[...deviceSizes, ...imageSizes]` sorted ascending. */
  allSizes: Array<number>;
  qualities: Array<number>;
  formats: Array<ImageFormat>;
  minimumCacheTTL: number;
  remotePatterns: Array<CompiledRemotePattern>;
  /** Defaults to `[{ pathname: '**', search: '' }]` (any path, no query). */
  localPatterns: Array<CompiledLocalPattern>;
  domains: Array<string>;
  dangerouslyAllowSVG: boolean;
  dangerouslyAllowLocalIP: boolean;
  contentSecurityPolicy: string;
  contentDispositionType: 'inline' | 'attachment';
  maximumRedirects: number;
  /** `min(images.maximumResponseBody, IMAGES_BINDING_MAX_INPUT_BYTES)`. */
  maximumResponseBody: number;
  loader: ImageLoaderName;
  /** Absolute, forward-slash path of `images.loaderFile`, or `''`. */
  loaderFile: string;
  path: string;
  /** `images.unoptimized`: every image renders with its original `src`. */
  unoptimized: boolean;
  /**
   * Nothing serves the default loader's URLs in this build (`node`, `bun`
   * and `deno` targets, static output, Void Platform builds) and no custom
   * loader or `loaderFile` is configured. Images that use the default loader
   * render with their original `src`; a `loader` prop still applies.
   */
  noOptimizer: boolean;
  /** True for the Vite dev server (`vp dev`), false for builds and preview. */
  dev: boolean;
};

/**
 * The configuration an `Image` component reads at render time, registered by
 * the Void Vite plugin in every environment. Client bundles receive patterns
 * only in development (for the same dev-time checks Next.js runs); server
 * environments always receive them.
 */
export type ClientImageConfig = {
  deviceSizes: Array<number>;
  imageSizes: Array<number>;
  allSizes: Array<number>;
  qualities: Array<number>;
  path: string;
  loader: ImageLoaderName;
  dangerouslyAllowSVG: boolean;
  unoptimized: boolean;
  dev: boolean;
  /** `ResolvedImageConfig.noOptimizer`, present only when true. */
  noOptimizer?: boolean;
  localPatterns?: Array<CompiledLocalPattern>;
  remotePatterns?: Array<CompiledRemotePattern>;
  domains?: Array<string>;
};

/**
 * `globalThis` key of the registered `{ config: ClientImageConfig; loader?: ImageLoader }`.
 * A versioned `Symbol.for` key keeps duplicate module copies in sync.
 */
export const IMAGE_REGISTRY_KEY: unique symbol = Symbol.for('void.image.config.v1') as never;
