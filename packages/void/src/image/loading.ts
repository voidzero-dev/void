/**
 * `handleImageLoading`, ported from `handleLoading` in Next.js 16
 * `client/image-component.js`: what every adapter's `Image` runs when the
 * `<img>` loads, or on mount when the server-rendered image already loaded.
 */
import { IMAGE_DOCS_URL } from './loader.ts';
import type { PlaceholderValue } from './types.ts';
import { warnOnce } from './warn-once.ts';

/** The parts of an `HTMLImageElement` `handleImageLoading` reads (this package has no DOM types). */
export type ImageElementLike = {
  readonly src: string;
  readonly isConnected: boolean;
  readonly parentElement: unknown;
  readonly width: number;
  readonly height: number;
  decode?: () => Promise<unknown>;
  getAttribute(name: string): string | null;
  getBoundingClientRect?: () => { width: number };
};

export type HandleImageLoadingOptions<T extends ImageElementLike = ImageElementLike> = {
  placeholder: PlaceholderValue;
  /** Called once per loaded `src`, after decoding, while the image is still connected. Adapters build their load event here and call `onLoadingComplete`. */
  onLoad?: (img: T) => void;
  /** Called before `onLoad` when the placeholder is not `empty`, to drop the placeholder background. */
  onBlurComplete?: () => void;
  /** Run the development warnings (`ClientImageConfig.dev`). */
  dev?: boolean;
  /** The `sizes` prop as passed to `Image`. */
  sizesInput?: string;
  unoptimized?: boolean;
};

/** Browser globals read by the development warnings. */
type BrowserGlobals = {
  window?: {
    innerWidth: number;
    getComputedStyle(element: unknown): { position: string };
  };
};

const LOADED_SRC = 'data-loaded-src';

/**
 * Finish loading an `<img>`: once per `src` (tracked with an expando
 * property, not an attribute), wait for `decode()`, then, unless the image was
 * removed meanwhile, end the blur placeholder and call `onLoad`.
 */
export function handleImageLoading<T extends ImageElementLike>(
  img: T | null | undefined,
  options: HandleImageLoadingOptions<T>,
): void {
  const src = img?.src;
  if (!img) {
    return;
  }
  const expando = img as unknown as Record<string, unknown>;
  if (expando[LOADED_SRC] === src) {
    return;
  }
  expando[LOADED_SRC] = src;
  const { placeholder, onLoad, onBlurComplete, dev, sizesInput, unoptimized } = options;
  const p = 'decode' in img && typeof img.decode === 'function' ? img.decode() : Promise.resolve();
  p.catch(() => {}).then(() => {
    if (!img.parentElement || !img.isConnected) {
      // Exit early in case of race condition:
      // - onload() is called
      // - decode() is called but incomplete
      // - unmount is called
      // - decode() completes
      return;
    }
    if (placeholder !== 'empty') {
      onBlurComplete?.();
    }
    onLoad?.(img);
    if (dev) {
      warnAfterLoad(img, src ?? '', sizesInput, unoptimized);
    }
  });
}

function warnAfterLoad(
  img: ImageElementLike,
  src: string,
  sizesInput: string | undefined,
  unoptimized: boolean | undefined,
): void {
  const browser = (globalThis as BrowserGlobals).window;
  let origSrc = src;
  try {
    origSrc = new URL(src, 'http://n').searchParams.get('url') || src;
  } catch {
    // Keep the raw src.
  }
  if (img.getAttribute('data-nimg') === 'fill') {
    if (!unoptimized && (!sizesInput || sizesInput === '100vw') && browser) {
      const widthViewportRatio = (img.getBoundingClientRect?.().width ?? 0) / browser.innerWidth;
      if (widthViewportRatio < 0.6) {
        if (sizesInput === '100vw') {
          warnOnce(
            `Image with src "${origSrc}" has "fill" prop and "sizes" prop of "100vw", but image is not rendered at full viewport width. Please adjust "sizes" to improve page performance. Read more: ${IMAGE_DOCS_URL}`,
          );
        } else {
          warnOnce(
            `Image with src "${origSrc}" has "fill" but is missing "sizes" prop. Please add it to improve page performance. Read more: ${IMAGE_DOCS_URL}`,
          );
        }
      }
    }
    if (img.parentElement && browser) {
      const { position } = browser.getComputedStyle(img.parentElement);
      const valid = ['absolute', 'fixed', 'relative'];
      if (!valid.includes(position)) {
        warnOnce(
          `Image with src "${origSrc}" has "fill" and parent element with invalid "position". Provided "${position}" should be one of ${valid
            .map(String)
            .join(',')}.`,
        );
      }
    }
    if (img.height === 0) {
      warnOnce(
        `Image with src "${origSrc}" has "fill" and a height value of 0. This is likely because the parent element of the image has not been styled to have a set height.`,
      );
    }
  }

  const heightModified = img.height.toString() !== img.getAttribute('height');
  const widthModified = img.width.toString() !== img.getAttribute('width');
  if ((heightModified && !widthModified) || (!heightModified && widthModified)) {
    warnOnce(
      `Image with src "${origSrc}" has either width or height modified, but not the other. If you use CSS to change the size of your image, also include the styles 'width: "auto"' or 'height: "auto"' to maintain the aspect ratio.`,
    );
  }
}
