import { renderImage, type RenderOgImageOptions, resolveOgImageOptions } from './render-image.ts';
import type {
  AnyImageRenderer,
  DefaultImageRenderer,
  ImageInput,
  RenderImageOptions,
} from './types.ts';

/** Image rendering options combined with the response status and headers. */
export interface ImageResponseOptions<
  Renderer extends AnyImageRenderer = DefaultImageRenderer,
  FontFamily extends string = never,
>
  extends ResponseInit, RenderImageOptions<Renderer, FontFamily> {}

/**
 * A PNG response rendered when its body is read. Use `renderImage` to await
 * completion and handle rendering errors before creating an HTTP response.
 * Does not choose a cache policy.
 */
export class ImageResponse<
  Renderer extends AnyImageRenderer = DefaultImageRenderer,
  FontFamily extends string = never,
> extends Response {
  constructor(element: ImageInput, options: ImageResponseOptions<Renderer, FontFamily>) {
    const { status, statusText, headers: responseHeaders, ...imageOptions } = options;

    const headers = new Headers(responseHeaders);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'image/png');
    }

    // Async templates are already running even while rendering stays lazy.
    // Observe their rejection now; reading the original input still throws it.
    void Promise.resolve(element).catch(() => {});

    super(
      lazyImageBody(() => renderImage(element, imageOptions)),
      { status, statusText, headers },
    );
  }
}

function lazyImageBody(render: () => Promise<Uint8Array>): ReadableStream<Uint8Array> {
  let started = false;
  let cancelled = false;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (started || cancelled) {
          return;
        }
        started = true;
        try {
          const image = await render();
          if (cancelled) {
            return;
          }
          controller.enqueue(image);
          controller.close();
        } catch (error) {
          if (cancelled) {
            return;
          }
          console.error('void/image: failed to render the image.', error);
          controller.error(error);
        }
      },
      cancel() {
        cancelled = true;
      },
    },
    // The default queues a chunk before any read, starting rendering eagerly.
    { highWaterMark: 0 },
  );
}

/** Open Graph rendering options combined with the response status and headers. */
export type OgImageResponseOptions<
  Renderer extends AnyImageRenderer = DefaultImageRenderer,
  FontFamily extends string = never,
> = RenderOgImageOptions<Renderer, FontFamily> & ResponseInit;

/** A lazy PNG response cached publicly for 24 hours: 1200 × 630 by default. */
export class OgImageResponse<
  Renderer extends AnyImageRenderer = DefaultImageRenderer,
  FontFamily extends string = never,
> extends ImageResponse<Renderer, FontFamily> {
  constructor(element: ImageInput, options: OgImageResponseOptions<Renderer, FontFamily> = {}) {
    const { status, statusText, headers, ...imageOptions } = options;
    const responseHeaders = new Headers(headers);
    if (!responseHeaders.has('cache-control')) {
      responseHeaders.set('cache-control', 'public, max-age=86400');
    }
    super(element, {
      ...resolveOgImageOptions(imageOptions),
      status,
      statusText,
      headers: responseHeaders,
    });
  }
}
