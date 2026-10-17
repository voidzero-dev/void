/**
 * `Image` and `getImageProps`, matching `next/image` in Next.js 16. Ported from
 * Next.js `client/image-component.js` (MIT) for React 19: `fetchPriority` is
 * camelCase, `ref` is an ordinary prop, and preloads always use
 * `ReactDOM.preload` (Next.js App Router behavior). The props themselves come
 * from `void/image`, which reads the images config registered by the Void
 * plugin, so server and client compute the same `srcSet`.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type JSX,
  type ReactEventHandler,
  type Ref,
  type RefAttributes,
  type RefObject,
  type SetStateAction,
  type SyntheticEvent,
} from 'react';
import { preload, type PreloadOptions } from 'react-dom';
import {
  getImageConfig,
  getImageProps as getCoreImageProps,
  handleImageLoading,
  resolveImageProps,
  type ImageCoreProps,
  type ImageLoader,
  type ImageLoaderProps,
  type PlaceholderValue,
  type StaticImageData,
  type StaticImport,
} from 'void/image';

export type { ImageLoader, ImageLoaderProps, StaticImageData };

type LoadingValue = 'lazy' | 'eager' | undefined;

type OnLoadingComplete = (img: HTMLImageElement) => void;

/** Props of `Image`: `<img>` attributes plus the `next/image` props. */
export type ImageProps = Omit<
  JSX.IntrinsicElements['img'],
  'src' | 'srcSet' | 'ref' | 'alt' | 'width' | 'height' | 'loading'
> & {
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
  loading?: LoadingValue;
  placeholder?: PlaceholderValue;
  blurDataURL?: string;
  unoptimized?: boolean;
  overrideSrc?: string;
  /** @deprecated Use `onLoad`. */
  onLoadingComplete?: OnLoadingComplete;
  /** @deprecated Use `fill`, or `style` for the other `next/legacy/image` layouts. */
  layout?: string;
  /** @deprecated Use `style`. */
  objectFit?: string;
  /** @deprecated Use `style`. */
  objectPosition?: string;
  /** @deprecated This prop does nothing. */
  lazyBoundary?: string;
  /** @deprecated This prop does nothing. */
  lazyRoot?: string;
};

/** The `<img>` props `getImageProps` returns (React attribute names). */
type ImgProps = Omit<ImageProps, 'src' | 'loader'> & {
  loading: LoadingValue;
  width: number | undefined;
  height: number | undefined;
  style: CSSProperties;
  sizes: string | undefined;
  srcSet: string | undefined;
  src: string;
};

type OnLoad = ReactEventHandler<HTMLImageElement> | undefined;

// The core types `style` as a plain record and has no React event types.
function toCoreProps(props: ImageProps): ImageCoreProps & Record<string, unknown> {
  return props as unknown as ImageCoreProps & Record<string, unknown>;
}

// See https://stackoverflow.com/q/39777833/266535 for why we use this ref
// handler instead of the img's onLoad attribute.
function handleLoading(
  img: HTMLImageElement,
  placeholder: PlaceholderValue,
  onLoadRef: RefObject<OnLoad>,
  onLoadingCompleteRef: RefObject<OnLoadingComplete | undefined>,
  setBlurComplete: (b: boolean) => void,
  unoptimized: boolean,
  sizesInput: string | undefined,
): void {
  handleImageLoading(img, {
    placeholder,
    onBlurComplete: () => setBlurComplete(true),
    onLoad: (loaded) => {
      if (onLoadRef.current) {
        // Since we don't have the SyntheticEvent here,
        // we must create one with the same shape.
        // See https://reactjs.org/docs/events.html
        const event = new Event('load');
        Object.defineProperty(event, 'target', { writable: false, value: loaded });
        let prevented = false;
        let stopped = false;
        onLoadRef.current({
          ...event,
          nativeEvent: event,
          currentTarget: loaded,
          target: loaded,
          isDefaultPrevented: () => prevented,
          isPropagationStopped: () => stopped,
          persist: () => {},
          preventDefault: () => {
            prevented = true;
            event.preventDefault();
          },
          stopPropagation: () => {
            stopped = true;
            event.stopPropagation();
          },
        } as unknown as SyntheticEvent<HTMLImageElement, Event>);
      }
      onLoadingCompleteRef.current?.(loaded);
    },
    dev: getImageConfig().dev,
    sizesInput,
    unoptimized,
  });
}

