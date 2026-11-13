import { ImageResponse, type ImageInput, type RenderImageOptions } from './image.ts';

const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 630;

/** Image rendering options with the standard Open Graph dimensions by default. */
export interface RenderOgImageOptions extends Omit<RenderImageOptions, 'width' | 'height'> {
  /** Image width in pixels. Defaults to 1200. */
  width?: number;
  /** Image height in pixels. Defaults to 630. */
  height?: number;
}

/** Options for the Open Graph image and its response. */
export interface OgImageResponseOptions extends ResponseInit, RenderOgImageOptions {}

/** An image response cached publicly for 24 hours: a 1200×630 PNG by default. */
export class OgImageResponse extends ImageResponse {
  constructor(element: ImageInput, options: OgImageResponseOptions = {}) {
    const headers = new Headers(options.headers);
    if (!headers.has('cache-control')) {
      headers.set('cache-control', 'public, max-age=86400');
    }
    super(element, {
      ...options,
      headers,
      width: options.width ?? DEFAULT_WIDTH,
      height: options.height ?? DEFAULT_HEIGHT,
    });
  }
}
