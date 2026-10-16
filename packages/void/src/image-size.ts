/**
 * Intrinsic dimensions of an image file, read from its header the way the
 * `image-size` package (used by Next.js static image imports) reads them.
 * Pure: takes the file's bytes, has no dependencies, and never decodes pixels.
 */

/** Formats `readImageSize` recognizes. */
export type ImageSizeType =
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'avif'
  | 'heif'
  | 'svg'
  | 'bmp'
  | 'ico';

/** The intrinsic size of an image, in CSS pixels for SVG. */
export type ImageSize = { width: number; height: number; type: ImageSizeType };

const textDecoder = new TextDecoder();

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return end <= bytes.length ? textDecoder.decode(bytes.subarray(start, end)) : '';
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 2 ** 24 + bytes[offset + 1]! * 2 ** 16 + u16be(bytes, offset + 2);
}

function u32le(bytes: Uint8Array, offset: number): number {
  return u16le(bytes, offset) + bytes[offset + 2]! * 2 ** 16 + bytes[offset + 3]! * 2 ** 24;
}

function i32le(bytes: Uint8Array, offset: number): number {
  return u16le(bytes, offset) + bytes[offset + 2]! * 2 ** 16 + (bytes[offset + 3]! << 24);
}

function has(bytes: Uint8Array, length: number): boolean {
  return bytes.length >= length;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readPng(bytes: Uint8Array): Omit<ImageSize, 'type'> | undefined {
  if (!has(bytes, 24) || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    return undefined;
  }
  // Apple's CgBI PNGs put a CgBI chunk before IHDR.
  const ihdr = ascii(bytes, 12, 16) === 'CgBI' ? 28 : 12;
  if (ascii(bytes, ihdr, ihdr + 4) !== 'IHDR' || !has(bytes, ihdr + 12)) {
    return undefined;
  }
  return { width: u32be(bytes, ihdr + 4), height: u32be(bytes, ihdr + 8) };
}

/** SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC). */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function readJpeg(bytes: Uint8Array): Omit<ImageSize, 'type'> | undefined {
  if (!has(bytes, 4) || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      // Skip padding between segments.
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      // Fill byte before a marker.
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      // Markers without a length.
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      // End of image or start of scan before any frame header.
      return undefined;
    }
    const length = u16be(bytes, offset + 2);
    if (length < 2) {
      return undefined;
    }
    if (isStartOfFrame(marker)) {
      if (!has(bytes, offset + 9)) {
        return undefined;
      }
      // EXIF orientation is not applied, as in `image-size` (Next.js).
      return { height: u16be(bytes, offset + 5), width: u16be(bytes, offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

function readGif(bytes: Uint8Array): Omit<ImageSize, 'type'> | undefined {
  const signature = ascii(bytes, 0, 6);
  if ((signature !== 'GIF87a' && signature !== 'GIF89a') || !has(bytes, 10)) {
    return undefined;
  }
  return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
}

function readWebp(bytes: Uint8Array): Omit<ImageSize, 'type'> | undefined {
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== 'WEBP' || !has(bytes, 30)) {
    return undefined;
  }
  const chunk = ascii(bytes, 12, 16);
  if (chunk === 'VP8X') {
    // Canvas size, stored minus one.
    return { width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) };
  }
  if (chunk === 'VP8 ') {
    // Key frame start code, then 14-bit dimensions.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return undefined;
    }
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) {
      return undefined;
    }
    const b1 = bytes[21]!;
    const b2 = bytes[22]!;
    const b3 = bytes[23]!;
    const b4 = bytes[24]!;
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
    };
  }
  return undefined;
}

type Box = { type: string; start: number; contentStart: number; end: number };

/** ISO-BMFF boxes between `start` and `end`. */
function* boxes(bytes: Uint8Array, start: number, end: number): Generator<Box> {
  let offset = start;
  while (offset + 8 <= end) {
    let size = u32be(bytes, offset);
    const type = ascii(bytes, offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      // 64-bit `largesize`.
      if (offset + 16 > end) {
        return;
      }
      size = u32be(bytes, offset + 8) * 2 ** 32 + u32be(bytes, offset + 12);
      header = 16;
    } else if (size === 0) {
      // The box extends to the end of the file.
      size = end - offset;
    }
    if (size < header || offset + size > end) {
      return;
    }
    yield { type, start: offset, contentStart: offset + header, end: offset + size };
    offset += size;
  }
}

function findBox(bytes: Uint8Array, start: number, end: number, type: string): Box | undefined {
  for (const box of boxes(bytes, start, end)) {
    if (box.type === type) {
      return box;
    }
  }
  return undefined;
}

const HEIF_BRANDS: Record<string, 'avif' | 'heif'> = {
  avif: 'avif',
  avis: 'avif',
  mif1: 'heif',
  msf1: 'heif',
  heic: 'heif',
  heix: 'heif',
  hevc: 'heif',
  hevx: 'heif',
};

