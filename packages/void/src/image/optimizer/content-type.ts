/**
 * Image content sniffing for `/_void/image`, ported from Next.js 16
 * (`detect-content-type.js`, the `image-detector` fallback it bundles, and
 * `is-animated`). The endpoint never trusts an upstream `Content-Type`.
 */

export const AVIF = 'image/avif';
export const WEBP = 'image/webp';
export const PNG = 'image/png';
export const JPEG = 'image/jpeg';
export const JXL = 'image/jxl';
export const JP2 = 'image/jp2';
export const HEIC = 'image/heic';
export const GIF = 'image/gif';
export const SVG = 'image/svg+xml';
export const ICO = 'image/x-icon';
export const ICNS = 'image/x-icns';
export const TIFF = 'image/tiff';
export const BMP = 'image/bmp';
export const PDF = 'application/pdf';

/** Types that may be animated; animated sources are served unchanged. */
export const ANIMATABLE_TYPES: ReadonlyArray<string> = [WEBP, PNG, GIF];

/** Types Next.js never transforms. */
export const BYPASS_TYPES: ReadonlyArray<string> = [SVG, ICO, ICNS, BMP, JXL, HEIC];

/** File extensions Next.js derives from an output type (`mime` 1.x plus its additions). */
const EXTENSIONS: Readonly<Record<string, string>> = {
  [AVIF]: 'avif',
  [WEBP]: 'webp',
  [PNG]: 'png',
  [JPEG]: 'jpeg',
  [JXL]: 'jxl',
  [JP2]: 'jp2',
  [HEIC]: 'heic',
  [GIF]: 'gif',
  [SVG]: 'svg',
  [ICO]: 'ico',
  [ICNS]: 'icns',
  [TIFF]: 'tiff',
  [BMP]: 'bmp',
  [PDF]: 'pdf',
};

/** The file extension for a served image type, or `undefined` for an unknown type. */
export function getImageExtension(contentType: string): string | undefined {
  return EXTENSIONS[contentType];
}

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>): boolean =>
  signature.every((byte, index) => bytes[index] === byte);

/** Signature where `0` bytes are wildcards (box sizes and RIFF lengths). */
const startsWithMasked = (bytes: Uint8Array, signature: ReadonlyArray<number>): boolean =>
  signature.every((byte, index) => !byte || bytes[index] === byte);

/**
 * The image type of `bytes` from its magic bytes, or `null` when it is empty
 * or not an image Next.js recognizes. Every match Next.js makes is kept,
 * including non-image types (`application/pdf`) that the endpoint rejects.
 */
export function detectContentType(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0) {
    return null;
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return JPEG;
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return PNG;
  }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return GIF;
  }
  if (startsWithMasked(bytes, [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])) {
    return WEBP;
  }
  if (startsWith(bytes, [0x3c, 0x3f, 0x78, 0x6d, 0x6c])) {
    return SVG;
  }
  if (startsWith(bytes, [0x3c, 0x73, 0x76, 0x67])) {
    return SVG;
  }
  if (startsWithMasked(bytes, [0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])) {
    return AVIF;
  }
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) {
    return ICO;
  }
  if (startsWith(bytes, [0x69, 0x63, 0x6e, 0x73])) {
    return ICNS;
  }
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00])) {
    return TIFF;
  }
  if (startsWith(bytes, [0x42, 0x4d])) {
    return BMP;
  }
  if (startsWith(bytes, [0xff, 0x0a])) {
    return JXL;
  }
  if (startsWith(bytes, [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a])) {
    return JXL;
  }
  if (startsWithMasked(bytes, [0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])) {
    return HEIC;
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return PDF;
  }
  if (startsWith(bytes, [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a])) {
    return JP2;
  }
  switch (detectFormat(bytes.subarray(0, 1024))) {
    case 'webp':
      return WEBP;
    case 'png':
      return PNG;
    case 'jpg':
      return JPEG;
    case 'gif':
      return GIF;
    case 'svg':
      return SVG;
    case 'jxl':
    case 'jxl-stream':
      return JXL;
    case 'jp2':
      return JP2;
    case 'tiff':
      return TIFF;
    case 'bmp':
      return BMP;
    case 'ico':
      return ICO;
    case 'icns':
      return ICNS;
    default:
      // heif, cur, dds, j2c, ktx, pnm, psd, tga and unknown input.
      return null;
  }
}

