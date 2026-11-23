/**
 * The JSX-free half of the Solid `Image`: its prop types, the mapping between
 * Solid props and `void/image`, and `getImageProps`. `void/image` computes the
 * attributes, so server and client render the same `srcset`.
 */
import type { JSX } from 'solid-js';
import {
  getImageProps as getCoreImageProps,
  toHtmlImgAttributes,
  type ImageCoreProps,
  type ImageStyle,
  type ImgProps,
  type ImgPropsResult,
} from 'void/image';

export type {
  ImageLoader,
  ImageLoaderProps,
  PlaceholderValue,
  StaticImageData,
  StaticImport,
} from 'void/image';

type ImgAttributes = JSX.ImgHTMLAttributes<HTMLImageElement>;

/**
 * `Image` props: `next/image`'s props plus ordinary Solid `<img>` attributes.
 * `class`, `fetchpriority` and `style` (string or object) work as on `<img>`;
 * `next/image`'s `className` and `fetchPriority` are accepted too.
 */
export type ImageProps = Omit<ImgAttributes, keyof ImageCoreProps | 'srcset' | 'srcSet'> &
  Omit<ImageCoreProps, 'style' | 'onLoadingComplete'> & {
    style?: JSX.CSSProperties | string;
    /** @deprecated Use `onLoad`. */
    onLoadingComplete?: (img: HTMLImageElement) => void;
  };

/**
 * The `<img>` attributes `Image` renders, with HTML names (`srcset`,
 * `fetchpriority`, `class`) and `style` as a CSS string. Spread them on an
 * `<img>`, or use `srcset` on a `<picture>` `<source>`.
 */
export type ImageAttributes = Omit<
  ImgAttributes,
  'src' | 'srcSet' | 'width' | 'height' | 'style' | 'loading'
> & {
  loading?: 'lazy' | 'eager';
  width?: number;
  height?: number;
  style?: string;
  src: string;
};

/** What `Image` spreads on its `<img>`: `ImageAttributes` plus `data-nimg`. */
export type ImageElementAttributes = ImageAttributes & { 'data-nimg': '1' | 'fill' };

// Vue's `parseStringStyle`: `;` outside parentheses ends a declaration.
const STYLE_DECLARATION_DELIMITER = /;(?![^(]*\))/g;
const STYLE_PROPERTY_DELIMITER = /:([\s\S]+)/;
const STYLE_COMMENT = /\/\*[\s\S]*?\*\//g;

/** A CSS property name in the camelCase form `void/image` reads (`object-fit` → `objectFit`). */
function toStyleKey(name: string): string {
  if (name.startsWith('--') || !name.includes('-')) {
    return name;
  }
  const camel = name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  // React spells the `-ms-` prefix in lowercase (`msTransform`), others capitalized (`WebkitMask`).
  return name.startsWith('-ms-') ? `m${camel.slice(1)}` : camel;
}

/**
 * A Solid `style` value (a CSS string, or an object with kebab-case or
 * camelCase names) as the camelCase object `void/image` merges with its own
 * styles. Returns `undefined` for an empty value.
 */
export function toImageStyle(style: unknown): ImageStyle | undefined {
  const result: ImageStyle = {};
  if (typeof style === 'string') {
    for (const declaration of style.replace(STYLE_COMMENT, '').split(STYLE_DECLARATION_DELIMITER)) {
      const [name, value] = declaration.split(STYLE_PROPERTY_DELIMITER);
      if (value !== undefined && name.trim() && value.trim()) {
        result[toStyleKey(name.trim())] = value.trim();
      }
    }
  } else if (style && typeof style === 'object') {
    for (const [name, value] of Object.entries(style)) {
      if (typeof value === 'string' || typeof value === 'number') {
        result[toStyleKey(name)] = value;
      }
    }
  }
  return Object.keys(result).length ? result : undefined;
}

/**
 * Solid `Image` props as `void/image` input: `class` and `className` join
 * into `className`, `style` becomes a camelCase object, `fetchpriority` fills
 * in `fetchPriority`, and `srcset`, `ref` and `onload` are dropped (as
 * `next/image` drops `srcSet` and `onLoad`). Other props keep their order and
 * stay ahead of `Image`'s own attributes.
 */
export function toImageCoreProps(
  props: Record<string, unknown>,
): ImageCoreProps & Record<string, unknown> {
  const core: Record<string, unknown> = {};
  const classes: Array<string> = [];
  let fetchpriority: unknown;
  for (const key of Object.keys(props)) {
    const value = props[key];
    if (value === undefined) {
      continue;
    }
    switch (key) {
      case 'class':
      case 'className':
        if (typeof value === 'string' && value) {
          classes.push(value);
        }
        break;
      case 'style':
        core.style = toImageStyle(value);
        break;
      case 'fetchpriority':
        fetchpriority = value;
        break;
      case 'srcset':
      case 'srcSet':
      case 'ref':
      case 'onload':
        break;
      default:
        core[key] = value;
    }
  }
  if (classes.length) {
    core.className = classes.join(' ');
  }
  if (core.fetchPriority === undefined && fetchpriority !== undefined) {
    core.fetchPriority = fetchpriority;
  }
  return core as ImageCoreProps & Record<string, unknown>;
}

/**
 * `void/image` props for Solid: the attributes `Image` computes get HTML names
 * and a CSS string `style`; the other props pass through unchanged, first.
 */
function toImageAttributes(props: ImgProps, nimg?: '1' | 'fill'): ImageAttributes {
  const {
    loading,
    fetchPriority,
    width,
    height,
    decoding,
    className,
    style,
    sizes,
    srcSet,
    src,
    ...rest
  } = props;
  // `next/image` renders `fetchPriority` before `loading` and `data-nimg`
  // after `decoding`; `getImageProps` keeps `getImgProps`'s order.
  const own = nimg
    ? {
        fetchPriority,
        loading,
        width,
        height,
        decoding,
        'data-nimg': nimg,
        className,
        style,
        sizes,
        srcSet,
        src,
      }
    : { loading, fetchPriority, width, height, decoding, className, style, sizes, srcSet, src };
  return { ...rest, ...toHtmlImgAttributes(own) } as ImageAttributes;
}

/**
 * The attributes `Image` spreads on its `<img>`, in `next/image`'s order:
 * other props first, then `fetchpriority`, `loading`, `width`, `height`,
 * `decoding`, `data-nimg`, `class`, `style`, `sizes`, `srcset` and `src`
 * last (Safari starts fetching `src` before `srcset` is set otherwise).
 */
export function toImageElementAttributes(result: ImgPropsResult): ImageElementAttributes {
  return toImageAttributes(result.props, result.meta.fill ? 'fill' : '1') as ImageElementAttributes;
}

/**
 * The attributes `Image` would render, for another element, a `<picture>`
 * `<source>` or CSS (`next/image` `getImageProps`), with Solid's HTML
 * attribute names: `srcset`, `fetchpriority`, `class`, and `style` as a CSS
 * string. Attributes without a value are omitted.
 */
export function getImageProps(props: ImageProps): { props: ImageAttributes } {
  const { props: imgProps } = getCoreImageProps(toImageCoreProps(props as Record<string, unknown>));
  return { props: toImageAttributes(imgProps) };
}
