import type { ImageFont, ImageFontBytes, ImageFontUrl } from '../types.ts';
import { assetDataUrl } from './assets.ts';

export type BrowserRunFontData = ImageFontBytes | ImageFontUrl;

/** CSS escapes also prevent a font name or URL from terminating the HTML style tag. */
function cssString(value: string): string {
  return `"${value.replace(/["\\<\r\n\f]/g, (character) => `\\${character.charCodeAt(0).toString(16)} `)}"`;
}

const genericFamilies = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy'] as const;

/** Preinstalled families: https://developers.cloudflare.com/browser-run/reference/supported-fonts/ */
export type BrowserRunDefaultFontFamily =
  | (typeof genericFamilies)[number]
  | 'Andale Mono'
  | 'Arial'
  | 'Arial Black'
  | 'Comic Sans MS'
  | 'Courier'
  | 'Courier New'
  | 'Georgia'
  | 'Helvetica'
  | 'Impact'
  | 'Lucida Handwriting'
  | 'Times'
  | 'Times New Roman'
  | 'Trebuchet MS'
  | 'Verdana'
  | 'Webdings'
  | `Bitstream Vera ${'Serif' | 'Sans' | 'Sans Mono'}`
  | 'Bitstream Cyberbit'
  | 'Cyberbit'
  | `DejaVu ${'Serif' | 'Sans' | 'Sans Mono'}`
  | `Free${'Serif' | 'Sans' | 'Mono'}`
  | 'GFS Neohellenic'
  | `Liberation ${'Serif' | 'Sans' | 'Mono'}`
  | 'Open Sans'
  | 'Roboto'
  | 'IPAGothic'
  | 'IPAPGothic'
  | 'Lohit Devanagari'
  | 'Lohit Bengali'
  | 'Lohit Tamil'
  | `Kacst${'Art' | 'Book' | 'Decorative' | 'Digital' | 'Farsi' | 'Letter' | 'Naskh' | 'Office' | 'One' | 'Pen' | 'Poster' | 'Qurn' | 'Screen' | 'Title' | 'TitleL'}`
  | `Noto ${'Sans' | 'Serif'} CJK ${'HK' | 'JP' | 'KR' | 'SC' | 'TC'}`
  | 'Noto Color Emoji'
  | 'Garuda'
  | 'Kinnari'
  | 'Laksaman'
  | 'Loma'
  | 'Norasi'
  | 'Purisa'
  | 'Sawasdee'
  | `Tlwg ${'Mono' | 'Typewriter' | 'Typist' | 'Typo'}`
  | 'Umpush'
  | 'Waree'
  | 'WenQuanYi Zen Hei';

const genericFamilyNames = new Set<string>(genericFamilies);

export function browserFontFamily(font: string | Array<string> | undefined): string {
  const families = typeof font === 'string' ? [font] : font;
  return (
    families?.map((name) => (genericFamilyNames.has(name) ? name : cssString(name))).join(',') ||
    '"Roboto",sans-serif'
  );
}

function fontSource(data: BrowserRunFontData): string {
  if (!(data instanceof Uint8Array) && !(data instanceof ArrayBuffer)) {
    if (!data || typeof data.url !== 'string') {
      throw new TypeError('void/image: Browser Run fonts require bytes or a URL.');
    }
    const url = new URL(data.url);
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new TypeError('void/image: Browser Run font URLs must use HTTPS without credentials.');
    }
    return url.href;
  }

  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const signature = String.fromCharCode(...bytes.subarray(0, 4));
  const mime =
    signature === 'wOF2'
      ? 'font/woff2'
      : signature === 'wOFF'
        ? 'font/woff'
        : signature === 'OTTO'
          ? 'font/otf'
          : 'font/ttf';
  return assetDataUrl(mime, bytes);
}

export function browserFontCss(
  fonts: ReadonlyArray<ImageFont<string, BrowserRunFontData>> | undefined,
): string {
  return (fonts ?? [])
    .map(({ name, data, weight, style }) => {
      if (weight !== undefined && (!Number.isFinite(weight) || weight < 1 || weight > 1000)) {
        throw new TypeError('void/image: font weight must be between 1 and 1000.');
      }
      return `@font-face{font-family:${cssString(name)};src:url(${cssString(fontSource(data))});font-weight:${weight ?? '1 1000'};font-style:${style === 'italic' ? 'italic' : 'normal'}}`;
    })
    .join('');
}