// The `image-detector` fallback (image-size's validators). Out-of-range reads
// produce `NaN`, which fails every comparison, exactly as in the original.
const text = new TextDecoder();
const utf8 = (bytes: Uint8Array, start = 0, end = bytes.length): string =>
  text.decode(bytes.slice(start, end));
const hex = (bytes: Uint8Array, start: number, end: number): string =>
  Array.from(bytes.slice(start, end), (byte) => byte.toString(16).padStart(2, '0')).join('');
const readUInt16LE = (bytes: Uint8Array, offset: number): number =>
  bytes[offset] + bytes[offset + 1] * 2 ** 8;
const readUInt32BE = (bytes: Uint8Array, offset: number): number =>
  bytes[offset] * 2 ** 24 +
  bytes[offset + 1] * 2 ** 16 +
  bytes[offset + 2] * 2 ** 8 +
  bytes[offset + 3];
const readUInt32LE = (bytes: Uint8Array, offset: number): number =>
  bytes[offset] +
  bytes[offset + 1] * 2 ** 8 +
  bytes[offset + 2] * 2 ** 16 +
  bytes[offset + 3] * 2 ** 24;

function findBox(bytes: Uint8Array, name: string, offset: number): { offset: number } | undefined {
  while (offset < bytes.length) {
    if (bytes.length - offset < 4) {
      return undefined;
    }
    const size = readUInt32BE(bytes, offset);
    if (bytes.length - offset < size) {
      return undefined;
    }
    if (utf8(bytes, 4 + offset, 8 + offset) === name) {
      return { offset };
    }
    offset += size > 0 ? size : 8;
  }
  return undefined;
}

const ftypBrand = (bytes: Uint8Array): string | undefined => {
  const box = findBox(bytes, 'ftyp', 0);
  return box ? utf8(bytes, box.offset + 8, box.offset + 12) : undefined;
};

