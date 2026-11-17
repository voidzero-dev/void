import type { ImageInput } from './image-input.ts';
import { renderImage, type RenderImageOptions } from './render-image.ts';

/** Image rendering options combined with the response status and headers. */
export interface ImageResponseOptions extends ResponseInit, RenderImageOptions {}

/**
 * A PNG response rendered when its body is read. Use `renderImage` to await
 * completion and handle rendering errors before creating an HTTP response.
 * Does not choose a cache policy.
 */
export class ImageResponse extends Response {
  constructor(element: ImageInput, options: ImageResponseOptions) {
    const { status, statusText, headers, ...imageOptions } = options;
    const responseHeaders = new Headers(headers);
    if (!responseHeaders.has('content-type')) {
      responseHeaders.set('content-type', 'image/png');
    }
    super(
      lazyImageBody(() => renderImage(element, imageOptions)),
      {
        status,
        statusText,
        headers: responseHeaders,
      },
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
          console.error('@void/image: failed to render the image.', error);
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
