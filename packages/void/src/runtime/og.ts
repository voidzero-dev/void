/**
 * `void/og` — the `ImageResponse` API of `next/og` and `@vercel/og`, rendered
 * by Takumi instead of Satori and resvg.
 *
 * Takumi does the rendering (Wasm on workerd, its native addon on Node). This
 * module adds what `@vercel/og` does around its renderer: a 1200×630 default
 * size, the response headers, `debug`, and Noto fallback fonts for text that
 * Takumi's built-in Geist cannot draw. Comments cite the upstream code:
 * - @vercel/og 1.0.3, published only as a bundle whose `// src/…` sections
 *   name its source files:
 *   https://cdn.jsdelivr.net/npm/@vercel/og@1.0.3/dist/index.edge.js
 * - Satori 0.33.5, the version @vercel/og 1.0.3 bundles.
 * - Next.js 16.4.2, whose `next/og` wraps a copy of @vercel/og.
 */
import {
  render,
  type FontDetails,
  type FontLoader,
  type Node,
  type RenderInput,
  type RenderOptions,
} from 'takumi-js';
import { collectCodepoints, googleFonts, subsetFonts, type FontSubset } from 'takumi-js/helpers';
import { extractEmojis } from 'takumi-js/helpers/emoji';
import { fromHtml } from 'takumi-js/helpers/html';
import { fromJsx } from 'takumi-js/helpers/jsx';

/** Takumi's options without `fonts`; a plain `Omit` would merge its format variants. */
type RenderOptionsWithoutFonts = RenderOptions extends infer T
  ? T extends object
    ? Omit<T, 'fonts'>
    : never
  : never;

/**
 * A font as Takumi loads it, or as `next/og` types it, with Satori's `lang`:
 * https://github.com/vercel/satori/blob/0.33.5/src/font.ts#L137-L143
 */
type Font = FontLoader | (FontDetails & { lang?: string });

export type ImageResponseOptions = RenderOptionsWithoutFonts &
  ResponseInit & {
    /**
     * Draws a border around every box, as `debug` does in Satori, though the lines
     * look different:
     * https://github.com/vercel/satori/blob/0.33.5/src/builder/rect.ts#L213-L225
     */
    debug?: boolean;
    /**
     * Fonts to draw text with. A font's `lang`, which Satori reads to prefer the
     * font for that language, is ignored: Takumi takes the first font with the
     * glyph. The `lang` option, or attribute on the root element, chooses the
     * CJK fallback font instead.
     */
    fonts?: Array<Font> | Promise<Array<Font>>;
  };

const CONTENT_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
  raw: 'application/octet-stream',
} as const;

// Google Fonts families for text the default font cannot draw. Satori hands
// @vercel/og the characters no loaded font has, with the languages their script
// suggests, and @vercel/og downloads each language's Noto family:
// - https://github.com/vercel/satori/blob/0.33.5/src/text/index.ts#L103-L115
// - https://github.com/vercel/satori/blob/0.33.5/src/language.ts#L24-L45
// - @vercel/og `// src/language/index.ts`: languageFontMap
// Takumi has no such hook, so these families are matched by script before the
// render. `cjkFamily` settles the first one.
const FALLBACK_FONTS: Array<[script: RegExp, family: string]> = [
  [/[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}　-〿＀-￯]/u, 'Noto Sans JP'],
  [/\p{sc=Hangul}/u, 'Noto Sans KR'],
  [/\p{sc=Thai}/u, 'Noto Sans Thai'],
  [/\p{sc=Arabic}/u, 'Noto Sans Arabic'],
  [/\p{sc=Hebrew}/u, 'Noto Sans Hebrew'],
  [/\p{sc=Devanagari}/u, 'Noto Sans Devanagari'],
  [/\p{sc=Bengali}/u, 'Noto Sans Bengali'],
  [/\p{sc=Tamil}/u, 'Noto Sans Tamil'],
  [/\p{sc=Telugu}/u, 'Noto Sans Telugu'],
  [/\p{sc=Kannada}/u, 'Noto Sans Kannada'],
  [/\p{sc=Malayalam}/u, 'Noto Sans Malayalam'],
  [/[\p{sc=Cyrillic}\p{sc=Greek}Ā-ɏḀ-ỿ]/u, 'Noto Sans'],
  [/\p{Sm}/u, 'Noto Sans Math'],
  [/\p{So}/u, 'Noto Sans Symbols 2'],
];

/**
 * A `Response` whose body is the image rendered from `element`: React JSX, an
 * HTML string, or a Takumi node tree. Like `@vercel/og`, it renders a 1200×630
 * PNG by default and lets it be cached for a year outside development.
 */
export class ImageResponse extends Response {
  constructor(element: RenderInput, options: ImageResponseOptions = {}) {
    const { status, statusText, headers, debug, ...renderOptions } = options;
    // next/og sets these two headers unless the caller's `headers` has them
    // (@vercel/og itself spreads the caller's object over its defaults). Next.js
    // 16 sends `public, max-age=0, must-revalidate` outside development instead:
    // https://github.com/vercel/next.js/blob/v16.4.2/packages/next/src/server/og/image-response.ts#L76-L86
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
    // Render while the body streams, as @vercel/og does, so a failure errors the
    // body, which the runtime reports:
    // https://github.com/vercel/next.js/blob/v16.4.2/packages/next/src/server/og/image-response.ts#L49-L72
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          // @vercel/og `// src/og.ts`: render() defaults to 1200×630 without debug.
          const image = await renderImage(element, {
            ...renderOptions,
            width: renderOptions.width ?? 1200,
            height: renderOptions.height ?? 630,
            drawDebugBorder: renderOptions.drawDebugBorder ?? debug,
          });
          controller.enqueue(image);
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
    super(body, { status, statusText, headers: responseHeaders });
  }
}