function readHeif(bytes: Uint8Array): ImageSize | undefined {
  if (ascii(bytes, 4, 8) !== 'ftyp') {
    return undefined;
  }
  const type = HEIF_BRANDS[ascii(bytes, 8, 12)];
  if (!type) {
    return undefined;
  }
  const meta = findBox(bytes, 0, bytes.length, 'meta');
  // `meta` and `ispe` are full boxes: version and flags precede their content.
  const iprp = meta && findBox(bytes, meta.contentStart + 4, meta.end, 'iprp');
  const ipco = iprp && findBox(bytes, iprp.contentStart, iprp.end, 'ipco');
  if (!ipco) {
    return undefined;
  }
  // Use the largest `ispe`: grid images list their tiles and thumbnails too,
  // and the primary image is the full-size one. `irot` is not applied, as in
  // `image-size` (Next.js).
  let size: ImageSize | undefined;
  for (const box of boxes(bytes, ipco.contentStart, ipco.end)) {
    if (box.type !== 'ispe' || box.contentStart + 12 > box.end) {
      continue;
    }
    const width = u32be(bytes, box.contentStart + 4);
    const height = u32be(bytes, box.contentStart + 8);
    if (!size || width * height > size.width * size.height) {
      size = { width, height, type };
    }
  }
  return size;
}

function readBmp(bytes: Uint8Array): Omit<ImageSize, 'type'> | undefined {
  if (ascii(bytes, 0, 2) !== 'BM' || !has(bytes, 26)) {
    return undefined;
  }
  // OS/2 BITMAPCOREHEADER stores 16-bit dimensions.
  if (u32le(bytes, 14) === 12) {
    return { width: u16le(bytes, 18), height: u16le(bytes, 20) };
  }
  // Height is negative for top-down bitmaps.
  return { width: u32le(bytes, 18), height: Math.abs(i32le(bytes, 22)) };
}

function readIco(bytes: Uint8Array): Omit<ImageSize, 'type'> | undefined {
  if (!has(bytes, 6)) {
    return undefined;
  }
  const reserved = u16le(bytes, 0);
  const kind = u16le(bytes, 2);
  const count = u16le(bytes, 4);
  // 1 = icon, 2 = cursor.
  if (reserved !== 0 || (kind !== 1 && kind !== 2) || count === 0 || !has(bytes, 6 + count * 16)) {
    return undefined;
  }
  // The largest entry; a stored 0 means 256 pixels.
  let size: Omit<ImageSize, 'type'> | undefined;
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16;
    const width = bytes[entry] || 256;
    const height = bytes[entry + 1] || 256;
    if (!size || width * height > size.width * size.height) {
      size = { width, height };
    }
  }
  return size;
}

const SVG_ROOT = /<svg\s(?:[^>"']|"[^"]*"|'[^']*')*>/;
const SVG_WIDTH = /\swidth=(['"])([^%]+?)\1/;
const SVG_HEIGHT = /\sheight=(['"])([^%]+?)\1/;
const SVG_VIEW_BOX = /\sviewBox=(['"])(.+?)\1/i;
const CM_PER_INCH = 2.54;
const SVG_UNITS: Record<string, number> = {
  in: 96,
  cm: 96 / CM_PER_INCH,
  em: 16,
  ex: 8,
  m: (96 / CM_PER_INCH) * 100,
  mm: 96 / CM_PER_INCH / 10,
  pc: 96 / 72 / 12,
  pt: 96 / 72,
  px: 1,
};
const SVG_LENGTH = new RegExp(`^([0-9.]+(?:e\\d+)?)(${Object.keys(SVG_UNITS).join('|')})?$`);

function parseSvgLength(value: string): number | undefined {
  const match = SVG_LENGTH.exec(value.trim());
  return match ? Math.round(Number(match[1]) * (SVG_UNITS[match[2] ?? 'px'] ?? 1)) : undefined;
}

function readSvg(bytes: Uint8Array): Omit<ImageSize, 'type'> | undefined {
  const root = SVG_ROOT.exec(textDecoder.decode(bytes))?.[0];
  if (!root) {
    return undefined;
  }
  const width = parseSvgLength(SVG_WIDTH.exec(root)?.[2] ?? '');
  const height = parseSvgLength(SVG_HEIGHT.exec(root)?.[2] ?? '');
  if (width && height) {
    return { width, height };
  }
  const viewBox = SVG_VIEW_BOX.exec(root)?.[2]
    ?.trim()
    .split(/[\s,]+/);
  if (!viewBox || viewBox.length !== 4) {
    return undefined;
  }
  const boxWidth = parseSvgLength(viewBox[2]!);
  const boxHeight = parseSvgLength(viewBox[3]!);
  if (!boxWidth || !boxHeight) {
    return undefined;
  }
  // One authored dimension keeps the viewBox aspect ratio.
  const ratio = boxWidth / boxHeight;
  if (width) {
    return { width, height: Math.floor(width / ratio) };
  }
  if (height) {
    return { width: Math.floor(height * ratio), height };
  }
  return { width: boxWidth, height: boxHeight };
}

const READERS: Array<[ImageSizeType, (bytes: Uint8Array) => Omit<ImageSize, 'type'> | undefined]> =
  [
    ['png', readPng],
    ['jpeg', readJpeg],
    ['gif', readGif],
    ['webp', readWebp],
    ['bmp', readBmp],
    ['ico', readIco],
  ];

function isDimension(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * The width and height stored in an image's header: PNG, JPEG, GIF, WebP
 * (VP8, VP8L, VP8X), AVIF/HEIC (`ispe`), SVG (`width`/`height` or
 * `viewBox`), BMP and ICO. `undefined` for other or malformed files.
 */
export function readImageSize(bytes: Uint8Array): ImageSize | undefined {
  let size: ImageSize | undefined = readHeif(bytes);
  for (const [type, read] of READERS) {
    if (size) {
      break;
    }
    const found = read(bytes);
    size = found && { ...found, type };
  }
  if (!size) {
    const svg = readSvg(bytes);
    size = svg && { ...svg, type: 'svg' };
  }
  return size && isDimension(size.width) && isDimension(size.height) ? size : undefined;
}
