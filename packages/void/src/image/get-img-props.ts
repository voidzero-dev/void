/**
 * `getImgProps`, ported from Next.js 16 `get-img-props.js`: the `<img>`
 * attributes every adapter's `Image` renders. Development checks are gated by
 * `imgConf.dev` instead of `NODE_ENV`, and messages name `Image` and
 * `void.config.ts`. Not ported: the `output: 'export'` error (where no
 * optimizer exists, `imgConf.noOptimizer` renders default-loader images
 * unoptimized instead), the `dpl` deployment-id query, and the
 * development blur URL (Void has no development blur endpoint).
 */
import { getImageBlurSvg } from './blur-svg.ts';
import type { ClientImageConfig } from './config.ts';
import { IMAGE_DOCS_URL } from './loader.ts';
import type {
  ImageCoreProps,
  ImageLoader,
  ImageLoaderPropsWithConfig,
  ImageLoaderWithConfig,
  ImageRenderState,
  ImageStyle,
  ImgPropsResult,
  PlaceholderValue,
  StaticImageData,
  StaticRequire,
} from './types.ts';
import { warnOnce } from './warn-once.ts';

/** Second argument of `getImgProps`. */
export type GetImgPropsState = ImageRenderState & {
  /** The loader used when the `loader` prop is not set. `undefined` means a `loaderFile` without a default export. */
  defaultLoader: ImageLoaderWithConfig | undefined;
  imgConf: Readonly<ClientImageConfig>;
};

const VALID_LOADING_VALUES = ['lazy', 'eager', undefined] as const;

// Object-fit values that are not valid background-size values
const INVALID_BACKGROUND_SIZE_VALUES: ReadonlyArray<unknown> = [
  '-moz-initial',
  'fill',
  'none',
  'scale-down',
  undefined,
];

function isStaticRequire(src: object): src is StaticRequire {
  return (src as StaticRequire).default !== undefined;
}

function isStaticImageData(src: object): src is StaticImageData {
  return (src as StaticImageData).src !== undefined;
}

function isStaticImport(src: unknown): src is StaticRequire | StaticImageData {
  return !!src && typeof src === 'object' && (isStaticRequire(src) || isStaticImageData(src));
}

type LcpImage = { src: string; loading: string | undefined; placeholder: PlaceholderValue };

const allImgs = new Map<string, LcpImage>();
let perfObserver: { observe(options: object): void } | undefined;

/** Browser globals read by the development LCP check (no DOM lib in this package). */
type BrowserGlobals = {
  window?: { location: { href: string } };
  PerformanceObserver?: new (
    callback: (list: { getEntries(): Array<{ element?: { src?: string } }> }) => void,
  ) => { observe(options: object): void };
};

function getInt(x: unknown): number | undefined {
  if (x === undefined) {
    return x;
  }
  if (typeof x === 'number') {
    return Number.isFinite(x) ? x : NaN;
  }
  if (typeof x === 'string' && /^[0-9]+$/.test(x)) {
    return parseInt(x, 10);
  }
  return NaN;
}

function getWidths(
  { deviceSizes, allSizes }: Readonly<ClientImageConfig>,
  width: number | undefined,
  sizes: string | undefined,
): { widths: Array<number>; kind: 'w' | 'x' } {
  if (sizes) {
    // Find all the "vw" percent sizes used in the sizes prop
    const viewportWidthRe = /(^|\s)(1?\d?\d)vw/g;
    const percentSizes: Array<number> = [];
    for (let match; (match = viewportWidthRe.exec(sizes)); match) {
      percentSizes.push(parseInt(match[2]));
    }
    if (percentSizes.length) {
      const smallestRatio = Math.min(...percentSizes) * 0.01;
      return {
        widths: allSizes.filter((s) => s >= deviceSizes[0] * smallestRatio),
        kind: 'w',
      };
    }
    return { widths: allSizes, kind: 'w' };
  }
  if (typeof width !== 'number') {
    return { widths: deviceSizes, kind: 'w' };
  }
  // 1x and 2x only: 3x images look the same on most screens and cost far more bytes.
  const widths = [
    ...new Set(
      [width, width * 2].map((w) => allSizes.find((p) => p >= w) || allSizes[allSizes.length - 1]),
    ),
  ];
  return { widths, kind: 'x' };
}

