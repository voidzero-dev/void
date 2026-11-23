/**
 * `Image` for Vue: `next/image` from Next.js 16 as a render-function
 * component. `void/image` computes the attributes, so server and client
 * render the same `srcset`; this file only maps Vue props, attrs and
 * listeners onto it and ports the component's load, error and preload
 * behavior (`client/image-component.js`).
 */
import {
  createImagePreloadCollector,
  getImageConfig,
  getImagePreloadLink,
  getImageProps as getCoreImageProps,
  handleImageLoading,
  resolveImageProps,
  toHtmlImgAttributes,
  type ImageCoreProps,
  type ImageLoader,
  type ImagePreloadCollector,
  type ImageStyle,
  type ImgPropsResult,
  type PlaceholderValue,
  type StaticImport,
} from 'void/image';
import {
  camelize,
  defineComponent,
  h,
  inject,
  normalizeClass,
  normalizeStyle,
  onMounted,
  ref,
  ssrContextKey,
  type Component,
  type ImgHTMLAttributes,
  type PropType,
  type StyleValue,
} from 'vue';

export type {
  ImageLoader,
  ImageLoaderProps,
  PlaceholderValue,
  StaticImageData,
  StaticImport,
} from 'void/image';

/**
 * `Image` props: `next/image`'s props plus ordinary `<img>` attributes. Vue's
 * `class` and `style` (string, object or array) work as on `<img>`; React's
 * `className` and `fetchPriority` names are accepted too.
 */
export type ImageProps = Omit<
  ImgHTMLAttributes,
  'src' | 'srcset' | 'alt' | 'width' | 'height' | 'loading' | 'decoding' | 'sizes' | 'style'
> &
  Omit<ImageCoreProps, 'style' | 'onLoadingComplete'> & {
    style?: StyleValue;
    /** @deprecated Use `@load`. */
    onLoadingComplete?: (img: HTMLImageElement) => void;
    /** `blurDataURL` under the name a `blur-data-url` template attribute maps to. */
    blurDataUrl?: string;
  };

/**
 * The `<img>` attributes `Image` renders, with HTML names (`srcset`,
 * `fetchpriority`, `class`) and `style` as a CSS string, ready for
 * `v-bind` on an `<img>` or a `<picture>` `<source>`.
 */
export type ImageAttributes = {
  [attribute: string]: string | number | boolean | undefined;
  src: string;
  srcset?: string;
  sizes?: string;
  loading?: 'lazy' | 'eager';
  fetchpriority?: 'high' | 'low' | 'auto';
  width?: number;
  height?: number;
  decoding?: 'async' | 'auto' | 'sync';
  class?: string;
  style?: string;
};

/**
 * Property of Vue's SSR context (`renderToString(app, context)`) that holds
 * the render's image preload collector. The generated page and island
 * renderers read the same key to put the links into `<head>`.
 */
const SSR_PRELOADS_KEY = '__voidImagePreloads';

const LISTENER_RE = /^on[^a-z]/;

function callHandlers(handler: unknown, ...args: Array<unknown>): void {
  const handlers = Array.isArray(handler) ? handler : [handler];
  for (const fn of handlers) {
    if (typeof fn === 'function') {
      (fn as (...values: Array<unknown>) => unknown)(...args);
    }
  }
}

function hasHandler(handler: unknown): boolean {
  return Array.isArray(handler)
    ? handler.some((fn) => typeof fn === 'function')
    : typeof handler === 'function';
}

/** Vue `style` in any form as the camelCase style object `void/image` expects. */
function toImageStyle(value: unknown): ImageStyle | undefined {
  if (value == null || value === false || value === '') {
    return undefined;
  }
  // An array always normalizes to an object; strings become declarations.
  const normalized = normalizeStyle([value]) as Record<string, unknown>;
  const style: ImageStyle = {};
  for (const [name, item] of Object.entries(normalized)) {
    if (typeof item === 'string' || typeof item === 'number') {
      style[name.startsWith('--') ? name : camelize(name)] = item;
    }
  }
  return style;
}

