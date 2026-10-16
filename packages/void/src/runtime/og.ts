/**
 * `void/og` — a `next/og`-compatible `ImageResponse` rendered by Takumi.
 *
 * Takumi does the rendering (Wasm on workerd, its native addon on Node). This
 * module only adds what `next/og` callers expect on top: a 1200×630 default
 * size, the `cache-control` header, `debug`, and Noto fallback fonts for
 * text that Takumi's built-in Geist (ASCII and Latin-1) cannot draw.
 */
import { render, type Node, type RenderInput, type RenderOptions } from 'takumi-js';
import { collectCodepoints, googleFonts, type FontSubset } from 'takumi-js/helpers';
import { fromHtml } from 'takumi-js/helpers/html';
import { fromJsx } from 'takumi-js/helpers/jsx';

export type ImageResponseOptions = RenderOptions &
  ResponseInit & {
    /** Draws a border around every box, like `next/og`'s `debug`. */
    debug?: boolean;
  };

const CONTENT_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
  raw: 'application/octet-stream',
} as const;

// Google Fonts families for text the default font cannot draw, matched by
// script, like the fonts `next/og` downloads. Han text uses the Japanese or
// Korean family when kana or Hangul shows the language.
const FALLBACK_FONTS: Array<[script: RegExp, family: string]> = [
  [/[\p{sc=Hiragana}\p{sc=Katakana}]/u, 'Noto Sans JP'],
  [/\p{sc=Hangul}/u, 'Noto Sans KR'],
  [/\p{sc=Han}/u, 'Noto Sans SC'],
  [/\p{sc=Thai}/u, 'Noto Sans Thai'],
  [/\p{sc=Arabic}/u, 'Noto Sans Arabic'],
  [/\p{sc=Hebrew}/u, 'Noto Sans Hebrew'],
  [/\p{sc=Devanagari}/u, 'Noto Sans Devanagari'],
  [/\p{sc=Bengali}/u, 'Noto Sans Bengali'],
  [/\p{sc=Tamil}/u, 'Noto Sans Tamil'],
  [/\p{sc=Telugu}/u, 'Noto Sans Telugu'],
  [/\p{sc=Kannada}/u, 'Noto Sans Kannada'],
  [/\p{sc=Malayalam}/u, 'Noto Sans Malayalam'],
  [/[\p{sc=Cyrillic}\p{sc=Greek}\u0100-\u024F\u1E00-\u1EFF]/u, 'Noto Sans'],
];

/**
 * A `Response` whose body is the image rendered from `element`: React JSX, an
 * HTML string, or a Takumi node tree. Defaults match `next/og`: 1200×630 PNG,
 * cached for a year outside development.
 */
export class ImageResponse extends Response {
  constructor(element: RenderInput, options: ImageResponseOptions = {}) {
    const { status, statusText, headers, debug, ...renderOptions } = options;
    const responseHeaders = new Headers(headers);
    if (!responseHeaders.has('content-type')) {
      responseHeaders.set('content-type', CONTENT_TYPES[renderOptions.format ?? 'png']);
    }
    if (!responseHeaders.has('cache-control')) {
      responseHeaders.set(
        'cache-control',
        isDevelopment()
          ? 'no-cache, no-store'
          : 'public, immutable, no-transform, max-age=31536000',
      );
    }
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const image = await renderImage(element, {
            width: 1200,
            height: 630,
            drawDebugBorder: debug,
            ...renderOptions,
          });
          controller.enqueue(image);
          controller.close();
        } catch (error) {
          console.error('void/og: failed to render the image.', error);
          controller.error(error);
        }
      },
    });
    super(body, { status, statusText, headers: responseHeaders });
  }
}

class FallbackFontError extends Error {}

async function renderImage(element: RenderInput, options: RenderOptions): Promise<Uint8Array> {
  // Convert once, here: the fallback fonts depend on the final text, and
  // function components must not run twice.
  const { node, css } = await toNode(element, options.jsx);
  const renderNode = (fonts?: RenderOptions['fonts']) =>
    render(node, {
      ...options,
      // takumi rejects `css` beside its deprecated `stylesheets`, so fold them.
      ...(css.length > 0 && {
        css: [...toList(options.css ?? options.stylesheets), ...css],
        stylesheets: undefined,
      }),
      ...(fonts && { fonts }),
    });
  const fallback = await fallbackFonts(node);
  if (fallback.length === 0) {
    return renderNode();
  }
  try {
    return await renderNode([...((await options.fonts) ?? []), ...fallback]);
  } catch (error) {
    // Like `next/og`, a font that fails to download leaves its glyphs missing
    // rather than failing the image.
    if (!(error instanceof FallbackFontError)) {
      throw error;
    }
    console.warn(`${error.message} Rendering without it.`, error.cause);
    return renderNode();
  }
}

function toNode(element: RenderInput, jsx: RenderOptions['jsx']) {
  if (typeof element === 'string') {
    return fromHtml(element);
  }
  if (isTakumiNode(element)) {
    return { node: element, css: [] };
  }
  return fromJsx(element, jsx);
}

function isTakumiNode(element: unknown): element is Node {
  const type = (element as { type?: unknown } | null)?.type;
  return type === 'container' || type === 'text' || type === 'image';
}

function toList<T>(value: T | ReadonlyArray<T> | undefined): Array<T> {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? [...value] : [value as T];
}

async function fallbackFonts(node: Node): Promise<Array<FontSubset>> {
  const text = Array.from(collectCodepoints(node), (codepoint) =>
    String.fromCodePoint(codepoint),
  ).join('');
  let families = FALLBACK_FONTS.filter(([script]) => script.test(text)).map(([, family]) => family);
  if (families.includes('Noto Sans JP') || families.includes('Noto Sans KR')) {
    families = families.filter((family) => family !== 'Noto Sans SC');
  }
  if (families.length === 0) {
    return [];
  }
  let subsets: Array<FontSubset>;
  try {
    subsets = await googleFonts(families);
  } catch (error) {
    console.warn(`void/og: could not load ${families.join(', ')} from Google Fonts.`, error);
    return [];
  }
  // Registered fonts come before Geist, so keep ASCII and Latin-1 on the
  // default font, as `next/og` does: skip each family's Latin subset, and take
  // Latin-1 out of the others, which can mix ASCII with common CJK characters.
  return subsets.flatMap((subset) => {
    if (subset.unicodeRange.some(([start, end]) => start <= 0x20 && 0x7e <= end)) {
      return [];
    }
    const unicodeRange = subset.unicodeRange
      .filter(([, end]) => end > 0xff)
      .map(([start, end]): [number, number] => [Math.max(start, 0x100), end]);
    // An empty range covers everything, so only drop a subset that had ranges.
    if (unicodeRange.length === 0 && subset.unicodeRange.length > 0) {
      return [];
    }
    return {
      ...subset,
      unicodeRange,
      data: () =>
        subset.data().catch((cause: unknown) => {
          throw new FallbackFontError(`void/og: could not download ${subset.name}.`, { cause });
        }),
    };
  });
}

function isDevelopment(): boolean {
  return (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
}
