/**
 * `void/og` — the `ImageResponse` API of `next/og` and `@vercel/og`, rendered
 * by Takumi instead of Satori and resvg.
 *
 * Takumi does the rendering (Wasm on workerd, its native addon on Node). This
 * module adds what `@vercel/og` does around its renderer: a 1200×630 default
 * size, the response headers, `debug`, and Google Fonts fallbacks for text
 * that Takumi's built-in Geist cannot draw. Comments cite the upstream code:
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
import {
  collectCodepoints,
  googleFonts,
  subsetFonts,
  type FontSubset,
  type ImageFetchCache,
} from 'takumi-js/helpers';
import { extractEmojis } from 'takumi-js/helpers/emoji';
import { fromHtml } from 'takumi-js/helpers/html';
import { fromJsx } from 'takumi-js/helpers/jsx';

/** Takumi's options without `fonts`; a plain `Omit` would merge its format variants. */
type TakumiOptions = RenderOptions extends infer T
  ? T extends object
    ? Omit<T, 'fonts' | 'stylesheets'>
    : never
  : never;

/**
 * A font as Takumi loads it, or as `next/og` types it, with Satori's `lang`:
 * https://github.com/vercel/satori/blob/0.33.5/src/font.ts#L137-L143
 */
type Font = FontLoader | (FontDetails & { lang?: string });

export type ImageResponseOptions = TakumiOptions &
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
// render. `cjkFamily` settles the first one; `Noto Sans` takes the rest, as
// @vercel/og's `unknown` does.
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
  // The default font's own subsets, so a word stays in one typeface.
  [/[\p{sc=Cyrillic}µĀ-ɏḀ-ỿ]/u, 'Geist'],
  [/\p{Sm}/u, 'Noto Sans Math'],
  [/[\p{So}\p{No}\p{Nl}]/u, 'Noto Sans Symbols'],
  [/[\p{So}\p{No}\p{Nl}]/u, 'Noto Sans Symbols 2'],
];

// What Takumi's built-in Geist draws beyond ASCII and Latin-1 without µ, found
// by rendering each code point with takumi-js 2.16: some accented letters and
// combining marks, spaces, format characters and variation selectors, quotes,
// dashes, € ™ − ↑ ↓. Number forms such as ⅓ stay missing: no served subset
// has them.
/* eslint-disable no-misleading-character-class -- the marks and selectors are listed on their own */
const BUILT_IN =
  /[\u{100}\u{101}\u{112}\u{113}\u{12A}\u{12B}\u{131}\u{14C}\u{14D}\u{152}\u{153}\u{16A}\u{16B}\u{178}\u{1D5}\u{1D6}\u{1DE}\u{1DF}\u{1E2}\u{1E3}\u{22A}-\u{22D}\u{232}\u{233}\u{2BC}\u{2C6}\u{2DA}\u{2DC}\u{304}\u{308}\u{34F}\u{37E}\u{387}\u{1E20}\u{1E21}\u{1E26}\u{1E27}\u{1E4E}\u{1E4F}\u{1E7A}\u{1E7B}\u{1E84}\u{1E85}\u{1E8C}\u{1E8D}\u{1E97}\u{2000}-\u{200F}\u{2013}\u{2014}\u{2018}-\u{201A}\u{201C}-\u{201E}\u{2020}-\u{2022}\u{2026}\u{2028}-\u{2030}\u{2032}\u{2033}\u{2039}\u{203A}\u{2044}\u{205F}-\u{206F}\u{20AC}\u{2122}\u{212A}\u{212B}\u{2191}\u{2193}\u{2212}\u{FE00}-\u{FE0F}\u{FEFF}]/u;
/* eslint-enable no-misleading-character-class */

// Emoji come from jsDelivr by code point, so keep them for the life of the
// isolate, as @vercel/og does (`// src/og.ts`: assetCache); other images are
// fetched for each render.
const EMOJI_ORIGIN = 'https://cdn.jsdelivr.net/';
const emojiCache = new Map<string, Promise<ArrayBuffer>>();

/**
 * A `Response` whose body is the image rendered from `element`: React JSX, an
 * HTML string, or a Takumi node tree. Like `next/og`, it renders a 1200×630 PNG
 * by default, which clients revalidate outside development.
 */
export class ImageResponse extends Response {
  constructor(element: RenderInput, options: ImageResponseOptions = {}) {
    const { status, statusText, headers, debug, ...renderOptions } = options;
    // next/og sets these two headers unless the caller's `headers` has them
    // (@vercel/og itself spreads the caller's object over its defaults). A
    // failed render still ends as a complete response, so the image is not
    // cached for the year @vercel/og allows:
    // https://github.com/vercel/next.js/blob/v16.4.2/packages/next/src/server/og/image-response.ts#L76-L86
    const responseHeaders = new Headers(headers);
    if (!responseHeaders.has('content-type')) {
      responseHeaders.set('content-type', CONTENT_TYPES[renderOptions.format ?? 'png']);
    }
    if (!responseHeaders.has('cache-control')) {
      responseHeaders.set(
        'cache-control',
        isDevelopment() ? 'no-cache, no-store' : 'public, max-age=0, must-revalidate',
      );
    }
    // Render while the body streams, as @vercel/og does, so a failure errors the
    // body: https://github.com/vercel/next.js/blob/v16.4.2/packages/next/src/server/og/image-response.ts#L49-L72
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
          console.error('void/og: failed to render the image.', error);
          controller.error(error);
        }
      },
    });
    super(body, { status, statusText, headers: responseHeaders });
  }
}