const HEIF_BRANDS = new Set(['avif', 'mif1', 'msf1', 'heic', 'heix', 'hevc', 'hevx']);
const PNM_TYPES = new Set(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'PF']);
const SVG_ROOT = /<svg\s([^>"']|"[^"]*"|'[^']*')*>/;

const VALIDATORS: ReadonlyArray<[string, (bytes: Uint8Array) => boolean]> = [
  ['bmp', (b) => utf8(b, 0, 2) === 'BM'],
  ['cur', (b) => readUInt16LE(b, 0) === 0 && readUInt16LE(b, 4) !== 0 && readUInt16LE(b, 2) === 2],
  ['dds', (b) => readUInt32LE(b, 0) === 542327876],
  ['gif', (b) => /^GIF8[79]a/.test(utf8(b, 0, 6))],
  ['heif', (b) => utf8(b, 4, 8) === 'ftyp' && HEIF_BRANDS.has(ftypBrand(b) ?? '')],
  ['icns', (b) => utf8(b, 0, 4) === 'icns'],
  ['ico', (b) => readUInt16LE(b, 0) === 0 && readUInt16LE(b, 4) !== 0 && readUInt16LE(b, 2) === 1],
  ['j2c', (b) => readUInt32BE(b, 0) === 4283432785],
  ['jp2', (b) => utf8(b, 4, 8) === 'jP  ' && ftypBrand(b) === 'jp2 '],
  ['jpg', (b) => hex(b, 0, 2) === 'ffd8'],
  ['jxl', (b) => utf8(b, 4, 8) === 'JXL ' && ftypBrand(b) === 'jxl '],
  ['jxl-stream', (b) => hex(b, 0, 2) === 'ff0a'],
  ['ktx', (b) => ['KTX 11', 'KTX 20'].includes(utf8(b, 1, 7))],
  [
    'png',
    (b) => {
      if (utf8(b, 1, 8) !== 'PNG\r\n\x1a\n') {
        return false;
      }
      // image-size throws "Invalid PNG" here, which fails the request in
      // Next.js. Treating it as unrecognized rejects it as not an image.
      const chunk = utf8(b, 12, 16) === 'CgBI' ? utf8(b, 28, 32) : utf8(b, 12, 16);
      return chunk === 'IHDR';
    },
  ],
  ['pnm', (b) => PNM_TYPES.has(utf8(b, 0, 2))],
  ['psd', (b) => utf8(b, 0, 4) === '8BPS'],
  ['svg', (b) => SVG_ROOT.test(utf8(b, 0, 1000))],
  ['tga', (b) => readUInt16LE(b, 0) === 0 && readUInt16LE(b, 4) === 0],
  ['tiff', (b) => ['49492a00', '4d4d002a'].includes(hex(b, 0, 4))],
  [
    'webp',
    (b) => utf8(b, 0, 4) === 'RIFF' && utf8(b, 8, 12) === 'WEBP' && utf8(b, 12, 15) === 'VP8',
  ],
];

const BY_FIRST_BYTE: Readonly<Record<number, string>> = {
  56: 'psd',
  66: 'bmp',
  68: 'dds',
  71: 'gif',
  73: 'tiff',
  77: 'tiff',
  82: 'webp',
  105: 'icns',
  137: 'png',
  255: 'jpg',
};

function detectFormat(bytes: Uint8Array): string | undefined {
  const validate = (name: string): boolean =>
    VALIDATORS.find(([candidate]) => candidate === name)![1](bytes);
  const likely = BY_FIRST_BYTE[bytes[0]];
  if (likely && validate(likely)) {
    return likely;
  }
  return VALIDATORS.find(([, matches]) => matches(bytes))?.[0];
}

const ascii = (bytes: Uint8Array, start: number, end: number): string =>
  String.fromCharCode(...bytes.subarray(start, end));

/** GIF data sub-blocks end with a zero-length block. */
function gifBlocksLength(bytes: Uint8Array, offset: number): number {
  let length = 0;
  while (bytes[offset + length]) {
    length += bytes[offset + length] + 1;
  }
  return length + 1;
}

function isAnimatedGif(bytes: Uint8Array): boolean {
  let hasColorTable = bytes[10] & 0x80;
  let colorTableSize = bytes[10] & 0x07;
  let offset = 6 + 7 + (hasColorTable ? 3 * 2 ** (colorTableSize + 1) : 0);
  let images = 0;
  while (images < 2 && offset < bytes.length) {
    switch (bytes[offset]) {
      case 0x2c:
        images += 1;
        hasColorTable = bytes[offset + 9] & 0x80;
        colorTableSize = bytes[offset + 9] & 0x07;
        offset += 10 + (hasColorTable ? 3 * 2 ** (colorTableSize + 1) : 0);
        offset += gifBlocksLength(bytes, offset + 1) + 1;
        break;
      case 0x21:
        offset += 2;
        offset += gifBlocksLength(bytes, offset);
        break;
      default:
        // The trailer (0x3b) or anything unexpected ends the scan.
        offset = bytes.length;
    }
  }
  return images > 1;
}

function isAnimatedPng(bytes: Uint8Array): boolean {
  let hasAnimationControl = false;
  let hasDefaultImage = false;
  let hasFrameData = false;
  let previous: string | null = null;
  let offset = 8;
  // A truncated chunk header ends the scan (is-animated throws a RangeError there).
  while (offset + 8 <= bytes.length) {
    const length = readUInt32BE(bytes, offset);
    const type = ascii(bytes, offset + 4, offset + 8);
    switch (type) {
      case 'acTL':
        hasAnimationControl = true;
        break;
      case 'IDAT':
        if (!hasAnimationControl || (previous !== 'fcTL' && previous !== 'IDAT')) {
          return false;
        }
        hasDefaultImage = true;
        break;
      case 'fdAT':
        if (!hasDefaultImage || (previous !== 'fcTL' && previous !== 'fdAT')) {
          return false;
        }
        hasFrameData = true;
        break;
    }
    previous = type;
    offset += 4 + 4 + length + 4;
  }
  return hasAnimationControl && hasDefaultImage && hasFrameData;
}

function isAnimatedWebp(bytes: Uint8Array): boolean {
  for (let index = 0; index + 4 <= bytes.length; index++) {
    if (
      bytes[index] === 0x41 &&
      bytes[index + 1] === 0x4e &&
      bytes[index + 2] === 0x49 &&
      bytes[index + 3] === 0x4d
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a GIF has more than one image, a PNG is an APNG with frame data,
 * or a WebP contains an `ANIM` chunk (`is-animated` rules).
 */
export function isAnimated(bytes: Uint8Array): boolean {
  if (ascii(bytes, 0, 3) === 'GIF') {
    return isAnimatedGif(bytes);
  }
  if (hex(bytes, 0, 8) === '89504e470d0a1a0a') {
    return isAnimatedPng(bytes);
  }
  if (ascii(bytes, 8, 12) === 'WEBP') {
    return isAnimatedWebp(bytes);
  }
  return false;
}
