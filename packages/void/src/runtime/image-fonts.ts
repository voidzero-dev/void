/**
 * Fonts for `void/image`: the app's own fonts, keyed for reuse in Takumi,
 * bundled Inter, and Google Fonts fallbacks for missing glyphs.
 */
import type { FontLoader, Node } from 'takumi-js';
import { collectCodepoints, googleFonts, subsetFonts, type FontSubset } from 'takumi-js/helpers';
import { interCoverage, interData } from './image-inter.ts';

export type DefaultFont = 'Inter' | 'Geist';

// A private family keeps custom Inter faces separate from the bundled font.
// A stable key lets Takumi reuse the registration until the renderer's cache is cleared.
export const interFont: FontLoader = {
  name: 'void/image Inter',
  key: 'void/image Inter 4.1',
  data: interData,
};

/** A font file's URL, or a font's bytes with its name, weight and style. */
export type Font =
  | string
  | {
      name: string;
      data: ArrayBuffer | Uint8Array;
      /**
       * The weight the font draws, from 1 to 1000. Leave it out for a variable
       * font, so each element's `fontWeight` sets the weight; with it, the font
       * draws only this weight.
       */
      weight?: number;
      style?: 'normal' | 'italic';
      /**
       * Accepted and ignored: text uses the first font that has the glyph. The
       * `lang` option, or attribute on the root element, chooses the font for
       * Chinese characters instead.
       */
      lang?: string;
    };

/** A fallback font file that failed to download. */
export class FallbackFontError extends Error {}

// Google Fonts families for text the default font cannot draw: each script's
// Noto family. Takumi has no hook for characters that no font has, so these
// families are matched by script before the render. `cjkFamily` settles the
// first one; `Noto Sans` takes any other text.
const FALLBACK_FONTS: Array<[script: RegExp, family: string]> = [
  // Script extensions, so marks such as ・ and ー, which Unicode files under the
  // Common script, stay with the family that draws the kana around them.
  [/[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}　-〿＀-￯]/u, 'Noto Sans JP'],
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
  // Geist's additional subsets; Inter's missing Latin/Cyrillic goes to Noto Sans.
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

// Google Fonts answers a `text` parameter with one file holding just those
// characters, with the whole weight axis. Without it, a family comes as files
// split by character range: a Japanese title needs about 20 of Noto Sans JP's
// 124, 480 KB in all, against one 26 KB file. Past a query of about 7,500
// characters (some 800 kanji), Google returns every range file instead, and
// longer queries fail, so longer text asks for the range files.
const GOOGLE_FONTS_CSS = 'https://fonts.googleapis.com/css2';
const MAX_TEXT_QUERY = 6000;

function cssUrl(characters: Array<string>): string | undefined {
  const text = encodeURIComponent([...new Set(characters)].sort().join(''));
  return text.length <= MAX_TEXT_QUERY ? `${GOOGLE_FONTS_CSS}?text=${text}` : undefined;
}

// Takumi's embedded Latin Geist subset, verified by rendering each codepoint
// with takumi-js 2.18 and 2.20. Keep these sorted, like Inter's generated cmap.
const geistCoverage: ReadonlyArray<readonly [number, number]> = [
  [0x0, 0xb4],
  [0xb6, 0x101],
  [0x112, 0x113],
  [0x12a, 0x12b],
  [0x131, 0x131],
  [0x14c, 0x14d],
  [0x152, 0x153],
  [0x16a, 0x16b],
  [0x178, 0x178],
  [0x1d5, 0x1d6],
  [0x1de, 0x1df],
  [0x1e2, 0x1e3],
  [0x22a, 0x22d],
  [0x232, 0x233],
  [0x2bc, 0x2bc],
  [0x2c6, 0x2c6],
  [0x2da, 0x2da],
  [0x2dc, 0x2dc],
  [0x304, 0x304],
  [0x308, 0x308],
  [0x34f, 0x34f],
  [0x37e, 0x37e],
  [0x387, 0x387],
  [0x1e20, 0x1e21],
  [0x1e26, 0x1e27],
  [0x1e4e, 0x1e4f],
  [0x1e7a, 0x1e7b],
  [0x1e84, 0x1e85],
  [0x1e8c, 0x1e8d],
  [0x1e97, 0x1e97],
  [0x2000, 0x200f],
  [0x2013, 0x2014],
  [0x2018, 0x201a],
  [0x201c, 0x201e],
  [0x2020, 0x2022],
  [0x2026, 0x2026],
  [0x2028, 0x2030],
  [0x2032, 0x2033],
  [0x2039, 0x203a],
  [0x2044, 0x2044],
  [0x205f, 0x206f],
  [0x20ac, 0x20ac],
  [0x2122, 0x2122],
  [0x212a, 0x212b],
  [0x2191, 0x2191],
  [0x2193, 0x2193],
  [0x2212, 0x2212],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
];

function coverage(defaultFont: DefaultFont) {
  return defaultFont === 'Inter' ? interCoverage : geistCoverage;
}

