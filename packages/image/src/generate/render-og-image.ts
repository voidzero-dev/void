import type { ImageInput } from './image-input.ts';
import { renderImage, type RenderImageOptions } from './render-image.ts';

export type OgImagePreset =
  | 'facebook'
  | 'linkedin'
  | 'discord'
  | 'bluesky'
  | 'x'
  | 'x-summary'
  | 'pinterest'
  | 'default';

const DEFAULT_IMAGE_SIZE: [number, number] = [1200, 630];

/**
 * Social preview rendering presets in [width, height] pixels.
 * Includes platform recommendations and general-purpose fallbacks, not
 * platform-enforced dimensions. See https://void.cloud/guide/og-images#image-sizes.
 */
export const ogImageSizes: Record<OgImagePreset, [number, number]> = {
  // https://developers.facebook.com/docs/sharing/webmasters/images/
  facebook: DEFAULT_IMAGE_SIZE,
  // https://www.linkedin.com/help/linkedin/answer/a521928
  linkedin: [1200, 627],
  // https://docs.discord.com/developers/link-previews/overview (example size)
  discord: DEFAULT_IMAGE_SIZE,
  // https://github.com/bluesky-social/social-app/blob/main/src/lib/constants.ts
  bluesky: DEFAULT_IMAGE_SIZE,

  // X large and square summary card formats.
  // https://renderscreenshot.com/blog/twitter-card-image-size
  x: [1200, 600],
  'x-summary': [600, 600],

  // https://help.pinterest.com/en/business/article/pinterest-product-specs
  pinterest: [1000, 1500],

  default: DEFAULT_IMAGE_SIZE,
};

type RenderOgImageOptionsBase = Omit<RenderImageOptions, 'width' | 'height'>;

/** Image rendering options with the standard Open Graph dimensions by default. */
export interface RenderOgImageOptionsPreset extends RenderOgImageOptionsBase {
  preset: OgImagePreset;
}

/** Image rendering options with the standard Open Graph dimensions by default. */
export interface RenderOgImageOptionsSize extends RenderOgImageOptionsBase {
  /** Image width in pixels. Defaults to 1200. */
  width?: number;
  /** Image height in pixels. Defaults to 630. */
  height?: number;
}

/** Open Graph rendering options, with default dimensions of 1200 × 630. */
export type RenderOgImageOptions = RenderOgImageOptionsPreset | RenderOgImageOptionsSize;

/** Renders PNG bytes using a social preview preset or custom dimensions. */
export async function renderOgImage(
  element: ImageInput,
  options: RenderOgImageOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  return renderImage(element, resolveOgImageOptions(options));
}

/** Shared by the byte API and lazy response wrapper. */
export function resolveOgImageOptions(options: RenderOgImageOptions): RenderImageOptions {
  if ('preset' in options) {
    const { preset, ...renderOptions } = options;
    const [width, height] = ogImageSizes[preset];
    return { ...renderOptions, width, height };
  }
  return {
    ...options,
    width: options.width ?? ogImageSizes.default[0],
    height: options.height ?? ogImageSizes.default[1],
  };
}
