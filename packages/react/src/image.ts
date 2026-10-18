/**
 * `@void/react/image`: shaped like the `next/image` module, so
 * `import Image, { getImageProps } from 'next/image'` becomes
 * `import Image, { getImageProps } from '@void/react/image'`.
 */
export { Image as default, Image, getImageProps } from './runtime/image.tsx';
export type {
  ImageLoader,
  ImageLoaderProps,
  ImageProps,
  StaticImageData,
} from './runtime/image.tsx';
