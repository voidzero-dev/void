import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { readImageSize, type ImageSize } from '../../src/image-size.ts';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/images/${name}`, import.meta.url)));

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const u16be = (value: number) => [value >> 8, value & 0xff];
const u16le = (value: number) => [value & 0xff, value >> 8];
const u24le = (value: number) => [value & 0xff, (value >> 8) & 0xff, value >> 16];
const u32be = (value: number) => [...u16be(value >>> 16), ...u16be(value & 0xffff)];
const u32le = (value: number) => [...u16le(value & 0xffff), ...u16le(value >>> 16)];
const bytes = (...parts: Array<Array<number> | string>) =>
  new Uint8Array(parts.flatMap((part) => (typeof part === 'string' ? ascii(part) : part)));
const box = (type: string, ...content: Array<Array<number> | string>) => {
  const body = [...bytes(...content)];
  return [...u32be(8 + body.length), ...ascii(type), ...body];
};
const svg = (root: string, prefix = '') => bytes(`${prefix}${root}<rect/></svg>`);

/** Apple CgBI PNG: a CgBI chunk before IHDR. */
const cgbiPng = bytes(
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  u32be(4),
  'CgBI',
  [0x50, 0x00, 0x20, 0x06],
  [0, 0, 0, 0],
  u32be(13),
  'IHDR',
  u32be(57),
  u32be(114),
  [8, 6, 0, 0, 0],
);

/** Progressive JPEG with padding, an EXIF block (orientation 6, ignored) and DQT before SOF2. */
const exifJpeg = bytes(
  [0xff, 0xd8],
  [0xff, 0xe1],
  u16be(2 + 6 + 8 + 2 + 12),
  'Exif',
  [0, 0],
  'MM',
  [0x00, 0x2a],
  u32be(8),
  u16be(1),
  [0x01, 0x12, 0x00, 0x03],
  u32be(1),
  [0x00, 0x06, 0x00, 0x00],
  [0x00],
  [0xff, 0xff, 0xdb],
  u16be(4),
  [0, 0],
  [0xff, 0xc2],
  u16be(17),
  [8],
  u16be(300),
  u16be(400),
  [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
);

const jpegWithoutFrame = bytes([0xff, 0xd8], [0xff, 0xda], u16be(8), [1, 1, 0, 0, 0x3f, 0]);

const lossless = (width: number, height: number) => {
  const w = width - 1;
  const h = height - 1;
  return bytes(
    'RIFF',
    u32le(26),
    'WEBPVP8L',
    u32le(5),
    [0x2f, w & 0xff, ((w >> 8) & 0x3f) | ((h & 0x3) << 6), (h >> 2) & 0xff, (h >> 10) & 0x0f],
    [0, 0, 0, 0, 0],
  );
};

const extended = (width: number, height: number) =>
  bytes(
    'RIFF',
    u32le(22),
    'WEBPVP8X',
    u32le(10),
    [0x10, 0, 0, 0],
    u24le(width - 1),
    u24le(height - 1),
  );

/** HEIC with a tile, the full image and a thumbnail: the largest `ispe` wins. */
const heic = bytes(
  box('ftyp', 'heic', u32be(0), 'mif1heic'),
  box(
    'meta',
    u32be(0),
    box('hdlr', u32be(0), u32be(0), 'pict', u32be(0), u32be(0), u32be(0), [0]),
    box(
      'iprp',
      box(
        'ipco',
        box('colr', 'nclx', [0, 1, 0, 13, 0, 6, 0]),
        box('ispe', u32be(0), u32be(512), u32be(512)),
        box('ispe', u32be(0), u32be(4032), u32be(3024)),
        box('ispe', u32be(0), u32be(320), u32be(240)),
      ),
    ),
  ),
  box('mdat', [0, 0, 0, 0]),
);

const bmp = (header: 'info' | 'core', width: number, height: number) =>
  header === 'core'
    ? bytes(
        'BM',
        u32le(26),
        u32le(0),
        u32le(26),
        u32le(12),
        u16le(width),
        u16le(height),
        u16le(1),
        u16le(24),
      )
    : bytes(
        'BM',
        u32le(54),
        u32le(0),
        u32le(54),
        u32le(40),
        u32le(width),
        u32le(height >>> 0),
        u16le(1),
        u16le(24),
      );

const ico = (kind: number, entries: Array<[number, number]>) =>
  bytes(
    u16le(0),
    u16le(kind),
    u16le(entries.length),
    ...entries.map(([width, height]) => [
      width,
      height,
      0,
      0,
      1,
      0,
      32,
      0,
      ...u32le(40),
      ...u32le(0),
    ]),
  );

describe('readImageSize', () => {
  it.each<[string, Uint8Array, ImageSize]>([
    ['PNG', fixture('test.png'), { width: 100, height: 50, type: 'png' }],
    ['APNG', fixture('animated.png'), { width: 4, height: 4, type: 'png' }],
    ['CgBI PNG', cgbiPng, { width: 57, height: 114, type: 'png' }],
    ['baseline JPEG', fixture('test.jpg'), { width: 100, height: 50, type: 'jpeg' }],
    ['progressive JPEG with EXIF', exifJpeg, { width: 400, height: 300, type: 'jpeg' }],
    ['GIF89a', fixture('test.gif'), { width: 100, height: 50, type: 'gif' }],
    [
      'GIF87a',
      bytes('GIF87a', u16le(7), u16le(3), [0, 0, 0]),
      { width: 7, height: 3, type: 'gif' },
    ],
    ['WebP VP8', fixture('test.webp'), { width: 100, height: 50, type: 'webp' }],
    ['WebP VP8X', fixture('animated.webp'), { width: 8, height: 8, type: 'webp' }],
    ['WebP VP8X 16k', extended(16383, 9000), { width: 16383, height: 9000, type: 'webp' }],
    ['WebP VP8L', lossless(400, 300), { width: 400, height: 300, type: 'webp' }],
    ['WebP VP8L max', lossless(16384, 1), { width: 16384, height: 1, type: 'webp' }],
    ['AVIF', fixture('test.avif'), { width: 100, height: 50, type: 'avif' }],
    ['HEIC', heic, { width: 4032, height: 3024, type: 'heif' }],
    ['BMP', bmp('info', 30, 20), { width: 30, height: 20, type: 'bmp' }],
    ['top-down BMP', bmp('info', 30, -20), { width: 30, height: 20, type: 'bmp' }],
    ['OS/2 BMP', bmp('core', 12, 9), { width: 12, height: 9, type: 'bmp' }],
    [
      'ICO',
      ico(1, [
        [16, 16],
        [0, 0],
        [32, 32],
      ]),
      { width: 256, height: 256, type: 'ico' },
    ],
    ['CUR', ico(2, [[48, 24]]), { width: 48, height: 24, type: 'ico' }],
    [
      'SVG width and height',
      svg('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80">'),
      { width: 120, height: 80, type: 'svg' },
    ],
    [
      'SVG with units and a prolog',
      svg(
        `<svg height='1in' width="2in" viewBox="0 0 10 10">`,
        '<?xml version="1.0"?>\n<!-- logo -->\n',
      ),
      { width: 192, height: 96, type: 'svg' },
    ],
    [
      'SVG viewBox',
      svg('<svg viewBox="0 0 300 150" xmlns="http://www.w3.org/2000/svg">'),
      { width: 300, height: 150, type: 'svg' },
    ],
    [
      'SVG width and viewBox',
      svg('<svg width="600" viewBox="0 0 300 150">'),
      { width: 600, height: 300, type: 'svg' },
    ],
    [
      'SVG height and viewBox',
      svg('<svg height="75" viewBox="0 0 300 150">'),
      { width: 150, height: 75, type: 'svg' },
    ],
    [
      'SVG percentage size and comma viewBox',
      svg('<svg width="100%" height="100%" viewbox="0,0,40,20">'),
      { width: 40, height: 20, type: 'svg' },
    ],
  ])('reads %s', (_name, input, expected) => {
    expect(readImageSize(input)).toEqual(expected);
  });

  it.each<[string, Uint8Array]>([
    ['TIFF', fixture('test.tiff')],
    ['a truncated PNG', fixture('test.png').subarray(0, 20)],
    ['a JPEG without a frame header', jpegWithoutFrame],
    ['a zero-size GIF', bytes('GIF89a', u16le(0), u16le(10), [0, 0, 0])],
    ['an SVG without a size', svg('<svg xmlns="http://www.w3.org/2000/svg">')],
    ['an SVG with a percentage size only', svg('<svg width="100%" height="50%">')],
    ['text', bytes('hello, world')],
    ['an empty file', new Uint8Array()],
    ['a WebP with an unknown chunk', bytes('RIFF', u32le(22), 'WEBPVP9 ', new Array(18).fill(0))],
    ['a HEIF without ispe', bytes(box('ftyp', 'avif', u32be(0)), box('meta', u32be(0)))],
    ['an unknown ftyp brand', bytes(box('ftyp', 'isom', u32be(0)))],
  ])('returns undefined for %s', (_name, input) => {
    expect(readImageSize(input)).toBeUndefined();
  });
});