function generateImgAttrs({
  config,
  src,
  unoptimized,
  width,
  quality,
  sizes,
  loader,
}: {
  config: Readonly<ClientImageConfig>;
  src: string;
  unoptimized: boolean;
  width: number | undefined;
  quality: number | undefined;
  sizes: string | undefined;
  loader: ImageLoaderWithConfig;
}): { src: string; srcSet: string | undefined; sizes: string | undefined } {
  if (unoptimized) {
    return { src, srcSet: undefined, sizes: undefined };
  }

  const { widths, kind } = getWidths(config, width, sizes);
  const last = widths.length - 1;

  return {
    sizes: !sizes && kind === 'w' ? '100vw' : sizes,
    srcSet: widths
      .map(
        (w, i) =>
          `${loader({ config, src, quality, width: w })} ${kind === 'w' ? w : i + 1}${kind}`,
      )
      .join(', '),
    // `src` stays the last attribute: React applies attributes in order, and
    // Safari starts fetching `src` before `sizes` and `srcSet` are set otherwise.
    src: loader({ config, src, quality, width: widths[last] }),
  };
}

/**
 * The `<img>` props and render metadata for `Image` props. Shared by server and
 * client; `state` carries the loader, the config and the component's
 * `blurComplete` / `showAltText` state.
 */