type RenderImageOptions = TakumiOptions & { fonts?: ImageResponseOptions['fonts'] };

class FallbackFontError extends Error {}

async function renderImage(element: RenderInput, options: RenderImageOptions): Promise<Uint8Array> {
  // Convert once, here: the fallback fonts depend on the final text, and
  // function components must not run twice. Emoji become images first, as in
  // the render, so their code points ask for no symbol font.
  const { node: tree, css } = await toNode(element, options.jsx);
  const node =
    options.emoji === 'from-font' ? tree : extractEmojis(tree, options.emoji ?? 'twemoji');
  const images = Array.isArray(options.images) ? { sources: options.images } : options.images;
  // One cache for both attempts below, so a retry fetches no image again.
  const fetchCache = imageCache();
  const renderNode = (fonts: Array<FontLoader>) =>
    render(node, {
      ...options,
      css: [...toList(options.css), ...css],
      images: { fetchCache, ...images },
      // Takumi uses every font registered in the process when it gets no list,
      // which includes earlier images' fallback fonts:
      // https://github.com/kane50613/takumi/blob/takumi@2.16.2/takumi-helpers/src/renderer.ts#L271-L282
      fonts,
    });
  const [fonts, fallback] = await Promise.all([
    Promise.all(((await options.fonts) ?? []).map(keyedFont)),
    fallbackFonts(node, options, images),
  ]);
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

/** Images fetched once per render, and emoji once per isolate. */
function imageCache(): ImageFetchCache {
  const cache = new Map<string, Promise<ArrayBuffer>>();
  return {
    get: (url) => cache.get(url) ?? emojiCache.get(url),
    set(url, data) {
      cache.set(url, data);
      if (url.startsWith(EMOJI_ORIGIN)) {
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

function hasBytes(font: Font): font is FontDetails & { lang?: string } {
  return (
    typeof font === 'object' &&
    'data' in font &&
    (font.data instanceof ArrayBuffer || font.data instanceof Uint8Array)
  );
}

const fontHashes = new WeakMap<ArrayBuffer | Uint8Array, Promise<string>>();

// Takumi keeps every registered font for the life of the process and tells
// them apart by buffer identity, so a font read anew for each request, as in
// next/og's examples, would be registered again every time. Key it by content.
async function keyedFont(font: Font): Promise<FontLoader> {
  if (!hasBytes(font)) {
    return font;
  }
  const { lang: _lang, data, ...details } = font;
  let hash = fontHashes.get(data);
  if (!hash) {
    hash = crypto.subtle
      .digest('SHA-256', data instanceof ArrayBuffer ? data : new Uint8Array(data))
      .then((digest) =>
        Array.from(new Uint8Array(digest, 0, 8), (byte) => byte.toString(16).padStart(2, '0')).join(
          '',
        ),
      );
    fontHashes.set(data, hash);
  }
  return {
    ...details,
    key: `void/og ${details.name ?? ''}:${details.weight ?? ''}:${details.style ?? ''}:${await hash}`,
    data: () => data,
  };
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

async function fallbackFonts(
  node: Node,
  options: RenderImageOptions,
  images: Exclude<RenderOptions['images'], Array<unknown>>,
): Promise<Array<FontSubset>> {
  const missing = Array.from(collectCodepoints(node))
    .filter((codepoint) => codepoint === 0xb5 || codepoint > 0xff)
    .map((codepoint) => String.fromCodePoint(codepoint))
    .filter((character) => !BUILT_IN.test(character));
  const families = new Set(
    FALLBACK_FONTS.filter(([script]) => missing.some((character) => script.test(character))).map(
      ([, family]) =>
        family === 'Noto Sans JP' ? cjkFamily(missing.join(''), options.lang ?? node.lang) : family,
    ),
  );
  if (missing.some((character) => !FALLBACK_FONTS.some(([script]) => script.test(character)))) {
    families.add('Noto Sans');
  }
  if (families.size === 0) {
    return [];
  }
  options.signal?.throwIfAborted();
  // One request per family: takumi caches the CSS by URL, and a family's
  // subsets are keyed alike whichever image asked for them.
  const subsets = await Promise.all(
    [...families].map(async (family) => {
      try {
        return await googleFonts({
          families: [family],
          fetch: images?.fetch,
          timeout: images?.timeout,
        });
      } catch (error) {
        console.warn(`void/og: could not load ${family} from Google Fonts.`, error);
        return [];
      }
    }),
  );
  // Satori draws each character with the first loaded font that has it, and
  // fallback fonts come after the default one, so Latin text keeps the default
  // font: https://github.com/vercel/satori/blob/0.33.5/src/font.ts#L601-L679
  // Takumi puts registered fonts before its built-in Geist, so take ASCII and
  // Latin-1 but µ out of every subset. A subset without ranges is a whole font.
  const stripped = subsets.flat().flatMap((subset) => {
    const unicodeRange = (
      subset.unicodeRange.length > 0 ? subset.unicodeRange : [[0x100, 0x10ffff] as const]
    ).flatMap(([start, end]): Array<[number, number]> => [
      ...(start <= 0xb5 && 0xb5 <= end ? [[0xb5, 0xb5] as [number, number]] : []),
      ...(end > 0xff ? [[Math.max(start, 0x100), end] as [number, number]] : []),
    ]);
    if (unicodeRange.length === 0) {
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
