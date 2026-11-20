import { render, type FontLoader } from 'takumi-js';
import type { ImageFetchCache } from 'takumi-js/helpers';
import { extractEmojis, isEmojiImageUrl } from 'takumi-js/helpers/emoji';
import type { ImageFontBytes, ImageRenderer } from 'void/image';
import { FallbackFontError, fallbackFonts, robotoFont, keyedFont } from './fonts.ts';
import { withImageRenderer } from './image-renderer.ts';
import { toTakumiInput } from './takumi-input.ts';

// Emoji come from jsDelivr by code point and never change, so keep them for the
// life of the isolate; other images are fetched for each render.
const emojiCache = new Map<string, Promise<ArrayBuffer>>();

export type TakumiRendererDefaultFontFamily = 'Roboto' | 'Geist';

export type TakumiRendererFontData = ImageFontBytes;

export interface TakumiRendererOptions {
  /** Whether Takumi downloads fallback fonts. */
  fallbackFonts?: boolean;
  /** Emoji images for Takumi. */
  emoji?: 'twemoji' | 'blobmoji' | 'noto' | 'openmoji' | 'fluent' | 'fluentFlat';
  /** Takumi image download controls. Browser Run does not support these controls. */
  images?: {
    allowUrl?: (url: string) => boolean;
    maxBytes?: number;
    timeout?: number;
    throwOnError?: boolean;
  };
}

/** Renders Hono JSX or an escaped HTML template to PNG bytes. */
export const takumiRenderer: ImageRenderer<
  TakumiRendererDefaultFontFamily,
  TakumiRendererFontData,
  TakumiRendererOptions
> = async (element, options) => {
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
  const font: string | Array<string> | undefined = options.font;
  const families = typeof font === 'string' ? [font] : (font ?? []);
  const useRoboto = families.length === 0 || families.includes('Roboto');
  const fontStack = families.flatMap((family) => {
    if (family !== 'Roboto') {
      return [family];
    }
    // Preserve app-provided Roboto faces ahead of the bundled copy.
    return options.fonts?.some((font) => font.name === 'Roboto')
      ? [family, robotoFont.name]
      : [robotoFont.name];
  });
  const renderNode = (fonts: Array<FontLoader>, fallback: Array<{ name: string }> = []) =>
    withImageRenderer((renderer) =>
      render(node, {
        width: options.width,
        height: options.height,
        drawDebugBorder: options.debug,
        lang: options.lang,
        emoji,
        css,
        images: { fetchCache, allowUrl, maxBytes, timeout, throwOnError },
        // Each render names its own fonts; Takumi caches their files without
        // making them available to unrelated requests.
        fonts,
        ...(fontStack.length > 0 && {
          fontFamilies: [...new Set([...fontStack, ...fallback.map(({ name }) => name)])],
        }),
        renderer,
      }),
    );
  // Keys of the fallback files that failed to download during this image.
  const failed = new Set<string>();
  const [fonts, fallback] = await Promise.all([
    Promise.all((options.fonts ?? []).map(keyedFont)),
    options.fallbackFonts === false
      ? []
      : fallbackFonts(
          node,
          options.lang ?? node.lang,
          timeout,
          failed,
          useRoboto ? 'Roboto' : 'Geist',
        ),
  ]);
  if (useRoboto) {
    fonts.push(robotoFont);
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
      return await renderNode([...fonts, ...remaining], remaining);
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
};

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
