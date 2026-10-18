import type { ClassValue, HTMLImgAttributes } from 'svelte/elements';
import {
  getImageProps as getCoreImageProps,
  toHtmlImgAttributes,
  type ImageCoreProps,
  type ImageStyle,
  type ImgPropsResult,
} from 'void/image';

type ImageEventHandler = (
  event: Event & { currentTarget: EventTarget & HTMLImageElement },
) => unknown;

/**
 * `Image` props: the `next/image` props, with Svelte's names for `class`,
 * `style` (a string or a style object) and the `onload` / `onerror` events,
 * plus any other `<img>` attribute.
 */
export type ImageProps = Omit<
  HTMLImgAttributes,
  keyof ImageCoreProps | 'children' | 'class' | 'style' | 'srcset' | 'onload' | 'onerror'
> &
  Omit<ImageCoreProps, 'className' | 'style' | 'onLoadingComplete'> & {
    class?: ClassValue | null;
    style?: string | ImageStyle | null;
    /** Runs once the image has loaded and decoded, as in `next/image`. */
    onload?: ImageEventHandler | null;
    onerror?: ImageEventHandler | null;
    /** @deprecated Use `onload`. */
    onLoadingComplete?: (img: HTMLImageElement) => void;
  };

/** `<img>` attributes returned by `getImageProps`, with HTML names, for `<img {...props} />`. */
export type ImgAttributes = {
  [attribute: string]: unknown;
  loading?: 'lazy' | 'eager';
  fetchpriority?: 'high' | 'low' | 'auto';
  width?: number;
  height?: number;
  decoding?: 'async' | 'auto' | 'sync';
  class?: ClassValue;
  style?: string;
  sizes?: string;
  srcset?: string;
  src: string;
};

function toStyleKey(name: string): string {
  if (name.startsWith('--')) {
    return name;
  }
  // React's names: `-webkit-line-clamp` is `WebkitLineClamp`, `-ms-transform` is `msTransform`.
  const key = name.toLowerCase().replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return key.startsWith('Ms') ? `ms${key.slice(2)}` : key;
}

/**
 * A `style` attribute value as a style object (`object-fit` becomes
 * `objectFit`), so `Image` merges it with its own styles and reads
 * `object-fit` / `object-position` as `next/image` reads `style`.
 */
export function parseStyle(style: string): ImageStyle {
  const result: ImageStyle = {};
  let declaration = '';
  let quote = '';
  let depth = 0;
  const add = () => {
    const colon = declaration.indexOf(':');
    const name = declaration.slice(0, colon).trim();
    const value = declaration.slice(colon + 1).trim();
    if (colon > 0 && name && value) {
      result[toStyleKey(name)] = value;
    }
    declaration = '';
  };
  for (const char of style) {
    if (quote) {
      if (char === quote) {
        quote = '';
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    } else if (char === ';' && depth === 0) {
      add();
      continue;
    }
    declaration += char;
  }
  add();
  return result;
}

/**
 * `Image` props as `void/image` props: `class` becomes `className`, a
 * `style` string becomes a style object, `fetchpriority` becomes
 * `fetchPriority`. `srcset` is dropped (`Image` computes it) and so is
 * `onload`, which `Image` calls after decoding (as `next/image` drops `onLoad`).
 */
export function toCoreImageProps(
  props: Record<PropertyKey, unknown>,
): ImageCoreProps & Record<string, unknown> {
  const {
    class: className,
    style,
    fetchpriority,
    srcset: _srcset,
    onload: _onload,
    ...rest
  } = props;
  const core: Record<PropertyKey, unknown> = rest;
  if (className != null) {
    core.className = className;
  }
  if (typeof style === 'string') {
    core.style = parseStyle(style);
  } else if (style != null) {
    core.style = style;
  }
  if (core.fetchPriority === undefined && fetchpriority != null) {
    core.fetchPriority = fetchpriority;
  }
  return core as ImageCoreProps & Record<string, unknown>;
}

/**
 * `void/image` `<img>` props as Svelte element attributes: HTML names, a
 * `style` string, the `class` value as given (Svelte resolves arrays and
 * objects), in the same order. Event handlers and symbol-keyed props
 * (attachments) pass through; `undefined` values are dropped.
 */
export function toSvelteImgAttributes(props: Record<PropertyKey, unknown>): ImgAttributes {
  const attributes: Record<PropertyKey, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key === 'className') {
      if (value != null) {
        attributes.class = value;
      }
    } else if (typeof value === 'function') {
      attributes[key] = value;
    } else {
      Object.assign(attributes, toHtmlImgAttributes({ [key]: value }));
    }
  }
  for (const symbol of Object.getOwnPropertySymbols(props)) {
    attributes[symbol] = props[symbol];
  }
  return attributes as ImgAttributes;
}

/**
 * The attributes `Image` renders on its `<img>`, in `next/image`'s order:
 * other attributes, `fetchpriority`, `loading`, `width`, `height`,
 * `decoding`, `data-nimg`, `class`, `style`, `sizes`, `srcset`, and `src`
 * last, so browsers do not fetch `src` before `srcset` and `sizes` are set.
 */
export function getImgAttributes({ props, meta }: ImgPropsResult): ImgAttributes {
  const {
    fetchPriority,
    loading,
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
  return toSvelteImgAttributes({
    ...rest,
    fetchPriority,
    loading,
    width,
    height,
    decoding,
    'data-nimg': meta.fill ? 'fill' : '1',
    className,
    style,
    sizes,
    srcSet,
    src,
  });
}

/** The `load` event `Image` passes to `onload` after decoding, like `next/image`. */
export function createImageLoadEvent(
  img: HTMLImageElement,
): Event & { currentTarget: EventTarget & HTMLImageElement } {
  const event = new Event('load');
  Object.defineProperty(event, 'target', { value: img });
  Object.defineProperty(event, 'currentTarget', { value: img });
  return event as Event & { currentTarget: EventTarget & HTMLImageElement };
}

/**
 * The attributes `Image` would render on its `<img>` (without `data-nimg`),
 * for another element, a `<picture>` source or CSS. Names are HTML attribute
 * names (`srcset`, `fetchpriority`, `class`) and `style` is a string, so the
 * result spreads onto `<img {...props} />`. `onload` is not included.
 */
export function getImageProps(props: ImageProps): { props: ImgAttributes } {
  const { props: imgProps } = getCoreImageProps(toCoreImageProps(props));
  return { props: toSvelteImgAttributes(imgProps) };
}