/**
 * Vue props and attrs as `void/image` input: `class` and `className` become
 * `className`, `style` becomes an object, `fetchpriority` fills in
 * `fetchPriority` and `blurDataUrl` fills in `blurDataURL`, a user `srcset` is
 * dropped (as `next/image` drops `srcSet`), and event listeners other than
 * `onLoadingComplete` stay with the component. Other attributes keep their
 * order ahead of `Image`'s own.
 */
function toCoreProps(input: Record<string, unknown>): ImageCoreProps & Record<string, unknown> {
  const core: Record<string, unknown> = {};
  const classes: Array<unknown> = [];
  let style: ImageStyle | undefined;
  let fetchpriority: unknown;
  let blurDataUrl: unknown;
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) {
      continue;
    }
    switch (key) {
      case 'class':
      case 'className':
        classes.push(value);
        continue;
      case 'style':
        style = toImageStyle(value);
        continue;
      case 'srcset':
      case 'srcSet':
        continue;
      case 'fetchpriority':
        fetchpriority = value;
        continue;
      case 'blurDataUrl':
      case 'blur-data-url':
        blurDataUrl = value;
        continue;
      case 'onLoadingComplete':
        break;
      default:
        if (LISTENER_RE.test(key)) {
          continue;
        }
    }
    core[key] = value;
  }
  if (core.fetchPriority === undefined && fetchpriority !== undefined) {
    core.fetchPriority = fetchpriority;
  }
  if (core.blurDataURL === undefined && blurDataUrl !== undefined) {
    core.blurDataURL = blurDataUrl;
  }
  const className = normalizeClass(classes);
  if (className) {
    core.className = className;
  }
  if (style) {
    core.style = style;
  }
  return core as ImageCoreProps & Record<string, unknown>;
}

function preloadCollector(ssr: Record<string, unknown>): ImagePreloadCollector {
  let collector = ssr[SSR_PRELOADS_KEY] as ImagePreloadCollector | undefined;
  if (!collector) {
    collector = createImagePreloadCollector();
    ssr[SSR_PRELOADS_KEY] = collector;
  }
  return collector;
}

/** Next.js `ImageElement`'s attribute order after the passthrough attributes; `src` stays last. */
const ORDERED_ATTRIBUTES = [
  'fetchpriority',
  'loading',
  'width',
  'height',
  'decoding',
  'data-nimg',
  'class',
  'style',
  'sizes',
  'srcset',
  'src',
] as const;

/**
 * An optimized `<img>` with `next/image`'s props, defaults and markup
 * (`srcset`, `sizes`, lazy loading, `data-nimg`, placeholders). Listen with
 * `@load` (after the image is decoded) and `@error`. With `preload`, server
 * rendering adds a `<link rel="preload" as="image">` to `<head>`.
 */