function applyRef<T>(ref: Ref<T>, current: T): () => void {
  if (typeof ref === 'function') {
    const cleanup = ref(current);
    return typeof cleanup === 'function' ? cleanup : () => ref(null);
  }
  if (ref) {
    ref.current = current;
  }
  return () => {
    if (ref) {
      ref.current = null;
    }
  };
}

// Always wrap user refs: a ref that returns a cleanup function must not leak
// into ref-merging code written before React 19.
function useMergedRef<T>(
  refA: Ref<T> | undefined,
  refB: Ref<T> | undefined,
): (current: T | null) => void {
  const cleanupA = useRef<(() => void) | null>(null);
  const cleanupB = useRef<(() => void) | null>(null);
  return useCallback(
    (current: T | null) => {
      if (current === null) {
        const cleanupFnA = cleanupA.current;
        if (cleanupFnA) {
          cleanupA.current = null;
          cleanupFnA();
        }
        const cleanupFnB = cleanupB.current;
        if (cleanupFnB) {
          cleanupB.current = null;
          cleanupFnB();
        }
      } else {
        if (refA) {
          cleanupA.current = applyRef(refA, current);
        }
        if (refB) {
          cleanupB.current = applyRef(refB, current);
        }
      }
    },
    [refA, refB],
  );
}

type ImageElementProps = ImgProps & {
  unoptimized: boolean;
  placeholder: PlaceholderValue;
  fill: boolean;
  onLoadRef: RefObject<OnLoad>;
  onLoadingCompleteRef: RefObject<OnLoadingComplete | undefined>;
  setBlurComplete: Dispatch<SetStateAction<boolean>>;
  setShowAltText: Dispatch<SetStateAction<boolean>>;
  sizesInput: string | undefined;
  forwardedRef: Ref<HTMLImageElement | null> | undefined;
};

function ImageElement({
  src,
  srcSet,
  sizes,
  height,
  width,
  decoding,
  className,
  style,
  fetchPriority,
  placeholder,
  loading,
  unoptimized,
  fill,
  onLoadRef,
  onLoadingCompleteRef,
  setBlurComplete,
  setShowAltText,
  sizesInput,
  onLoad: _onLoad,
  onError,
  forwardedRef,
  ...rest
}: ImageElementProps): JSX.Element {
  const didInsertRef = useRef(false);
  const insertedImgRef = useRef<HTMLImageElement | null>(null);

  useLayoutEffect(() => {
    const { current: didInsert } = didInsertRef;
    const { current: img } = insertedImgRef;
    if (!didInsert && img !== null) {
      // Replay events from during hydration that React doesn't replay.
      if (onError) {
        // If the image has an error before react hydrates, then the error is lost.
        // The workaround is to wait until the image is mounted which is after hydration,
        // then we set the src again to trigger the error handler (if there was an error).
        // This doesn't just trigger the error handler but retries the whole request.
        // oxlint-disable-next-line no-self-assign
        img.src = img.src;
      }
      if (getImageConfig().dev) {
        if (!src) {
          console.error(`Image is missing required "src" property:`, img);
        }
        if (img.getAttribute('alt') === null) {
          console.error(
            `Image is missing required "alt" property. Please add Alternative Text to describe the image for screen readers and search engines.`,
          );
        }
      }
      if (img.complete) {
        handleLoading(
          img,
          placeholder,
          onLoadRef,
          onLoadingCompleteRef,
          setBlurComplete,
          unoptimized,
          sizesInput,
        );
      }
      didInsertRef.current = true;
    }
  }, [
    src,
    placeholder,
    onLoadRef,
    onLoadingCompleteRef,
    setBlurComplete,
    onError,
    unoptimized,
    sizesInput,
  ]);

  const ref = useMergedRef(forwardedRef, insertedImgRef);

  return (
    // If you move this element creation, also move the Layout Effect above
    // reading from the ref. Otherwise we might run the Layout Effect when
    // the current value isn't set to the HTMLImageElement instance.
    <img
      {...rest}
      fetchPriority={fetchPriority}
      // It's intended to keep `loading` before `src` because React updates
      // props in order which causes Safari/Firefox to not lazy load properly.
      // See https://github.com/facebook/react/issues/25883
      loading={loading}
      width={width}
      height={height}
      decoding={decoding}
      data-nimg={fill ? 'fill' : '1'}
      className={className}
      style={style}
      // It's intended to keep `src` the last attribute because React updates
      // attributes in order. If we keep `src` the first one, Safari will
      // immediately start to fetch `src`, before `sizes` and `srcSet` are even
      // updated by React. That causes multiple unnecessary requests if `srcSet`
      // and `sizes` are defined.
      // This bug cannot be reproduced in Chrome or Firefox.
      sizes={sizes}
      srcSet={srcSet}
      src={src}
      ref={ref}
      onLoad={(event) => {
        handleLoading(
          event.currentTarget,
          placeholder,
          onLoadRef,
          onLoadingCompleteRef,
          setBlurComplete,
          unoptimized,
          sizesInput,
        );
      }}
      onError={(event) => {
        // if the real image fails to load, this will ensure "alt" is visible
        setShowAltText(true);
        if (placeholder !== 'empty') {
          // If the real image fails to load, this will still remove the placeholder.
          setBlurComplete(true);
        }
        onError?.(event);
      }}
    />
  );
}

