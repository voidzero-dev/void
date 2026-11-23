/**
 * `void/image`: the framework-neutral core of every adapter's `Image`
 * component and `getImageProps()`, matching `next/image` in Next.js 16.
 * Worker- and browser-safe.
 */
export {
  imageConfigDefault,
  IMAGE_REGISTRY_KEY,
  type ClientImageConfig,
  type CompiledLocalPattern,
  type CompiledRemotePattern,
  type ImageConfig,
  type ImageConfigComplete,
  type ImageFormat,
  type ImageLoaderName,
  type LocalPattern,
  type RemotePattern,
  type ResolvedImageConfig,
} from './config.ts';
export * from './types.ts';
export { getImageBlurSvg, type ImageBlurSvgOptions } from './blur-svg.ts';
export { getImgProps, type GetImgPropsState } from './get-img-props.ts';
export {
  createImagePreloadCollector,
  getImagePreloadLink,
  renderImagePreloadLinks,
  styleToString,
  toHtmlImgAttributes,
  type ImagePreloadCollector,
} from './html.ts';
export { cloudflareLoader, defaultLoader, findClosestQuality, IMAGE_DOCS_URL } from './loader.ts';
export {
  handleImageLoading,
  type HandleImageLoadingOptions,
  type ImageElementLike,
} from './loading.ts';
export {
  hasLocalMatch,
  hasRemoteMatch,
  matchLocalPattern,
  matchRemotePattern,
} from './patterns.ts';
export {
  getDefaultImageLoader,
  getImageConfig,
  getImageProps,
  resolveImageProps,
  type ImageConfigRegistration,
} from './registry.ts';
