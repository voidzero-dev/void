/**
 * `Image` for Solid: `next/image` from Next.js 16. `image-props.ts` maps the
 * props onto `void/image`; this file ports the component's load, error and
 * preload behavior (`client/image-component.js`).
 */
import {
  batch,
  createMemo,
  createSignal,
  onMount,
  splitProps,
  useContext,
  type JSX,
} from 'solid-js';
import { isServer } from 'solid-js/web';
import {
  getImageConfig,
  getImagePreloadLink,
  handleImageLoading,
  resolveImageProps,
  type ImageCoreProps,
} from 'void/image';
import { ImagePreloadContext } from './context.ts';
import { toImageCoreProps, toImageElementAttributes, type ImageProps } from './image-props.ts';

export {
  getImageProps,
  type ImageAttributes,
  type ImageLoader,
  type ImageLoaderProps,
  type ImageProps,
  type PlaceholderValue,
  type StaticImageData,
  type StaticImport,
} from './image-props.ts';

/** Call a Solid event handler: a function, or a `[handler, data]` pair. */
function callHandler(handler: unknown, event: Event): void {
  if (Array.isArray(handler)) {
    const [fn, data] = handler;
    if (typeof fn === 'function') {
      fn(data, event);
    }
  } else if (typeof handler === 'function') {
    handler(event);
  }
}

/** A `load` event targeting `img`, for `onLoad` handlers called after decoding. */
function createLoadEvent(img: HTMLImageElement): Event {
  const event = new Event('load');
  Object.defineProperty(event, 'target', { writable: false, value: img });
  Object.defineProperty(event, 'currentTarget', { writable: false, value: img });
  return event;
}

/**
 * An `<img>` with a responsive `srcset` from the image optimizer, lazy
 * loading, an optional blur placeholder and an optional preload link.
 * `onLoad` runs once the image is decoded, also for an image that finished
 * loading before hydration.
 */
export function Image(props: ImageProps): JSX.Element {
  const [local, others] = splitProps(props, [
    'ref',
    'onLoad',
    'onload',
    'onError',
    'onerror',
    'onLoadingComplete',
  ]);
  const [blurComplete, setBlurComplete] = createSignal(false);
  const [showAltText, setShowAltText] = createSignal(false);
  const resolved = createMemo(() =>
    resolveImageProps(
      // `onLoadingComplete` only reaches the core for its deprecation warning.
      {
        ...toImageCoreProps(others),
        onLoadingComplete: local.onLoadingComplete as ImageCoreProps['onLoadingComplete'],
      },
      { blurComplete: blurComplete(), showAltText: showAltText() },
    ),
  );
  const attributes = createMemo(() => toImageElementAttributes(resolved()));

  if (isServer) {
    // The page renderer puts collected links into `<head>`. Islands render
    // on the server too, so their preloads land there as well.
    const preloads = useContext(ImagePreloadContext);
    if (preloads) {
      const { props: imgProps, meta } = resolved();
      const link = getImagePreloadLink(imgProps, meta);
      if (link) {
        preloads.add(link);
      }
    }
  }

  let img: HTMLImageElement | undefined;

  function finishLoading(element: HTMLImageElement): void {
    const { meta } = resolved();
    handleImageLoading(element, {
      placeholder: meta.placeholder,
      unoptimized: meta.unoptimized,
      sizesInput: others.sizes,
      dev: getImageConfig().dev,
      onBlurComplete: () => setBlurComplete(true),
      onLoad: (target) => {
        if (local.onLoad || local.onload) {
          const event = createLoadEvent(target);
          callHandler(local.onLoad, event);
          callHandler(local.onload, event);
        }
        local.onLoadingComplete?.(target);
      },
    });
  }

  function onError(event: Event): void {
    batch(() => {
      // If the real image fails to load, this will ensure "alt" is visible
      setShowAltText(true);
      if (resolved().meta.placeholder !== 'empty') {
        // If the real image fails to load, this will still remove the placeholder.
        setBlurComplete(true);
      }
    });
    callHandler(local.onError, event);
    callHandler(local.onerror, event);
  }

  onMount(() => {
    const element = img;
    if (!element) {
      return;
    }
    // Replay events from before hydration, which Solid does not replay.
    if (local.onError || local.onerror) {
      // If the image has an error before hydration, the error is lost.
      // Setting the src again retries the request and triggers the error
      // handler if it fails again.
      // oxlint-disable-next-line no-self-assign
      element.src = element.src;
    }
    if (getImageConfig().dev) {
      if (!resolved().props.src) {
        console.error(`Image is missing required "src" property:`, element);
      }
      if (element.getAttribute('alt') === null) {
        console.error(
          `Image is missing required "alt" property. Please add Alternative Text to describe the image for screen readers and search engines.`,
        );
      }
    }
    if (element.complete) {
      finishLoading(element);
    }
  });

  return (
    <img
      {...attributes()}
      ref={(element) => {
        img = element;
        if (typeof local.ref === 'function') {
          local.ref(element);
        }
      }}
      onLoad={(event) => finishLoading(event.currentTarget)}
      onError={onError}
    />
  );
}
