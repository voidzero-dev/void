/**
 * `@void/image/generate` — an `ImageResponse` that renders JSX or HTML to an image with
 * Takumi.
 *
 * Takumi does the rendering. This module adds what a route handler needs around it:
 * the response headers, `debug`, bundled Inter, and Google Fonts fallbacks for missing glyphs.
 */
import { render, type FontLoader } from 'takumi-js';
import type { ImageFetchCache } from 'takumi-js/helpers';
import { extractEmojis, isEmojiImageUrl } from 'takumi-js/helpers/emoji';
import { FallbackFontError, fallbackFonts, interFont, keyedFont } from './fonts.ts';
import type { ImageFont, ImageInput } from './image-input.ts';
import { withImageRenderer } from './image-renderer.ts';
import { toTakumiInput } from './takumi-input.ts';

export type { ImageInput } from './image-input.ts';

/**
 * {@link renderImage} function options.
 */
export interface RenderImageOptions {
  /** Image width in pixels. */
  width: number;
  /** Image height in pixels. */
  height: number;
  /** Draws a border around every box. */
  debug?: boolean;
  /** Bundled font used after custom fonts. Defaults to `Inter`; `Geist` selects the alternative. */
  defaultFont?: 'Inter' | 'Geist';
  /** Fonts to draw text with, before the selected default font. */
  fonts?: Array<ImageFont>;
  /**
   * Set to false to download no fonts from Google Fonts for characters that
   * the selected default font cannot draw, leaving them to `fonts`. Defaults to true.
   */
  fallbackFonts?: boolean;
  /** The emoji images to draw. Defaults to `twemoji`. */
  emoji?: 'twemoji' | 'blobmoji' | 'noto' | 'openmoji' | 'fluent' | 'fluentFlat';
  /**
   * The language of the text, such as `ja` or `zh-TW`, which chooses the style
   * of Chinese characters. Defaults to the root element's `lang` attribute.
   */
  lang?: string;
  /** Limits for downloading the images and emoji in the markup. */
  images?: {
    /** Returns false for a URL the image must not download. */
    allowUrl?: (url: string) => boolean;
    /** The largest image to download, in bytes. */
    maxBytes?: number;
    /** Milliseconds to wait for each download. */
    timeout?: number;
    /** Set to false to leave out an image or emoji that fails to download. */
    throwOnError?: boolean;
  };
}
/**
 * Image rendering options combined with the response status and headers.
 */
export interface ImageResponseOptions extends ResponseInit, RenderImageOptions {}

// Emoji come from jsDelivr by code point and never change, so keep them for the
// life of the isolate; other images are fetched for each render.
const emojiCache = new Map<string, Promise<ArrayBuffer>>();

/**
 * A `Response` whose body is the image rendered from `element`: React JSX, a
 * `void/html` template, or an image node tree. It renders a PNG at the given size,
 * without choosing a cache policy.
 */
export class ImageResponse extends Response {
  constructor(element: ImageInput, options: ImageResponseOptions) {
    const { status, statusText, headers, ...imageOptions } = options;
    // Leave caching to the caller; only default the rendered image's type.
    const responseHeaders = new Headers(headers);
    if (!responseHeaders.has('content-type')) {
      responseHeaders.set('content-type', 'image/png');
    }
    // Render while the body streams, so a failure errors the body.
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const image = await renderImage(element, imageOptions);
          controller.enqueue(image);
          controller.close();
        } catch (error) {
          console.error('@void/image: failed to render the image.', error);
          controller.error(error);
        }
      },
    });
    super(body, { status, statusText, headers: responseHeaders });
  }
}

async function renderImage(element: ImageInput, options: RenderImageOptions): Promise<Uint8Array> {
  // Convert once, here: the fallback fonts depend on the final text, and
  // function components must not run twice. Emoji become images first, as in
  // the render, so their code points ask for no symbol font.
  const { node: tree, css } = await toTakumiInput(element);
  const emoji = options.emoji ?? 'twemoji';
  const node = extractEmojis(tree, emoji);
  // Only the documented limits reach Takumi, which takes more image options.
  const { allowUrl, maxBytes, timeout, throwOnError } = options.images ?? {};
  // One cache for both attempts below, so a retry fetches no image again.
  const fetchCache = imageCache();
  const renderNode = (fonts: Array<FontLoader>) =>
    withImageRenderer((renderer) =>
      render(node, {
        width: options.width,
        height: options.height,
        drawDebugBorder: options.debug,
        lang: options.lang,
        emoji,
        css,
        images: { fetchCache, allowUrl, maxBytes, timeout, throwOnError },
        // Takumi uses every font registered in the process when it gets no list,
        // which includes earlier images' fallback fonts:
        // https://github.com/kane50613/takumi/blob/takumi@2.20.0/takumi-helpers/src/renderer.ts#L384-L412
        fonts,
        renderer,
      }),
    );
  // Keys of the fallback files that failed to download during this image.
  const failed = new Set<string>();
  const defaultFont = options.defaultFont ?? 'Inter';
  const [fonts, fallback] = await Promise.all([
    Promise.all((options.fonts ?? []).map(keyedFont)),
    options.fallbackFonts === false
      ? []
      : fallbackFonts(node, options.lang ?? node.lang, timeout, failed, defaultFont),
  ]);
  if (defaultFont === 'Inter') {
    fonts.push(interFont);
  }
  if (fallback.length === 0) {
    return renderNode(fonts);
  }
  // A font that fails to download leaves its glyphs missing rather than
  // failing the image.
  // Takumi downloads the files together and rejects the render on the first
  // failure, so retry without the files that failed, and only those: a flaky
  // symbol font must not also drop the Japanese one. Successful downloads are
  // retained for this image even if the changed font list clears registrations.
  let remaining = fallback;
  for (;;) {
    try {
      return await renderNode([...fonts, ...remaining]);
    } catch (error) {
      if (!(error instanceof FallbackFontError)) {
        throw error;
      }
      const rest = remaining.filter((subset) => !failed.has(subset.key));
      // Each retry must drop a file, so the loop ends. A failure this image
      // did not record would retry forever; drop every fallback font instead.
      remaining = rest.length < remaining.length ? rest : [];
    }
  }
}

/** Images fetched once per render, and emoji once per isolate. */
function imageCache(): ImageFetchCache {
  const cache = new Map<string, Promise<ArrayBuffer>>();
  return {
    get: (url) => cache.get(url) ?? (isEmojiImageUrl(url) ? emojiCache.get(url) : undefined),
    set(url, data) {
      cache.set(url, data);
      if (isEmojiImageUrl(url)) {
        if (emojiCache.size >= 256) {
          emojiCache.delete(emojiCache.keys().next().value!);
        }
        emojiCache.set(url, data);
      }
    },
    delete(url) {
      cache.delete(url);
      emojiCache.delete(url);
    },
  };
}
