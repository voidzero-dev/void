/**
 * The `/_void/image` optimizer: a Worker-safe port of Next.js 16's
 * `/_next/image` endpoint backed by the Cloudflare Images binding. Each
 * module mirrors one part of Next.js's `image-optimizer` so it can be tested
 * on its own; `runtime/routing-image.ts` mounts `handleImageRequest`.
 */
export { getSupportedImageFormat } from './accept.ts';
export {
  ANIMATABLE_TYPES,
  BYPASS_TYPES,
  detectContentType,
  getImageExtension,
  isAnimated,
} from './content-type.ts';
export {
  handleImageRequest,
  type ImageCacheLike,
  type ImageRequestOptions,
  type ImagesBindingLike,
  type ImageTransformerLike,
} from './handler.ts';
export {
  extractEtag,
  getContentDisposition,
  getFileNameWithExtension,
  getImageEtag,
  getMaxAge,
  isFreshRequest,
} from './headers.ts';
export { ImageError } from './image-error.ts';
export { isPrivateIpLiteral } from './private-ip.ts';
export {
  fetchRemoteImage,
  loadLocalImage,
  UPSTREAM_TIMEOUT_MS,
  type AssetFetcher,
  type ImageFetch,
  type ImageUpstream,
  type LocalImageDispatch,
  type RemoteImageOptions,
} from './upstream.ts';
export { validateImageParams, type ImageParams, type ImageParamsResult } from './validate.ts';
