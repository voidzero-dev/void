/**
 * `void/og` — an `ImageResponse` that renders JSX or HTML to an image with
 * Takumi.
 *
 * Takumi does the rendering (Wasm on workerd, its native addon on Node). This
 * module adds what a route handler needs around it: a 1200×630 default size,
 * the response headers, `debug`, and Google Fonts fallbacks for text that
 * Takumi's built-in Geist cannot draw.
 */
import { render, type FontLoader, type Node, type RenderInput } from 'takumi-js';
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

/** A font file's URL, or a font's bytes with its name, weight and style. */
type Font =
  | string
  | {
      name: string;
      data: ArrayBuffer | Uint8Array;
      weight?: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
      style?: 'normal' | 'italic';
      /**
       * Accepted and ignored: text uses the first font that has the glyph. The
       * `lang` option, or attribute on the root element, chooses the font for
       * Chinese characters instead.
       */
      lang?: string;
    };

/**
 * Void declares these options rather than passing Takumi's render options
 * through, so a Takumi upgrade does not change this API.
 */
export interface ImageResponseOptions extends ResponseInit {
  /** Image width in pixels. Defaults to 1200. */
  width?: number;
  /** Image height in pixels. Defaults to 630. */
  height?: number;
  /** Draws a border around every box. */
  debug?: boolean;
  /** Fonts to draw text with, before the built-in Geist. */
  fonts?: Array<Font>;
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

type ImageOptions = Omit<ImageResponseOptions, keyof ResponseInit>;

// Google Fonts families for text the default font cannot draw: each script's
// Noto family. Takumi has no hook for characters that no font has, so these
// families are matched by script before the render. `cjkFamily` settles the
// first one; `Noto Sans` takes any other text.
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

// The fallback families Google Fonts serves only at weight 400. Every other
// family above is a variable font with a 100–900 weight axis, and is asked
// for as that range: Google then serves `font-weight: 100 900`, Takumi leaves
// the face without a fixed weight, and `font-weight: 700` drives the axis.
// Asked for at a single 400, a variable face is pinned to 400 and bold text is
// only thickened, so 700 and 900 look the same. Asking for a range from these
// two fails the whole request with HTTP 400, which would lose the family.
// Found by asking css2 for each family with `wght@100..900`.
const SINGLE_WEIGHT_FAMILIES = new Set(['Noto Sans Math', 'Noto Sans Symbols 2']);

// What Takumi's built-in Geist draws beyond ASCII and Latin-1 without µ, found
// by rendering each code point with takumi-js 2.18 (2.20 draws the same): some
// accented letters and combining marks, spaces, format characters and variation
// selectors, quotes, dashes, € ™ − ↑ ↓. Number forms such as ⅓ stay missing:
// no served subset has them.
/* oxlint-disable no-misleading-character-class -- the marks and selectors are listed on their own */
const BUILT_IN =
  /[\u{100}\u{101}\u{112}\u{113}\u{12A}\u{12B}\u{131}\u{14C}\u{14D}\u{152}\u{153}\u{16A}\u{16B}\u{178}\u{1D5}\u{1D6}\u{1DE}\u{1DF}\u{1E2}\u{1E3}\u{22A}-\u{22D}\u{232}\u{233}\u{2BC}\u{2C6}\u{2DA}\u{2DC}\u{304}\u{308}\u{34F}\u{37E}\u{387}\u{1E20}\u{1E21}\u{1E26}\u{1E27}\u{1E4E}\u{1E4F}\u{1E7A}\u{1E7B}\u{1E84}\u{1E85}\u{1E8C}\u{1E8D}\u{1E97}\u{2000}-\u{200F}\u{2013}\u{2014}\u{2018}-\u{201A}\u{201C}-\u{201E}\u{2020}-\u{2022}\u{2026}\u{2028}-\u{2030}\u{2032}\u{2033}\u{2039}\u{203A}\u{2044}\u{205F}-\u{206F}\u{20AC}\u{2122}\u{212A}\u{212B}\u{2191}\u{2193}\u{2212}\u{FE00}-\u{FE0F}\u{FEFF}]/u;
/* oxlint-enable no-misleading-character-class */

// Emoji come from jsDelivr by code point and never change, so keep them for the
// life of the isolate; other images are fetched for each render.
const EMOJI_ORIGIN = 'https://cdn.jsdelivr.net/';
const emojiCache = new Map<string, Promise<ArrayBuffer>>();

/**
 * A `Response` whose body is the image rendered from `element`: React JSX, an
 * HTML string, or a Takumi node tree. It renders a 1200×630 PNG by default,
 * which clients revalidate outside development.
 */
export class ImageResponse extends Response {
  constructor(element: RenderInput, options: ImageResponseOptions = {}) {
    const { status, statusText, headers, ...imageOptions } = options;
    // Set these two headers unless the caller's `headers` has them. A failed
    // render still ends as a complete response, so clients revalidate the
    // image rather than cache it for long.
    const responseHeaders = new Headers(headers);
    if (!responseHeaders.has('content-type')) {
      responseHeaders.set('content-type', 'image/png');
    }
    if (!responseHeaders.has('cache-control')) {
      responseHeaders.set(
        'cache-control',
        isDevelopment() ? 'no-cache, no-store' : 'public, max-age=0, must-revalidate',
      );
    }
    // Render while the body streams, so a failure errors the body.
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const image = await renderImage(element, imageOptions);
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

async function renderImage(element: RenderInput, options: ImageOptions): Promise<Uint8Array> {
  // Convert once, here: the fallback fonts depend on the final text, and
  // function components must not run twice. Emoji become images first, as in
  // the render, so their code points ask for no symbol font.
  const { node: tree, css } = await toNode(element);
  const emoji = options.emoji ?? 'twemoji';
  const node = extractEmojis(tree, emoji);
  // Only the documented limits reach Takumi, which takes more image options.
  const { allowUrl, maxBytes, timeout, throwOnError } = options.images ?? {};
  // One cache for both attempts below, so a retry fetches no image again.
  const fetchCache = imageCache();
  const renderNode = (fonts: Array<FontLoader>) =>
    render(node, {
      width: options.width ?? 1200,
      height: options.height ?? 630,
      drawDebugBorder: options.debug,
      lang: options.lang,
      emoji,
      css,
      images: { fetchCache, allowUrl, maxBytes, timeout, throwOnError },
      // Takumi uses every font registered in the process when it gets no list,
      // which includes earlier images' fallback fonts:
      // https://github.com/kane50613/takumi/blob/takumi@2.20.0/takumi-helpers/src/renderer.ts#L384-L412
      fonts,
    });
  // Keys of the fallback files that failed to download during this image.
  const failed = new Set<string>();
  const [fonts, fallback] = await Promise.all([
    Promise.all((options.fonts ?? []).map(keyedFont)),
    fallbackFonts(node, options.lang ?? node.lang, timeout, failed),
  ]);
  if (fallback.length === 0) {
    return renderNode(fonts);
  }
  // A font that fails to download leaves its glyphs missing rather than
  // failing the image.
  // Takumi downloads the files together and rejects the render on the first
  // failure, so retry without the files that failed, and only those: a flaky
  // symbol font must not also drop the Japanese one. Files that did download
  // stay registered in Takumi, so a retry fetches none of them again.
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

function toNode(element: RenderInput) {
  if (typeof element === 'string') {
    return fromHtml(element);
  }
  if (isTakumiNode(element)) {
    return { node: element, css: [] };
  }
  return fromJsx(element);
}

function isTakumiNode(element: unknown): element is Node {
  const type = (element as { type?: unknown } | null)?.type;
  return type === 'container' || type === 'text' || type === 'image';
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

function hasBytes(font: Font): font is Exclude<Font, string> {
  return (
    typeof font === 'object' &&
    (font.data instanceof ArrayBuffer || font.data instanceof Uint8Array)
  );
}

const fontHashes = new WeakMap<ArrayBuffer | Uint8Array, Promise<string>>();

// Takumi keeps every registered font for the life of the process and tells
// them apart by buffer identity, so a font read anew for each request would be
// registered again every time. Key it by content.
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

// Han text is drawn as Japanese unless a language says otherwise. Takumi takes
// the first font with a glyph and ignores `lang`, so one family draws all Han
// text in an image, chosen from the `lang` option or the root element's `lang`.
function cjkFamily(text: string, lang = ''): string {
  // An explicit language wins over the scripts in the text: a Traditional
  // Chinese title with a katakana loanword (タワー) is still Chinese. Google's
  // Noto Sans SC, TC and KR all include kana, so no character is left without
  // a glyph.
  const tag = lang.toLowerCase();
  if (tag.startsWith('ja')) {
    return 'Noto Sans JP';
  }
  if (tag.startsWith('ko')) {
    return 'Noto Sans KR';
  }
  if (tag.startsWith('zh')) {
    return /hant|-tw|-hk|-mo/.test(tag) ? 'Noto Sans TC' : 'Noto Sans SC';
  }
  // Without one, kana marks Japanese and Hangul marks Korean.
  if (/[\p{sc=Hiragana}\p{sc=Katakana}]/u.test(text)) {
    return 'Noto Sans JP';
  }
  if (/\p{sc=Hangul}/u.test(text)) {
    return 'Noto Sans KR';
  }
  return 'Noto Sans JP';
}

async function fallbackFonts(
  node: Node,
  lang: string | undefined,
  timeout: number | undefined,
  failed: Set<string>,
): Promise<Array<FontSubset>> {
  const missing = Array.from(collectCodepoints(node))
    .filter((codepoint) => codepoint === 0xb5 || codepoint > 0xff)
    .map((codepoint) => String.fromCodePoint(codepoint))
    .filter((character) => !BUILT_IN.test(character));
  const families = new Set(
    FALLBACK_FONTS.filter(([script]) => missing.some((character) => script.test(character))).map(
      ([, family]) => (family === 'Noto Sans JP' ? cjkFamily(missing.join(''), lang) : family),
    ),
  );
  if (missing.some((character) => !FALLBACK_FONTS.some(([script]) => script.test(character)))) {
    families.add('Noto Sans');
  }
  if (families.size === 0) {
    return [];
  }
  // One request per family: takumi caches the CSS by URL, and a family's
  // subsets are keyed alike whichever image asked for them.
  const subsets = await Promise.all(
    [...families].map(async (family) => {
      try {
        return await googleFonts({
          families: [
            SINGLE_WEIGHT_FAMILIES.has(family) ? family : { name: family, weight: '100..900' },
          ],
          timeout,
        });
      } catch (error) {
        console.warn(`void/og: could not load ${family} from Google Fonts.`, error);
        return [];
      }
    }),
  );
  // Latin text should keep the default font, but Takumi draws each character
  // with the first font that has it and puts registered fonts before its
  // built-in Geist, so take ASCII and Latin-1 but µ out of every subset. A
  // subset without ranges is a whole font.
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
          // Record and report each failed file here: when several fail at
          // once, Takumi's rejection carries only the first.
          failed.add(`void/og ${subset.key}`);
          console.warn(`void/og: could not download ${subset.name}. Rendering without it.`, cause);
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