function ImagePreload({ imgAttributes }: { imgAttributes: ImgProps }): null {
  const options: PreloadOptions = {
    as: 'image',
    imageSrcSet: imgAttributes.srcSet,
    imageSizes: imgAttributes.sizes,
    crossOrigin: imgAttributes.crossOrigin,
    referrerPolicy: imgAttributes.referrerPolicy,
    fetchPriority: imgAttributes.fetchPriority,
  };
  // React emits the `<link rel="preload" as="image">` while server rendering
  // (omitting `href` when `imageSrcSet` is set) and adds it to `document.head`
  // on the client unless an equal link exists.
  preload(imgAttributes.src, options);
  return null;
}

/**
 * Renders an `<img>` with a responsive `srcSet` served by the Void image
 * endpoint (or the configured loader), lazy loading by default, and an
 * optional blur placeholder. Accepts every `next/image` prop.
 */
export function Image({
  ref,
  ...props
}: ImageProps & RefAttributes<HTMLImageElement | null>): JSX.Element {
  const { onLoad, onLoadingComplete } = props;
  const onLoadRef = useRef<OnLoad>(onLoad);
  useEffect(() => {
    onLoadRef.current = onLoad;
  }, [onLoad]);
  const onLoadingCompleteRef = useRef<OnLoadingComplete | undefined>(onLoadingComplete);
  useEffect(() => {
    onLoadingCompleteRef.current = onLoadingComplete;
  }, [onLoadingComplete]);

  const [blurComplete, setBlurComplete] = useState(false);
  const [showAltText, setShowAltText] = useState(false);
  // `ref` stays out of the core props: it would trigger the "unsupported ref" warning.
  const { props: coreAttributes, meta: imgMeta } = resolveImageProps(toCoreProps(props), {
    blurComplete,
    showAltText,
  });
  const imgAttributes = coreAttributes as unknown as ImgProps;

  return (
    <>
      <ImageElement
        {...imgAttributes}
        unoptimized={imgMeta.unoptimized}
        placeholder={imgMeta.placeholder}
        fill={imgMeta.fill}
        onLoadRef={onLoadRef}
        onLoadingCompleteRef={onLoadingCompleteRef}
        setBlurComplete={setBlurComplete}
        setShowAltText={setShowAltText}
        sizesInput={props.sizes}
        forwardedRef={ref}
      />
      {imgMeta.preload ? <ImagePreload imgAttributes={imgAttributes} /> : null}
    </>
  );
}

/**
 * The props `Image` would pass to its `<img>`, for another element, a
 * `<picture>` source, CSS or canvas. Keys whose value is `undefined` are
 * removed. Does not preload.
 */
export function getImageProps(imgProps: ImageProps): { props: ImgProps } {
  return getCoreImageProps(toCoreProps(imgProps)) as unknown as { props: ImgProps };
}
