/**
 * Framework-neutral `Image` prop and result types, matching `next/image` in
 * Next.js 16. Adapters intersect `ImageCoreProps` with their own `<img>`
 * attribute types.
 */
import type { ClientImageConfig } from './config.ts';

/** What `import img from './a.png?image'` returns. */
export interface StaticImageData {
  src: string;
  height: number;
  width: number;
  blurDataURL?: string;
  blurWidth?: number;
  blurHeight?: number;
}

export interface StaticRequire {
  default: StaticImageData;
}

export type StaticImport = StaticRequire | StaticImageData;

export type ImageLoaderProps = {
  src: string;
  width: number;
  quality?: number;
};

export type ImageLoaderPropsWithConfig = ImageLoaderProps & {
  config: Readonly<ClientImageConfig>;
};

export type ImageLoader = (props: ImageLoaderProps) => string;

export type ImageLoaderWithConfig = (props: ImageLoaderPropsWithConfig) => string;

export type PlaceholderValue = 'blur' | 'empty' | `data:image/${string}`;

/** Style object accepted and returned by the core (React `CSSProperties` shape). */
export type ImageStyle = Record<string, string | number | undefined>;

/** Props every adapter's `Image` accepts, besides ordinary `<img>` attributes. */
export type ImageCoreProps = {
  src: string | StaticImport;
  alt: string;
  width?: number | `${number}`;
  height?: number | `${number}`;
  fill?: boolean;
  loader?: ImageLoader;
  quality?: number | `${number}`;
  preload?: boolean;
  /** @deprecated Use `preload`. */
  priority?: boolean;
  loading?: 'lazy' | 'eager' | undefined;
  placeholder?: PlaceholderValue;
  blurDataURL?: string;
  unoptimized?: boolean;
  overrideSrc?: string;
  sizes?: string;
  decoding?: 'async' | 'auto' | 'sync';
  fetchPriority?: 'high' | 'low' | 'auto';
  className?: string;
  style?: ImageStyle;
  /** @deprecated Use `onLoad`. */
  onLoadingComplete?: (img: unknown) => void;
  /** @deprecated Legacy `next/image` prop. */
  layout?: string;
  /** @deprecated Legacy `next/image` prop. */
  objectFit?: string;
  /** @deprecated Legacy `next/image` prop. */
  objectPosition?: string;
  /** @deprecated Legacy `next/image` prop. */
  lazyBoundary?: string;
  /** @deprecated Legacy `next/image` prop. */
  lazyRoot?: string;
};

/**
 * Attributes for the rendered `<img>`, in `next/image`'s order (`src` last).
 * Names use React's camelCase; `toHtmlImgAttributes` converts them for other adapters.
 */
export type ImgProps = {
  [key: string]: unknown;
  loading: 'lazy' | 'eager' | undefined;
  fetchPriority?: 'high' | 'low' | 'auto';
  width: number | undefined;
  height: number | undefined;
  decoding?: 'async' | 'auto' | 'sync';
  className?: string;
  style: ImageStyle;
  sizes: string | undefined;
  srcSet: string | undefined;
  src: string;
};

export type ImageMeta = {
  unoptimized: boolean;
  /** `preload || priority`. */
  preload: boolean;
  placeholder: PlaceholderValue;
  fill: boolean;
};

export type ImgPropsResult = {
  props: ImgProps;
  meta: ImageMeta;
};

/** Component state that changes the result after load or error. */
export type ImageRenderState = {
  blurComplete?: boolean;
  showAltText?: boolean;
};

/** `<link rel="preload" as="image">` attributes for a preloaded image, HTML names. */
export type ImagePreloadLink = {
  /** Deduplication key: `imagesrcset + '\n' + imagesizes`, or `href`. */
  key: string;
  href?: string;
  imagesrcset?: string;
  imagesizes?: string;
  crossorigin?: string;
  referrerpolicy?: string;
  fetchpriority?: string;
};
