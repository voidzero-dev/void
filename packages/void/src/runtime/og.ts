import { ImageResponse, type ImageInput, type RenderImageOptions } from './image.ts';

const DEFAULT_CACHE_MAX_AGE = 86400;

export type OgImagePreset =
  | 'facebook'
  | 'linkedin'
  | 'discord'
  | 'bluesky'
  | 'x'
  | 'x-summary'
  | 'pinterest'
  | 'default';

const DEFAULT_IMAGE_SIZE : [number, number] = [1200, 630];

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
  'pinterest': [1000, 1500],

  default: DEFAULT_IMAGE_SIZE
};

type RenderOgImageOptionsBase = Omit<RenderImageOptions, 'width' | 'height'>;

/** Image rendering options with the standard Open Graph dimensions by default. */
export interface RenderOgImageOptionsPreset extends ResponseInit, RenderOgImageOptionsBase {
  preset: OgImagePreset;
}

/** Image rendering options with the standard Open Graph dimensions by default. */
export interface RenderOgImageOptionsSize extends ResponseInit, RenderOgImageOptionsBase {
  /** Image width in pixels. Defaults to 1200. */
  width?: number;
  /** Image height in pixels. Defaults to 630. */
  height?: number;
}

/** Options for the Open Graph image and its response. */
export type RenderOgImageOptions = RenderOgImageOptionsPreset | RenderOgImageOptionsSize;

/** An image response cached publicly for 24 hours: a 1200×630 PNG by default. */
export class OgImageResponse extends ImageResponse {
  constructor(element: ImageInput, options: RenderOgImageOptions = {}) {
    const headers = new Headers(options.headers);
    if (!headers.has('cache-control')) {
      headers.set('cache-control', `public, max-age=${DEFAULT_CACHE_MAX_AGE}`);
    }
    const [width, height] = getSize(options);
    super(element, { ...options, headers, width, height });
  }
}

function getSize(options: RenderOgImageOptions | undefined): [number, number] {
  if (options && 'preset' in options) {
    return ogImageSizes[options.preset];
  }
  return [options?.width ?? ogImageSizes.default[0], options?.height ?? ogImageSizes.default[1]];
}
