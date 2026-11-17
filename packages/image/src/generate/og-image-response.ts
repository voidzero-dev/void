import type { ImageInput } from './image-input.ts';
import { ImageResponse } from './image-response.ts';
import { resolveOgImageOptions, type RenderOgImageOptions } from './render-og-image.ts';

/** Open Graph rendering options combined with the response status and headers. */
export type OgImageResponseOptions = RenderOgImageOptions & ResponseInit;

/** A lazy PNG response cached publicly for 24 hours: 1200 × 630 by default. */
export class OgImageResponse extends ImageResponse {
  constructor(element: ImageInput, options: OgImageResponseOptions = {}) {
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
