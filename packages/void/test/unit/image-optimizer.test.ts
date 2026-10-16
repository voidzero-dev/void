import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { resolveImageConfig } from '../../src/image-config.ts';
import {
  detectContentType,
  extractEtag,
  getContentDisposition,
  getFileNameWithExtension,
  getImageEtag,
  getMaxAge,
  getSupportedImageFormat,
  isAnimated,
  isFreshRequest,
  isPrivateIpLiteral,
  validateImageParams,
} from '../../src/image/optimizer/index.ts';

const fixture = (name: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(readFileSync(join(import.meta.dirname, '../fixtures/images', name)));
const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
const bytes = (...values: Array<number>): Uint8Array<ArrayBuffer> => new Uint8Array(values);
const latin1 = (value: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Array.from(value, (character) => character.charCodeAt(0)));
const ftyp = (brand: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array([0, 0, 0, 16, ...latin1('ftyp'), ...latin1(brand), 0, 0, 0, 0]);

describe('validateImageParams', () => {
  const config = resolveImageConfig(
    { remotePatterns: [{ protocol: 'https', hostname: '*.example.com' }] },
    { root: '/', dev: false },
  );
  const longUrl = (length: number): string =>
    `url=${encodeURIComponent('/' + 'a'.repeat(length - 1))}&w=64&q=75`;

  // Expected results were produced by Next.js 16.4.2's real
  // `ImageOptimizerCache.validateParams` with `/_next/image` in place of
  // `/_void/image`, the default sizes and qualities, and the same patterns.
  it.each<[string, string, string | null]>([
    ['url missing', 'w=64&q=75', `"url" parameter is required`],
    ['url empty', 'url=&w=64&q=75', `"url" parameter is required`],
    ['url repeated', 'url=/a.png&url=/b.png&w=64&q=75', `"url" parameter cannot be an array`],
    ['url too long', longUrl(4001), `"url" parameter is too long`],
    ['url at the length limit', longUrl(3072), null],
    [
      'protocol-relative url',
      'url=%2F%2Fexample.vercel.sh&w=64&q=75',
      `"url" parameter cannot be a protocol-relative URL (//)`,
    ],
    [
      'recursive local url',
      'url=%2F_void%2Fimage%3Furl%3Dtest.pngw%3D1%26q%3D75&w=64&q=75',
      `"url" parameter cannot be recursive`,
    ],
    [
      'recursive url with a trailing slash',
      'url=%2F_void%2Fimage%2F&w=64&q=75',
      `"url" parameter cannot be recursive`,
    ],
    [
      'recursive url below a prefix',
      'url=%2Fassets%2F_void%2Fimage%3Furl%3D%252Ftest.png%26w%3D128%26q%3D75&w=64&q=75',
      `"url" parameter cannot be recursive`,
    ],
    [
      'percent-encoded recursion',
      'url=%2F%255Fvoid%2Fimage&w=64&q=75',
      `"url" parameter cannot be recursive`,
    ],
    ['similar path that is not recursive', 'url=%2F_void%2Fimages%2Fa.png&w=64&q=75', null],
    [
      'encoded relative url',
      'url=%252F_void%252Fimage%253Furl%253Dtest.pngw%253D1%2526q%253D1&w=64&q=75',
      `"url" parameter is invalid`,
    ],
    [
      'local url with a query',
      'url=%2Ftest.png%3Fv%3D1&w=64&q=75',
      `"url" parameter is not allowed`,
    ],
    ['local url', 'url=%2Ftest.png&w=64&q=75', null],
    ['local url with spaces', 'url=%2Fmy%20photo.png&w=64&q=75', null],
    [
      'file protocol',
      'url=file%3A%2F%2Fexample.vercel.sh%2Ftest.png&w=64&q=75',
      `"url" parameter is invalid`,
    ],
    [
      'ftp protocol',
      'url=ftp%3A%2F%2Fexample.vercel.sh%2Ftest.png&w=64&q=75',
      `"url" parameter is invalid`,
    ],
    ['data url', 'url=data%3Aimage%2Fpng%3Bbase64%2CAAAA&w=64&q=75', `"url" parameter is invalid`],
    [
      'remote host not allowed',
      'url=http%3A%2F%2Fvercel.com%2Fbutton&w=64&q=75',
      `"url" parameter is not allowed`,
    ],
    [
      'remote protocol not allowed',
      'url=http%3A%2F%2Fimg.example.com%2Fa.png&w=64&q=75',
      `"url" parameter is not allowed`,
    ],
    [
      'remote apex not matched by a wildcard',
      'url=https%3A%2F%2Fexample.com%2Fa.png&w=64&q=75',
      `"url" parameter is not allowed`,
    ],
    ['remote url allowed', 'url=https%3A%2F%2Fimg.example.com%2Fa.png&w=64&q=75', null],
    [
      'remote absolute endpoint url allowed',
      'url=https%3A%2F%2Fimg.example.com%2F_void%2Fimage%3Furl%3D%252Ffrog.jpg%26w%3D1024%26q%3D75&w=64&q=75',
      null,
    ],
    ['w missing', 'url=%2Ftest.png&q=75', `"w" parameter (width) is required`],
    ['w empty', 'url=%2Ftest.png&w=&q=75', `"w" parameter (width) is required`],
    ['w repeated', 'url=%2Ftest.png&w=64&w=128&q=75', `"w" parameter (width) cannot be an array`],
    [
      'w is 0',
      'url=%2Ftest.png&w=0&q=75',
      `"w" parameter (width) must be an integer greater than 0`,
    ],
    [
      'w is negative',
      'url=%2Ftest.png&w=-100&q=75',
      `"w" parameter (width) must be an integer greater than 0`,
    ],
    [
      'w is not a number',
      'url=%2Ftest.png&w=foo&q=75',
      `"w" parameter (width) must be an integer greater than 0`,
    ],
    [
      'w is not an integer',
      'url=%2Ftest.png&w=99.9&q=75',
      `"w" parameter (width) must be an integer greater than 0`,
    ],
    [
      'w with a plus sign',
      'url=%2Ftest.png&w=%2B64&q=75',
      `"w" parameter (width) must be an integer greater than 0`,
    ],
    [
      'w not in sizes',
      'url=%2Ftest.png&w=1000&q=75',
      `"w" parameter (width) of 1000 is not allowed`,
    ],
    ['w with leading zeros', 'url=%2Ftest.png&w=0064&q=75', null],
    [
      'w of 8 in production',
      'url=%2Ftest.png&w=8&q=70',
      `"w" parameter (width) of 8 is not allowed`,
    ],
    ['q missing', 'url=%2Ftest.png&w=64', `"q" parameter (quality) is required`],
    ['q repeated', 'url=%2Ftest.png&w=64&q=75&q=75', `"q" parameter (quality) cannot be an array`],
    [
      'q is not a number',
      'url=%2Ftest.png&w=64&q=foo',
      `"q" parameter (quality) must be an integer between 1 and 100`,
    ],
    [
      'q is not an integer',
      'url=%2Ftest.png&w=64&q=99.9',
      `"q" parameter (quality) must be an integer between 1 and 100`,
    ],
    [
      'q over 100',
      'url=%2Ftest.png&w=64&q=101',
      `"q" parameter (quality) must be an integer between 1 and 100`,
    ],
    [
      'q is 0',
      'url=%2Ftest.png&w=64&q=0',
      `"q" parameter (quality) must be an integer between 1 and 100`,
    ],
    [
      'q not in qualities',
      'url=%2Ftest.png&w=64&q=13',
      `"q" parameter (quality) of 13 is not allowed`,
    ],
    ['q with leading zeros', 'url=%2Ftest.png&w=64&q=075', null],
    [
      'q with leading zeros not in qualities',
      'url=%2Ftest.png&w=64&q=013',
      `"q" parameter (quality) of 013 is not allowed`,
    ],
    [
      'q range checked after the width list',
      'url=%2Ftest.png&w=1000&q=0',
      `"w" parameter (width) of 1000 is not allowed`,
    ],
    [
      'q format checked before the width list',
      'url=%2Ftest.png&w=1000&q=foo',
      `"q" parameter (quality) must be an integer between 1 and 100`,
    ],
    ['every parameter valid with the largest width', 'url=%2Ftest.png&w=3840&q=75', null],
  ])('matches Next.js for %s', (_name, query, expected) => {
    const result = validateImageParams(new URLSearchParams(query), config);
    expect('errorMessage' in result ? result.errorMessage : null).toBe(expected);
  });

  it.each<[string, string, string]>([
    [
      'a malformed percent sequence',
      'url=%2F%25E0%25A4%25A.png&w=64&q=75',
      `"url" parameter is invalid`,
    ],
    [
      'a backslash that changes the origin',
      'url=%2F%5Cevil.test%2Fa.png&w=64&q=75',
      `"url" parameter cannot be a protocol-relative URL (//)`,
    ],
    [
      'a tab that changes the origin',
      'url=%2F%09%2Fevil.test%2Fa.png&w=64&q=75',
      `"url" parameter cannot be a protocol-relative URL (//)`,
    ],
  ])('rejects %s without a server error', (_name, query, expected) => {
    expect(validateImageParams(new URLSearchParams(query), config)).toEqual({
      errorMessage: expected,
    });
  });

  it('returns the request parameters and normalizes absolute URLs', () => {
    expect(validateImageParams(new URLSearchParams('url=/a b.png&w=0064&q=075'), config)).toEqual({
      href: '/a b.png',
      isAbsolute: false,
      width: 64,
      quality: 75,
    });
    expect(
      validateImageParams(
        new URLSearchParams(
          `url=${encodeURIComponent('https://IMG.example.com/a b.png')}&w=64&q=75`,
        ),
        config,
      ),
    ).toEqual({
      href: 'https://img.example.com/a%20b.png',
      isAbsolute: true,
      width: 64,
      quality: 75,
    });
  });

  it('uses the configured endpoint path, local patterns, domains and allow-lists', () => {
    const custom = resolveImageConfig(
      {
        path: '/media/resize',
        localPatterns: [{ pathname: '/photos/**', search: '' }],
        domains: ['cdn.test'],
        deviceSizes: [500],
        imageSizes: [20],
        qualities: [50, 90],
      },
      { root: '/', dev: false },
    );
    const check = (query: string): string | null => {
      const result = validateImageParams(new URLSearchParams(query), custom);
      return 'errorMessage' in result ? result.errorMessage : null;
    };
    expect(check('url=/photos/a.png&w=500&q=90')).toBeNull();
    expect(check('url=/assets/a-1234.png&w=20&q=50')).toBeNull();
    expect(check('url=/other/a.png&w=500&q=90')).toBe('"url" parameter is not allowed');
    expect(check('url=/photos/media/resize/a.png&w=500&q=90')).toBe(
      '"url" parameter cannot be recursive',
    );
    expect(check('url=/photos/_void/image&w=500&q=90')).toBeNull();
    expect(check('url=http://cdn.test/a.png&w=500&q=90')).toBeNull();
    expect(check('url=http://cdn.test/a.png&w=640&q=90')).toBe(
      '"w" parameter (width) of 640 is not allowed',
    );
    expect(check('url=http://cdn.test/a.png&w=500&q=75')).toBe(
      '"q" parameter (quality) of 75 is not allowed',
    );
  });

  it('has no development allowance for blur-placeholder widths', () => {
    const dev = resolveImageConfig(undefined, { root: '/', dev: true });
    for (const query of ['url=/test.png&w=8&q=70', 'url=/test.png&w=3&q=70']) {
      expect(validateImageParams(new URLSearchParams(query), dev)).toMatchObject({
        errorMessage: expect.stringMatching(/^"w" parameter \(width\) of \d is not allowed$/),
      });
    }
    expect(validateImageParams(new URLSearchParams('url=/test.png&w=64&q=70'), dev)).toEqual({
      errorMessage: '"q" parameter (quality) of 70 is not allowed',
    });
  });
});

describe('getSupportedImageFormat', () => {
  const chrome = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
  it.each<[string, Array<'image/avif' | 'image/webp'>, string | null, string]>([
    ['no Accept header', ['image/webp'], null, ''],
    ['an empty Accept header', ['image/webp'], '', ''],
    ['wildcards only', ['image/webp'], '*/*', ''],
    ['an image wildcard', ['image/avif', 'image/webp'], 'image/*', ''],
    ['Firefox', ['image/webp'], 'image/webp,*/*', 'image/webp'],
    ['older Chrome', ['image/webp'], 'image/webp,image/apng,image/*,*/*;q=0.8', 'image/webp'],
    ['current Chrome with AVIF first', ['image/avif', 'image/webp'], chrome, 'image/avif'],
    ['current Chrome with WebP first', ['image/webp', 'image/avif'], chrome, 'image/webp'],
    ['current Chrome with WebP only', ['image/webp'], chrome, 'image/webp'],
    [
      'older Safari',
      ['image/avif', 'image/webp'],
      'image/png,image/svg+xml,image/*;q=0.8,video/*;q=0.8,*/*;q=0.5',
      '',
    ],
    [
      'a low AVIF weight',
      ['image/avif', 'image/webp'],
      'image/avif;q=0.5,image/webp',
      'image/avif',
    ],
    ['a zero AVIF weight', ['image/avif', 'image/webp'], 'image/avif;q=0,image/webp', 'image/webp'],
    ['a zero decimal weight', ['image/webp'], 'image/webp;q=0.000', ''],
    ['an uppercase type', ['image/avif', 'image/webp'], 'IMAGE/WEBP', 'image/webp'],
    ['media-type parameters', ['image/webp'], 'image/webp;level=1', 'image/webp'],
    ['a malformed weight', ['image/webp'], 'image/webp;q', ''],
    ['a non-numeric weight', ['image/webp'], 'image/webp;q=abc, image/avif', ''],
    [
      'whitespace around entries',
      ['image/webp'],
      ' text/html ,  image/webp ; q=0.9 ',
      'image/webp',
    ],
    ['an unconfigured format', ['image/webp'], 'image/avif', ''],
  ])('negotiates %s', (_name, formats, accept, expected) => {
    expect(getSupportedImageFormat(formats, accept, 640)).toBe(expected);
  });

  it("skips AVIF above Cloudflare's width limit and uses the next format", () => {
    const formats: Array<'image/avif' | 'image/webp'> = ['image/avif', 'image/webp'];
    expect(getSupportedImageFormat(formats, chrome, 1200)).toBe('image/avif');
    expect(getSupportedImageFormat(formats, chrome, 1920)).toBe('image/webp');
    expect(getSupportedImageFormat(['image/avif'], chrome, 1920)).toBe('');
  });
});

describe('detectContentType', () => {
  // Expected types were produced by Next.js 16.4.2's real `detectContentType`.
  it.each<[string, Uint8Array<ArrayBuffer>, string | null]>([
    ['an empty body', bytes(), null],
    [
      'SVG with leading whitespace',
      text('   \n<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'),
      'image/svg+xml',
    ],
    ['SVG after a comment', text('<!-- c --><svg width="1" height="1"></svg>'), 'image/svg+xml'],
    ['SVG after a doctype', text('<!DOCTYPE svg><svg viewBox="0 0 1 1"></svg>'), 'image/svg+xml'],
    ['any XML document', text('<?xml version="1.0"?><note/>'), 'image/svg+xml'],
    ['an uppercase SVG root', text('<SVG width="1"></SVG>'), null],
    ['HTML', text('<!doctype html><html><body>hi</body></html>'), null],
    ['plain text', text('hello world, this is text'), null],
    ['CSV', text('a,b,c\n1,2,3\n'), null],
    ['PDF', text('%PDF-1.7\n%...'), 'application/pdf'],
    ['BMP', latin1('BM\0\0\0\0'), 'image/bmp'],
    ['ICO', bytes(0, 0, 1, 0, 1, 0, 16, 16), 'image/x-icon'],
    ['CUR', bytes(0, 0, 2, 0, 1, 0, 16, 16), null],
    ['ICNS', latin1('icns\0\0\0\x08'), 'image/x-icns'],
    ['little-endian TIFF', bytes(0x49, 0x49, 0x2a, 0, 8, 0, 0, 0), 'image/tiff'],
    ['big-endian TIFF', bytes(0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8), 'image/tiff'],
    ['a JPEG XL codestream', bytes(0xff, 0x0a, 0, 0), 'image/jxl'],
    [
      'a JPEG XL container',
      bytes(0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a),
      'image/jxl',
    ],
    [
      'JPEG 2000',
      bytes(0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a),
      'image/jp2',
    ],
    ['HEIC', ftyp('heic'), 'image/heic'],
    ['HEIF (mif1)', ftyp('mif1'), null],
    ['AVIF', ftyp('avif'), 'image/avif'],
    ['animated AVIF (avis)', ftyp('avis'), null],
    ['PSD', latin1('8BPS\0\x01'), null],
    ['PPM', latin1('P6\n1 1\n255\n\0\0\0'), null],
    ['PAM', latin1('P7\nWIDTH 1\n'), null],
    ['DDS', latin1('DDS \x7c\0\0\0'), null],
    ['KTX', latin1('\xabKTX 11\xbb\r\n\x1a\n'), null],
    ['J2C', bytes(0xff, 0x4f, 0xff, 0x51, 0, 0), null],
    ['a TGA-like zero header', bytes(0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0), null],
    ['a JPEG signature', bytes(0xff, 0xd8, 0xff, 0xe0), 'image/jpeg'],
    ['a truncated JPEG signature', bytes(0xff, 0xd8, 0, 0), 'image/jpeg'],
    ['a PNG signature', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'image/png'],
    ['a GIF signature', text('GIF89a'), 'image/gif'],
    ['a RIFF WAVE file', latin1('RIFF\0\0\0\0WAVEfmt '), null],
    ['random bytes', bytes(0x13, 0x37, 0xde, 0xad, 0xbe, 0xef, 0x01, 0x02), null],
  ])('detects %s like Next.js', (_name, input, expected) => {
    expect(detectContentType(input)).toBe(expected);
  });

  it.each([
    ['test.png', 'image/png'],
    ['test.jpg', 'image/jpeg'],
    ['test.webp', 'image/webp'],
    ['test.avif', 'image/avif'],
    ['test.gif', 'image/gif'],
    ['test.tiff', 'image/tiff'],
  ])('detects the %s fixture', (file, expected) => {
    expect(detectContentType(fixture(file))).toBe(expected);
  });

  it('only inspects the start of large bodies', () => {
    const whitespace = new Uint8Array(5_000_000).fill(0x20);
    const started = performance.now();
    expect(detectContentType(whitespace)).toBeNull();
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe('isAnimated', () => {
  it.each([
    ['animated.gif', true],
    ['animated.png', true],
    ['animated.webp', true],
    ['test.gif', false],
    ['test.png', false],
    ['test.webp', false],
    ['test.jpg', false],
  ])('classifies %s', (file, expected) => {
    expect(isAnimated(fixture(file))).toBe(expected);
  });

  it('requires APNG frame data after the default image', () => {
    const apng = fixture('animated.png');
    const text = String.fromCharCode(...apng);
    // Renaming the fdAT chunk leaves an acTL without frames.
    const withoutFrames = apng.slice();
    withoutFrames.set(latin1('xxxx'), text.indexOf('fdAT'));
    expect(isAnimated(withoutFrames)).toBe(false);
    // A truncated chunk header ends the scan instead of throwing.
    expect(isAnimated(apng.slice(0, text.indexOf('fdAT') + 2))).toBe(false);
  });
});

describe('getMaxAge', () => {
  // Next.js `get-max-age.test.ts`.
  it.each<[string | null | undefined, number]>([
    [undefined, 0],
    [null, 0],
    ['', 0],
    ['max-age=foo', 0],
    ['no-cache', 0],
    ['max-age=9999', 9999],
    ['MAX-AGE=9999', 9999],
    ['s-maxage=9999', 9999],
    ['S-MAXAGE=9999', 9999],
    ['public, max-age=5555, s-maxage=9999', 9999],
    ['public,s-maxage=9999,max-age=5555', 9999],
    ['public, s-maxage="9999", max-age="5555"', 9999],
    ['private, no-store, max-age=60', 60],
  ])('reads %j as %d seconds', (header, expected) => {
    expect(getMaxAge(header)).toBe(expected);
  });
});

describe('ETags', () => {
  it('encodes upstream tags and hashes bodies without one (Next.js extract-etag.test.ts)', async () => {
    expect(await extractEtag('sample-etag', bytes())).toBe('c2FtcGxlLWV0YWc');
    expect(await extractEtag('W/"sample-etag"', bytes())).toBe('Vy8ic2FtcGxlLWV0YWci');
    const image = fixture('test.jpg');
    const hash = await getImageEtag(image);
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const missing of [null, undefined, '']) {
      expect(await extractEtag(missing, image)).toBe(hash);
    }
    expect(await getImageEtag(text('abc'))).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  });

  it.each<[string, Record<string, string>, boolean]>([
    ['no conditional headers', {}, false],
    ['a quoted match', { 'if-none-match': '"abc"' }, true],
    ['an unquoted match', { 'if-none-match': 'abc' }, true],
    ['a weak match', { 'if-none-match': 'W/"abc"' }, true],
    ['a match in a list', { 'if-none-match': '"x", "abc"' }, true],
    ['a wildcard', { 'if-none-match': '*' }, true],
    ['a different tag', { 'if-none-match': '"abcd"' }, false],
    ['no-cache', { 'if-none-match': '"abc"', 'cache-control': 'no-cache' }, false],
    [
      'If-Modified-Since without Last-Modified',
      { 'if-modified-since': new Date().toUTCString() },
      false,
    ],
    [
      'a match with If-Modified-Since',
      { 'if-none-match': '"abc"', 'if-modified-since': new Date().toUTCString() },
      false,
    ],
  ])('treats %s as fresh=%s', (_name, headers, expected) => {
    expect(isFreshRequest(new Headers(headers), 'abc')).toBe(expected);
  });
});

describe('Content-Disposition', () => {
  it.each([
    ['/test.png', 'image/webp', 'test.webp'],
    ['/my.photo.png', 'image/webp', 'my.webp'],
    ['/png-as-octet-stream', 'image/webp', 'png-as-octet-stream.webp'],
    ['/a/b/test.jpg?v=1', 'image/jpeg', 'test.jpeg'],
    ['https://example.com/', 'image/png', 'image.bin'],
    ['https://example.com/x/icon.ico', 'image/x-icon', 'icon.ico'],
    ['/vector.svg', 'image/svg+xml', 'vector.svg'],
    ['/image.avif', 'image/avif', 'image.avif'],
  ])('names %s served as %s %s', (url, type, expected) => {
    expect(getFileNameWithExtension(url, type)).toBe(expected);
  });

  // Expected headers were produced by the `content-disposition` package Next.js bundles.
  it.each<[string, 'attachment' | 'inline', string]>([
    ['test.webp', 'attachment', 'attachment; filename="test.webp"'],
    ['test.webp', 'inline', 'inline; filename="test.webp"'],
    [
      'äöüščří.webp',
      'attachment',
      `attachment; filename="äöü???í.webp"; filename*=UTF-8''%C3%A4%C3%B6%C3%BC%C5%A1%C4%8D%C5%99%C3%AD.webp`,
    ],
    ['a"b.webp', 'attachment', 'attachment; filename="a\\"b.webp"'],
    ['a\\b.webp', 'inline', 'inline; filename="a\\\\b.webp"'],
    [
      'a%20b.webp',
      'attachment',
      `attachment; filename="a%20b.webp"; filename*=UTF-8''a%2520b.webp`,
    ],
    [
      '日本.webp',
      'attachment',
      `attachment; filename="??.webp"; filename*=UTF-8''%E6%97%A5%E6%9C%AC.webp`,
    ],
    ['tëst.webp', 'attachment', 'attachment; filename="tëst.webp"'],
    ["it's (1).webp", 'inline', `inline; filename="it's (1).webp"`],
    [
      'tab\there.webp',
      'attachment',
      `attachment; filename="tab?here.webp"; filename*=UTF-8''tab%09here.webp`,
    ],
    [
      'emoji😀.png',
      'attachment',
      `attachment; filename="emoji??.png"; filename*=UTF-8''emoji%F0%9F%98%80.png`,
    ],
  ])('formats %s as %s', (name, type, expected) => {
    expect(getContentDisposition(name, type)).toBe(expected);
  });
});

describe('isPrivateIpLiteral', () => {
  // Hosts are WHATWG-normalized URL hostnames. Expected values match Next.js
  // 16.4.2's `isPrivateIp`, except the IPv4-compatible `::7f00:1`, which Void
  // classifies by its embedded IPv4 address.
  it.each<[string, boolean]>([
    ['http://127.0.0.1/', true],
    ['http://127.1/', true],
    ['http://2130706433/', true],
    ['http://0x7f.0.0.1/', true],
    ['http://10.0.0.1/', true],
    ['http://172.16.0.1/', true],
    ['http://172.32.0.1/', false],
    ['http://192.168.1.1/', true],
    ['http://169.254.169.254/', true],
    ['http://100.64.0.1/', true],
    ['http://100.128.0.1/', false],
    ['http://0.0.0.0/', true],
    ['http://255.255.255.255/', true],
    ['http://224.0.0.1/', true],
    ['http://198.18.0.1/', true],
    ['http://192.0.2.1/', true],
    ['http://203.0.113.9/', true],
    ['http://240.0.0.1/', true],
    ['http://192.88.99.1/', true],
    ['http://8.8.8.8/', false],
    ['http://1.1.1.1/', false],
    ['http://[::1]/', true],
    ['http://[::]/', true],
    ['http://[fe80::1]/', true],
    ['http://[fc00::1]/', true],
    ['http://[fd12:3456::1]/', true],
    ['http://[ff02::1]/', true],
    ['http://[::ffff:127.0.0.1]/', true],
    ['http://[::ffff:8.8.8.8]/', false],
    ['http://[::ffff:10.0.0.1]/', true],
    ['http://[64:ff9b::7f00:1]/', true],
    ['http://[2001:db8::1]/', true],
    ['http://[2002:7f00:1::]/', true],
    ['http://[2001::1]/', true],
    ['http://[100::1]/', true],
    ['http://[2606:4700:4700::1111]/', false],
    ['http://[2001:4860:4860::8888]/', false],
    ['http://[::7f00:1]/', true],
    ['http://localhost/', true],
    ['http://LOCALHOST./', true],
    ['http://app.localhost:5173/', true],
    ['http://example.com/', false],
    ['http://notlocalhost/', false],
    ['http://localhost.example.com/', false],
  ])('classifies %s as private=%s', (url, expected) => {
    expect(isPrivateIpLiteral(new URL(url).hostname)).toBe(expected);
  });

  it('accepts dotted IPv4 tails from direct callers', () => {
    expect(isPrivateIpLiteral('[::ffff:127.0.0.1]')).toBe(true);
    expect(isPrivateIpLiteral('[::ffff:8.8.8.8]')).toBe(false);
    expect(isPrivateIpLiteral('[not-an-ip]')).toBe(false);
  });
});