type RenderImageOptions = RenderOptionsWithoutFonts & { fonts?: ImageResponseOptions['fonts'] };

class FallbackFontError extends Error {}

async function renderImage(element: RenderInput, options: RenderImageOptions): Promise<Uint8Array> {
  // Convert once, here: the fallback fonts depend on the final text, and
  // function components must not run twice. Emoji become images first, as in
  // the render, so their code points ask for no symbol font.
  const { node: tree, css } = await toNode(element, options.jsx);
  const node =
    options.emoji === 'from-font' ? tree : extractEmojis(tree, options.emoji ?? 'twemoji');
  // Remote images and emoji are fetched once, even when the render runs twice.
  const fetchCache = new Map<string, Promise<ArrayBuffer>>();
  const renderNode = (fonts: Array<FontLoader>) =>
    render(node, {
      ...options,
      // takumi rejects `css` beside its deprecated `stylesheets`, so fold them.
      css: [...toList(options.css), ...toList(options.stylesheets), ...css],
      stylesheets: undefined,
      images: Array.isArray(options.images)
        ? { sources: options.images, fetchCache }
        : { fetchCache, ...options.images },
      // Takumi uses every font registered in the process when it gets no list,
      // which includes earlier images' fallback fonts:
      // https://github.com/kane50613/takumi/blob/takumi@2.16.2/takumi-helpers/src/renderer.ts#L271-L282
      fonts,
    });
  const fallback = await fallbackFonts(node, options);
  const fonts = ((await options.fonts) ?? []).map(withoutLang);
  if (fallback.length === 0) {
    return renderNode(fonts);
  }
  try {
    return await renderNode([...fonts, ...fallback]);
  } catch (error) {
    // A font that fails to download leaves its glyphs missing rather than
    // failing the image, as in @vercel/og `// src/og.ts`: loadDynamicAsset.
    if (!(error instanceof FallbackFontError)) {
      throw error;
    }
    console.warn(`${error.message} Rendering without it.`, error.cause);
    return renderNode(fonts);
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

function withoutLang(font: Font): FontLoader {
  if (typeof font === 'object' && 'lang' in font) {
    const { lang: _lang, ...rest } = font;
    return rest;
  }
  return font;
}

// Satori's ja-JP code takes Han and comes first, so Han text is Japanese there
// unless an element's `lang` moves another language first:
// https://github.com/vercel/satori/blob/0.33.5/src/language.ts#L57-L84
function cjkFamily(text: string, lang = ''): string {
  if (/[\p{sc=Hiragana}\p{sc=Katakana}]/u.test(text)) {
    return 'Noto Sans JP';
  }
  const tag = lang.toLowerCase();
  if (tag.startsWith('ko') || /\p{sc=Hangul}/u.test(text)) {
    return 'Noto Sans KR';
  }
  if (tag.startsWith('zh')) {
    return /hant|-tw|-hk|-mo/.test(tag) ? 'Noto Sans TC' : 'Noto Sans SC';
  }
  return 'Noto Sans JP';
}

async function fallbackFonts(node: Node, options: RenderImageOptions): Promise<Array<FontSubset>> {
  const text = Array.from(collectCodepoints(node), (codepoint) =>
    String.fromCodePoint(codepoint),
  ).join('');
  const families = new Set(
    FALLBACK_FONTS.filter(([script]) => script.test(text)).map(([, family]) =>
      family === 'Noto Sans JP' ? cjkFamily(text, options.lang ?? node.lang) : family,
    ),
  );
  if (families.size === 0) {
    return [];
  }
  options.signal?.throwIfAborted();
  let subsets: Array<FontSubset>;
  try {
    subsets = await googleFonts([...families]);
  } catch (error) {
    console.warn(`void/og: could not load ${[...families].join(', ')} from Google Fonts.`, error);
    return [];
  }
  // Satori draws each character with the first loaded font that has it, and
  // fallback fonts come after the default one, so Latin text keeps the default
  // font: https://github.com/vercel/satori/blob/0.33.5/src/font.ts#L601-L679
  // Takumi puts registered fonts before its built-in Geist, which covers ASCII
  // and Latin-1 but µ, so skip each family's Latin subset and take Latin-1 out
  // of the others, which can mix ASCII with common CJK characters.
  const stripped = subsets.flatMap((subset) => {
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
      // Private names: Takumi keeps fonts per process, so the app's own copy
      // of the family, Latin glyphs included, must not join this one.
      name: `void/og ${subset.name}`,
      key: `void/og ${subset.key}`,
      data: () =>
        subset.data().catch((cause: unknown) => {
          throw new FallbackFontError(`void/og: could not download ${subset.name}.`, { cause });
        }),
    };
  });
  // Takumi downloads the subsets of its list-marker sample as well, so keep
  // only those the text uses.
  return subsetFonts({ fonts: stripped, source: node });
}

function isDevelopment(): boolean {
  return (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
}