function hasDefaultGlyph(codepoint: number, defaultFont: DefaultFont): boolean {
  // Controls, variation selectors and formatting characters need no downloaded glyph.
  if (codepoint < 0x20 || /[\p{Cf}\p{Variation_Selector}]/u.test(String.fromCodePoint(codepoint))) {
    return true;
  }
  return coverage(defaultFont).some(([start, end]) => codepoint >= start && codepoint <= end);
}

function withoutDefaultGlyphs(
  start: number,
  end: number,
  defaultFont: DefaultFont,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let cursor = start;
  for (const [coveredStart, coveredEnd] of coverage(defaultFont)) {
    if (coveredEnd < cursor) {
      continue;
    }
    if (coveredStart > end) {
      break;
    }
    if (coveredStart > cursor) {
      ranges.push([cursor, coveredStart - 1]);
    }
    cursor = coveredEnd + 1;
    if (cursor > end) {
      break;
    }
  }
  if (cursor <= end) {
    ranges.push([cursor, end]);
  }
  return ranges;
}

function hasBytes(font: Font): font is Exclude<Font, string> {
  return (
    typeof font === 'object' &&
    (font.data instanceof ArrayBuffer || font.data instanceof Uint8Array)
  );
}

const fontHashes = new WeakMap<ArrayBuffer | Uint8Array, Promise<string>>();

// Takumi tells unkeyed fonts apart by buffer identity, so a font read anew for
// each request would be registered again every time. Key it by content.
export async function keyedFont(font: Font): Promise<FontLoader> {
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
    key: `void/image ${details.name ?? ''}:${details.weight ?? ''}:${details.style ?? ''}:${await hash}`,
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

/**
 * The Google Fonts subsets that draw the characters in `node` that the
 * selected default font cannot. A file that fails to download adds its key to
 * `failed` and rejects with a `FallbackFontError`.
 */
export async function fallbackFonts(
  node: Node,
  lang: string | undefined,
  timeout: number | undefined,
  failed: Set<string>,
  defaultFont: DefaultFont,
): Promise<Array<FontSubset>> {
  const missing = Array.from(collectCodepoints(node))
    .filter((codepoint) => !hasDefaultGlyph(codepoint, defaultFont))
    .map((codepoint) => String.fromCodePoint(codepoint));
  // The characters each family is asked to draw.
  const families = new Map<string, Array<string>>();
  for (const [script, name] of FALLBACK_FONTS) {
    const characters = missing.filter((character) => script.test(character));
    if (characters.length > 0) {
      // Han text can go to the same family as Hangul, so add to it.
      const family =
        name === 'Noto Sans JP'
          ? cjkFamily(missing.join(''), lang)
          : name === 'Geist' && defaultFont === 'Inter'
            ? 'Noto Sans'
            : name;
      families.set(family, [...(families.get(family) ?? []), ...characters]);
    }
  }
  const unmatched = missing.filter(
    (character) => !FALLBACK_FONTS.some(([script]) => script.test(character)),
  );
  if (unmatched.length > 0) {
    families.set('Noto Sans', [...(families.get('Noto Sans') ?? []), ...unmatched]);
  }
  if (families.size === 0) {
    return [];
  }
  // One request per family: takumi caches the CSS by URL.
  const subsets = await Promise.all(
    [...families].map(async ([family, characters]) => {
      try {
        return await googleFonts({
          families: [
            SINGLE_WEIGHT_FAMILIES.has(family) ? family : { name: family, weight: '100..900' },
          ],
          baseUrl: cssUrl(characters),
          timeout,
        });
      } catch (error) {
        console.warn(`void/image: could not load ${family} from Google Fonts.`, error);
        return [];
      }
    }),
  );
  // Subtract the default font's entire coverage, not just this image's text:
  // a range-based Google subset keeps the same registration on later images.
  // Keep each default's faces separate, since their allowed ranges differ.
  const prefix = `void/image ${defaultFont} fallback`;
  const stripped = subsets.flat().flatMap((subset) => {
    const unicodeRange = (
      subset.unicodeRange.length > 0 ? subset.unicodeRange : [[0, 0x10ffff] as const]
    ).flatMap(([start, end]) => withoutDefaultGlyphs(start, end, defaultFont));
    if (unicodeRange.length === 0) {
      return [];
    }
    return {
      ...subset,
      unicodeRange,
      // Private names: Takumi keeps fonts per process, so the app's own copy
      // of the family, Latin glyphs included, must not join this one.
      name: `${prefix} ${subset.name}`,
      key: `${prefix} ${subset.key}`,
      data: () =>
        subset.data().catch((cause: unknown) => {
          // Record and report each failed file here: when several fail at
          // once, Takumi's rejection carries only the first.
          failed.add(`${prefix} ${subset.key}`);
          console.warn(
            `void/image: could not download ${subset.name}. Rendering without it.`,
            cause,
          );
          throw new FallbackFontError(`void/image: could not download ${subset.name}.`, { cause });
        }),
    };
  });
  // Takumi downloads the subsets of its list-marker sample as well, so keep
  // only those the text uses.
  return subsetFonts({ fonts: stripped, source: node });
}