export const Image: Component = defineComponent({
  name: 'VoidImage',
  inheritAttrs: false,
  props: {
    src: { type: [String, Object] as PropType<string | StaticImport>, required: true },
    alt: { type: String, required: true },
    width: { type: [Number, String] as PropType<number | `${number}`>, default: undefined },
    height: { type: [Number, String] as PropType<number | `${number}`>, default: undefined },
    quality: { type: [Number, String] as PropType<number | `${number}`>, default: undefined },
    // `default: undefined` keeps absent booleans unset instead of Vue's `false`.
    fill: { type: Boolean, default: undefined },
    preload: { type: Boolean, default: undefined },
    /** @deprecated Use `preload`. */
    priority: { type: Boolean, default: undefined },
    unoptimized: { type: Boolean, default: undefined },
    loader: { type: Function as PropType<ImageLoader>, default: undefined },
    sizes: { type: String, default: undefined },
    loading: { type: String as PropType<'lazy' | 'eager'>, default: undefined },
    placeholder: { type: String as PropType<PlaceholderValue>, default: undefined },
    blurDataURL: { type: String, default: undefined },
    // Vue camelizes a `blur-data-url` attribute to `blurDataUrl`, not `blurDataURL`.
    blurDataUrl: { type: String, default: undefined },
    overrideSrc: { type: String, default: undefined },
    decoding: { type: String as PropType<'async' | 'auto' | 'sync'>, default: undefined },
    fetchPriority: { type: String as PropType<'high' | 'low' | 'auto'>, default: undefined },
  },
  setup(props, { attrs }) {
    const ssr = inject<Record<string, unknown> | null>(ssrContextKey, null);
    const imgRef = ref<HTMLImageElement | null>(null);
    const blurComplete = ref(false);
    const showAltText = ref(false);
    let current: ImgPropsResult | undefined;

    function handleLoad(img: HTMLImageElement): void {
      const meta = current?.meta;
      if (!meta) {
        return;
      }
      handleImageLoading(img, {
        placeholder: meta.placeholder,
        unoptimized: meta.unoptimized,
        sizesInput: props.sizes,
        dev: getImageConfig().dev,
        onBlurComplete() {
          blurComplete.value = true;
        },
        onLoad(loaded) {
          if (hasHandler(attrs.onLoad)) {
            // The native event is gone by now (`decode()` resolved), so build one.
            const event = new Event('load');
            Object.defineProperty(event, 'target', { value: loaded });
            Object.defineProperty(event, 'currentTarget', { value: loaded });
            callHandlers(attrs.onLoad, event);
          }
          callHandlers(attrs.onLoadingComplete, loaded);
        },
      });
    }

    function onLoad(event: Event): void {
      handleLoad(event.currentTarget as HTMLImageElement);
    }

    function onError(event: Event): void {
      // If the image fails to load, show the alt text and drop the placeholder.
      showAltText.value = true;
      if (current && current.meta.placeholder !== 'empty') {
        blurComplete.value = true;
      }
      callHandlers(attrs.onError, event);
    }

    onMounted(() => {
      const img = imgRef.value;
      if (!img) {
        return;
      }
      // Vue does not replay `load` or `error` that fired before hydration.
      if (hasHandler(attrs.onError)) {
        // Setting `src` again retries the request, so a lost error fires again.
        // oxlint-disable-next-line no-self-assign
        img.src = img.src;
      }
      if (getImageConfig().dev) {
        if (!current?.props.src) {
          console.error(`Image is missing required "src" property:`, img);
        }
        if (img.getAttribute('alt') === null) {
          console.error(
            `Image is missing required "alt" property. Please add Alternative Text to describe the image for screen readers and search engines.`,
          );
        }
      }
      if (img.complete) {
        handleLoad(img);
      }
    });

    return () => {
      // `alt` leads the passthrough attributes, as in `next/image` markup.
      const input: Record<string, unknown> = { alt: props.alt };
      Object.assign(input, attrs, props);
      const result = resolveImageProps(toCoreProps(input), {
        blurComplete: blurComplete.value,
        showAltText: showAltText.value,
      });
      current = result;
      const { props: imgProps, meta } = result;
      if (ssr && meta.preload) {
        const link = getImagePreloadLink(imgProps, meta);
        if (link) {
          preloadCollector(ssr).add(link);
        }
      }

      const html: Record<string, unknown> = toHtmlImgAttributes(imgProps);
      html['data-nimg'] = meta.fill ? 'fill' : '1';
      const element: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(html)) {
        if (!(ORDERED_ATTRIBUTES as ReadonlyArray<string>).includes(key)) {
          element[key] = value;
        }
      }
      for (const [key, value] of Object.entries(attrs)) {
        if (
          LISTENER_RE.test(key) &&
          key !== 'onLoad' &&
          key !== 'onError' &&
          key !== 'onLoadingComplete'
        ) {
          element[key] = value;
        }
      }
      for (const key of ORDERED_ATTRIBUTES) {
        if (html[key] !== undefined) {
          element[key] = html[key];
        }
      }
      element.ref = imgRef;
      element.onLoad = onLoad;
      element.onError = onError;
      return h('img', element);
    };
  },
});

/**
 * The attributes `Image` would render for `props`, for another `<img>`, a
 * `<picture>` `<source>` or CSS (`next/image` `getImageProps`). Names are
 * HTML attribute names (`srcset`, `fetchpriority`, `class`) and `style` is a
 * CSS string, as Vue's `<img>` takes them; `data-nimg` is not included.
 */
export function getImageProps(props: ImageProps): { props: ImageAttributes } {
  const { props: imgProps } = getCoreImageProps(toCoreProps(props as Record<string, unknown>));
  return { props: toHtmlImgAttributes(imgProps) as ImageAttributes };
}
