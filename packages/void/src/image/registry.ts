/**
 * The config and loader registered by the Void Vite plugin
 * (`virtual:void/image-config`), and the registry-aware entry points adapters
 * and apps call. The registry lives on `globalThis` under a versioned
 * `Symbol.for` key so duplicate copies of this module read the same values.
 */
import { defaultClientImageConfig } from './client-config.ts';
import { IMAGE_REGISTRY_KEY, type ClientImageConfig } from './config.ts';
import { getImgProps } from './get-img-props.ts';
import { cloudflareLoader, defaultLoader } from './loader.ts';
import type {
  ImageCoreProps,
  ImageLoader,
  ImageLoaderWithConfig,
  ImageRenderState,
  ImgProps,
  ImgPropsResult,
} from './types.ts';

/**
 * What the plugin stores under `IMAGE_REGISTRY_KEY`. `loader` is the default
 * export of `images.loaderFile`, or `undefined` without one;
 * `hasLoaderFile` is set whenever `images.loaderFile` is.
 */
export type ImageConfigRegistration = {
  config: ClientImageConfig;
  loader?: ImageLoader | undefined;
  hasLoaderFile?: boolean;
};

let fallbackConfig: ClientImageConfig | undefined;
const inlinedConfigs = new WeakMap<ClientImageConfig, ClientImageConfig>();

function getRegistration(): ImageConfigRegistration | undefined {
  const registration = (globalThis as Record<PropertyKey, unknown>)[IMAGE_REGISTRY_KEY];
  return registration && typeof registration === 'object'
    ? (registration as ImageConfigRegistration)
    : undefined;
}

/**
 * The registered client config, or Next.js defaults (with `/_void/image`)
 * when nothing is registered, e.g. in unit tests or outside Vite.
 */
export function getImageConfig(): ClientImageConfig {
  const registered = getRegistration()?.config;
  if (registered) {
    return registered;
  }
  fallbackConfig ??= defaultClientImageConfig();
  return fallbackConfig;
}

/**
 * The loader an `Image` without a `loader` prop uses: the registered
 * `images.loaderFile` export, else the Cloudflare loader for
 * `loader: 'cloudflare'`, else the default loader. With `images.loaderFile`
 * it is that file's default export as is, so a missing export is `undefined`
 * and `getImgProps` reports it as Next.js does.
 */
export function getDefaultImageLoader(
  config?: ClientImageConfig,
): ImageLoaderWithConfig | undefined {
  const registration = getRegistration();
  if (registration?.hasLoaderFile) {
    return registration.loader;
  }
  const loader = registration?.loader;
  if (typeof loader === 'function') {
    return loader;
  }
  return (config ?? getImageConfig()).loader === 'cloudflare' ? cloudflareLoader : defaultLoader;
}

/**
 * `getImgProps` with the registered config and loader, for adapters. `state`
 * is the component's `blurComplete` / `showAltText` state.
 */
export function resolveImageProps(
  props: ImageCoreProps & Record<string, unknown>,
  state?: ImageRenderState,
): ImgPropsResult {
  const imgConf = getImageConfig();
  return getImgProps(props, {
    defaultLoader: getDefaultImageLoader(imgConf),
    imgConf,
    blurComplete: state?.blurComplete,
    showAltText: state?.showAltText,
  });
}

/**
 * The options Next.js inlines into bundles for `getImageProps()`: patterns
 * only in development, so production calls skip the loader's query-string
 * check on the server too.
 */
function getInlinedImageConfig(config: ClientImageConfig): ClientImageConfig {
  if (config.dev || (!config.localPatterns && !config.remotePatterns && !config.domains)) {
    return config;
  }
  let inlined = inlinedConfigs.get(config);
  if (!inlined) {
    const { localPatterns: _local, remotePatterns: _remote, domains: _domains, ...rest } = config;
    inlined = rest;
    inlinedConfigs.set(config, inlined);
  }
  return inlined;
}

/**
 * The props `Image` would pass to its `<img>`, for use with another element,
 * a `<picture>` source or CSS (`next/image` `getImageProps`). Keys whose
 * value is `undefined` are removed.
 */
export function getImageProps(props: ImageCoreProps & Record<string, unknown>): {
  props: ImgProps;
} {
  const imgConf = getInlinedImageConfig(getImageConfig());
  const { props: imgProps } = getImgProps(props, {
    defaultLoader: getDefaultImageLoader(imgConf),
    imgConf,
  });
  // Normally we don't care about undefined props because we pass to JSX,
  // but this exported function could be used by the end user for anything
  // so we delete undefined props to clean it up a little.
  for (const [key, value] of Object.entries(imgProps)) {
    if (value === undefined) {
      delete imgProps[key];
    }
  }
  return { props: imgProps };
}