export function getImgProps(
  {
    src,
    sizes,
    unoptimized = false,
    priority = false,
    preload = false,
    loading,
    className,
    quality,
    width,
    height,
    fill = false,
    style,
    overrideSrc,
    onLoad,
    onLoadingComplete,
    placeholder = 'empty',
    blurDataURL,
    fetchPriority,
    decoding = 'async',
    layout,
    objectFit,
    objectPosition,
    lazyBoundary,
    lazyRoot,
    ...rest
  }: ImageCoreProps & Record<string, unknown>,
  _state: GetImgPropsState,
): ImgPropsResult {
  const { imgConf: config, showAltText, blurComplete, defaultLoader } = _state;
  if (defaultLoader === undefined) {
    throw new Error(
      `images.loaderFile detected but the file is missing default export.\nRead more: ${IMAGE_DOCS_URL}`,
    );
  }
  const restProps = rest as Record<string, unknown>;
  let loader: ImageLoaderWithConfig =
    (restProps.loader as ImageLoaderWithConfig | undefined) || defaultLoader;
  // Remove property so it's not spread on <img> element
  delete restProps.loader;
  delete restProps.srcSet;

  // This marker means the user set neither a "loader" prop nor a loader file.
  const isDefaultLoader = '__void_img_default' in loader;

  if (isDefaultLoader) {
    if (config.loader === 'custom') {
      throw new Error(
        `Image with src "${String(src)}" is missing "loader" prop.` +
          `\nRead more: ${IMAGE_DOCS_URL}`,
      );
    }
  } else {
    // A user-defined loader never receives the internal config.
    const customImageLoader = loader as ImageLoader;
    loader = (obj: ImageLoaderPropsWithConfig) => {
      const { config: _, ...opts } = obj;
      return customImageLoader(opts);
    };
  }

  if (layout) {
    if (layout === 'fill') {
      fill = true;
    }
    const layoutToStyle: Record<string, ImageStyle | undefined> = {
      intrinsic: { maxWidth: '100%', height: 'auto' },
      responsive: { width: '100%', height: 'auto' },
    };
    const layoutToSizes: Record<string, string | undefined> = {
      responsive: '100vw',
      fill: '100vw',
    };
    const layoutStyle = layoutToStyle[layout];
    if (layoutStyle) {
      style = { ...style, ...layoutStyle };
    }
    const layoutSizes = layoutToSizes[layout];
    if (layoutSizes && !sizes) {
      sizes = layoutSizes;
    }
  }

  let staticSrc = '';
  let widthInt = getInt(width);
  let heightInt = getInt(height);
  let blurWidth: number | undefined;
  let blurHeight: number | undefined;
  if (isStaticImport(src)) {
    const staticImageData = isStaticRequire(src) ? src.default : src;

    if (!staticImageData.src) {
      throw new Error(
        `An object should only be passed to the image component src parameter if it comes from a static image import. It must include src. Received ${JSON.stringify(
          staticImageData,
        )}`,
      );
    }
    if (!staticImageData.height || !staticImageData.width) {
      throw new Error(
        `An object should only be passed to the image component src parameter if it comes from a static image import. It must include height and width. Received ${JSON.stringify(
          staticImageData,
        )}`,
      );
    }

    blurWidth = staticImageData.blurWidth;
    blurHeight = staticImageData.blurHeight;
    blurDataURL = blurDataURL || staticImageData.blurDataURL;
    staticSrc = staticImageData.src;

    if (!fill) {
      if (!widthInt && !heightInt) {
        widthInt = staticImageData.width;
        heightInt = staticImageData.height;
      } else if (widthInt && !heightInt) {
        const ratio = widthInt / staticImageData.width;
        heightInt = Math.round(staticImageData.height * ratio);
      } else if (!widthInt && heightInt) {
        const ratio = heightInt / staticImageData.height;
        widthInt = Math.round(staticImageData.width * ratio);
      }
    }
  }
  const srcString = typeof src === 'string' ? src : staticSrc;

  let isLazy = !priority && !preload && (loading === 'lazy' || loading === undefined);
  if (!srcString || srcString.startsWith('data:') || srcString.startsWith('blob:')) {
    // https://developer.mozilla.org/docs/Web/HTTP/Basics_of_HTTP/Data_URIs
    unoptimized = true;
    isLazy = false;
  }
  if (config.unoptimized) {
    unoptimized = true;
  }
  if (config.noOptimizer && isDefaultLoader) {
    // Nothing serves the default loader's URLs in this build; a `loader` prop still applies.
    unoptimized = true;
  }
  if (
    isDefaultLoader &&
    !config.dangerouslyAllowSVG &&
    srcString.split('?', 1)[0].endsWith('.svg')
  ) {
    // Serve SVG as-is instead of proxying it through the optimizer.
    unoptimized = true;
  }

  const qualityInt = getInt(quality);

  if (config.dev) {
    if (!srcString) {
      // There is no `src` to identify the image here, so the component logs
      // the element on mount instead.
      unoptimized = true;
    } else {
      if (fill) {
        if (width) {
          throw new Error(
            `Image with src "${srcString}" has both "width" and "fill" properties. Only one should be used.`,
          );
        }
        if (height) {
          throw new Error(
            `Image with src "${srcString}" has both "height" and "fill" properties. Only one should be used.`,
          );
        }
        if (style?.position && style.position !== 'absolute') {
          throw new Error(
            `Image with src "${srcString}" has both "fill" and "style.position" properties. Images with "fill" always use position absolute - it cannot be modified.`,
          );
        }
        if (style?.width && style.width !== '100%') {
          throw new Error(
            `Image with src "${srcString}" has both "fill" and "style.width" properties. Images with "fill" always use width 100% - it cannot be modified.`,
          );
        }
        if (style?.height && style.height !== '100%') {
          throw new Error(
            `Image with src "${srcString}" has both "fill" and "style.height" properties. Images with "fill" always use height 100% - it cannot be modified.`,
          );
        }
      } else {
        if (widthInt === undefined) {
          throw new Error(`Image with src "${srcString}" is missing required "width" property.`);
        } else if (isNaN(widthInt)) {
          throw new Error(
            `Image with src "${srcString}" has invalid "width" property. Expected a numeric value in pixels but received "${String(width)}".`,
          );
        }
        if (heightInt === undefined) {
          throw new Error(`Image with src "${srcString}" is missing required "height" property.`);
        } else if (isNaN(heightInt)) {
          throw new Error(
            `Image with src "${srcString}" has invalid "height" property. Expected a numeric value in pixels but received "${String(height)}".`,
          );
        }
        // oxlint-disable-next-line no-control-regex
        if (/^[\x00-\x20]/.test(srcString)) {
          throw new Error(
            `Image with src "${srcString}" cannot start with a space or control character. Use src.trimStart() to remove it or encodeURIComponent(src) to keep it.`,
          );
        }
        // oxlint-disable-next-line no-control-regex
        if (/[\x00-\x20]$/.test(srcString)) {
          throw new Error(
            `Image with src "${srcString}" cannot end with a space or control character. Use src.trimEnd() to remove it or encodeURIComponent(src) to keep it.`,
          );
        }
      }
    }
    if (!(VALID_LOADING_VALUES as ReadonlyArray<unknown>).includes(loading)) {
      throw new Error(
        `Image with src "${srcString}" has invalid "loading" property. Provided "${String(loading)}" should be one of ${VALID_LOADING_VALUES.map(
          String,
        ).join(',')}.`,
      );
    }
    if (priority && loading === 'lazy') {
      throw new Error(
        `Image with src "${srcString}" has both "priority" and "loading='lazy'" properties. Only one should be used.`,
      );
    }
    if (preload && loading === 'lazy') {
      throw new Error(
        `Image with src "${srcString}" has both "preload" and "loading='lazy'" properties. Only one should be used.`,
      );
    }
    if (preload && priority) {
      throw new Error(
        `Image with src "${srcString}" has both "preload" and "priority" properties. Only "preload" should be used.`,
      );
    }
    if (
      placeholder !== 'empty' &&
      placeholder !== 'blur' &&
      !String(placeholder).startsWith('data:image/')
    ) {
      throw new Error(
        `Image with src "${srcString}" has invalid "placeholder" property "${String(placeholder)}".`,
      );
    }
    if (placeholder !== 'empty') {
      if (widthInt && heightInt && widthInt * heightInt < 1600) {
        warnOnce(
          `Image with src "${srcString}" is smaller than 40x40. Consider removing the "placeholder" property to improve performance.`,
        );
      }
    }
    if (qualityInt && config.qualities && !config.qualities.includes(qualityInt)) {
      warnOnce(
        `Image with src "${srcString}" is using quality "${qualityInt}" which is not configured in images.qualities [${config.qualities.join(
          ', ',
        )}]. Please update your config to [${[...config.qualities, qualityInt].sort().join(', ')}].` +
          `\nRead more: ${IMAGE_DOCS_URL}`,
      );
    }
    if (placeholder === 'blur' && !blurDataURL) {
      const VALID_BLUR_EXT = ['jpeg', 'png', 'webp', 'avif']; // should match next-image-loader

      throw new Error(
        `Image with src "${srcString}" has "placeholder='blur'" property but is missing the "blurDataURL" property.
        Possible solutions:
          - Add a "blurDataURL" property, the contents should be a small Data URL to represent the image
          - Change the "src" property to a static import with one of the supported file types: ${VALID_BLUR_EXT.join(
            ',',
          )} (animated images not supported)
          - Remove the "placeholder" property, effectively no blur effect
        Read more: ${IMAGE_DOCS_URL}`,
      );
    }
    if ('ref' in restProps) {
      warnOnce(
        `Image with src "${srcString}" is using unsupported "ref" property. Consider using the "onLoad" property instead.`,
      );
    }

    if (!unoptimized && !isDefaultLoader) {
      const urlStr = loader({
        config,
        src: srcString,
        width: widthInt || 400,
        quality: qualityInt || 75,
      });
      let url: URL | undefined;
      try {
        url = new URL(urlStr);
      } catch {
        // Not an absolute URL.
      }
      if (urlStr === srcString || (url && url.pathname === srcString && !url.search)) {
        warnOnce(
          `Image with src "${srcString}" has a "loader" property that does not implement width. Please implement it or use the "unoptimized" property instead.` +
            `\nRead more: ${IMAGE_DOCS_URL}`,
        );
      }
    }

    if (onLoadingComplete) {
      warnOnce(
        `Image with src "${srcString}" is using deprecated "onLoadingComplete" property. Please use the "onLoad" property instead.`,
      );
    }

    for (const [legacyKey, legacyValue] of Object.entries({
      layout,
      objectFit,
      objectPosition,
      lazyBoundary,
      lazyRoot,
    })) {
      if (legacyValue) {
        warnOnce(
          `Image with src "${srcString}" has legacy prop "${legacyKey}". Did you forget to run the codemod?` +
            `\nRead more: ${IMAGE_DOCS_URL}`,
        );
      }
    }

    observeLargestContentfulPaint();
  }

  const imgStyle: ImageStyle = Object.assign(
    fill
      ? {
          position: 'absolute',
          height: '100%',
          width: '100%',
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          objectFit,
          objectPosition,
        }
      : {},
    showAltText ? {} : { color: 'transparent' },
    style,
  );

  const backgroundImage =
    !blurComplete && placeholder !== 'empty'
      ? placeholder === 'blur'
        ? `url("data:image/svg+xml;charset=utf-8,${getImageBlurSvg({
            widthInt,
            heightInt,
            blurWidth,
            blurHeight,
            blurDataURL: blurDataURL || '', // assume not undefined
            objectFit: imgStyle.objectFit,
          })}")`
        : `url("${placeholder}")` // assume `data:image/`
      : null;

  const backgroundSize = !INVALID_BACKGROUND_SIZE_VALUES.includes(imgStyle.objectFit)
    ? imgStyle.objectFit
    : imgStyle.objectFit === 'fill'
      ? '100% 100%' // the background-size equivalent of `fill`
      : 'cover';

  const placeholderStyle: ImageStyle = backgroundImage
    ? {
        backgroundSize,
        backgroundPosition: imgStyle.objectPosition || '50% 50%',
        backgroundRepeat: 'no-repeat',
        backgroundImage,
      }
    : {};

  const imgAttributes = generateImgAttrs({
    config,
    src: srcString,
    unoptimized,
    width: widthInt,
    quality: qualityInt,
    sizes,
    loader,
  });

  const loadingFinal = isLazy ? 'lazy' : loading;

  if (config.dev) {
    const browser = globalThis as BrowserGlobals;
    if (browser.window !== undefined) {
      let fullUrl: URL;
      try {
        fullUrl = new URL(imgAttributes.src);
      } catch {
        fullUrl = new URL(imgAttributes.src, browser.window.location.href);
      }
      allImgs.set(fullUrl.href, { src: srcString, loading: loadingFinal, placeholder });
    }
  }

  const props = {
    ...restProps,
    loading: loadingFinal,
    fetchPriority,
    width: widthInt,
    height: heightInt,
    decoding,
    className,
    style: { ...imgStyle, ...placeholderStyle },
    sizes: imgAttributes.sizes,
    srcSet: imgAttributes.srcSet,
    src: overrideSrc || imgAttributes.src,
  };
  const meta = {
    unoptimized,
    preload: preload || priority,
    placeholder,
    fill,
  };
  return { props, meta };
}

/** Development only: warn when a lazy image is the Largest Contentful Paint. Set up once per page. */
function observeLargestContentfulPaint(): void {
  const browser = globalThis as BrowserGlobals;
  if (browser.window === undefined || perfObserver || !browser.PerformanceObserver) {
    return;
  }
  perfObserver = new browser.PerformanceObserver((entryList) => {
    for (const entry of entryList.getEntries()) {
      const imgSrc = entry?.element?.src || '';
      const lcpImage = allImgs.get(imgSrc);
      if (
        lcpImage &&
        lcpImage.loading === 'lazy' &&
        lcpImage.placeholder === 'empty' &&
        !lcpImage.src.startsWith('data:') &&
        !lcpImage.src.startsWith('blob:')
      ) {
        // https://web.dev/lcp/#measure-lcp-in-javascript
        warnOnce(
          `Image with src "${lcpImage.src}" was detected as the Largest Contentful Paint (LCP). Please add the \`loading="eager"\` property if this image is above the fold.` +
            `\nRead more: ${IMAGE_DOCS_URL}`,
        );
      }
    }
  });
  try {
    perfObserver.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (err) {
    // Log error but don't crash the app
    console.error(err);
  }
}
