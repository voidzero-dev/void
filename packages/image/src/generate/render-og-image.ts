import type { ImageInput } from './image-input.ts';
import { renderImage, type RenderImageOptions } from './render-image.ts';

/** Open Graph rendering options, with default dimensions of 1200 × 630. */
export interface RenderOgImageOptions extends Omit<RenderImageOptions, 'width' | 'height'> {
  /** Image width in pixels. Defaults to 1200. */
  width?: number;
  /** Image height in pixels. Defaults to 630. */
  height?: number;
}

/** Renders PNG bytes at 1200 × 630 by default, or with custom dimensions. */
export async function renderOgImage(
  element: ImageInput,
  options: RenderOgImageOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  return renderImage(element, resolveOgImageOptions(options));
}

/** Shared by the byte API and lazy response wrapper. */
export function resolveOgImageOptions(options: RenderOgImageOptions): RenderImageOptions {
  return {
    ...options,
    width: options.width ?? 1200,
    height: options.height ?? 630,
  };
}
