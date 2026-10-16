import { describe, expect, it } from 'vite-plus/test';
import { resolveImageProps, styleToString } from 'void/image';
import {
  getImageProps,
  toImageCoreProps,
  toImageElementAttributes,
  toImageStyle,
  type ImageProps,
} from '../../src/runtime/image-props.ts';

const A_SRCSET = '/_void/image?url=%2Fa.png&w=128&q=75 1x, /_void/image?url=%2Fa.png&w=256&q=75 2x';
const A_SRC = '/_void/image?url=%2Fa.png&w=256&q=75';

describe('toImageStyle', () => {
  it('reads kebab-case and camelCase objects as camelCase', () => {
    expect(
      toImageStyle({
        'object-fit': 'cover',
        'object-position': 'top',
        '-webkit-line-clamp': 2,
        '-ms-transform': 'none',
        '--accent': 'red',
        zIndex: 2,
        opacity: undefined,
      }),
    ).toStrictEqual({
      objectFit: 'cover',
      objectPosition: 'top',
      WebkitLineClamp: 2,
      msTransform: 'none',
      '--accent': 'red',
      zIndex: 2,
    });
  });

  it('parses CSS strings', () => {
    const style = toImageStyle(
      'object-fit: cover; background: url("a;b.png") no-repeat; /* note */ --accent: red;',
    );

    expect(style).toStrictEqual({
      objectFit: 'cover',
      background: 'url("a;b.png") no-repeat',
      '--accent': 'red',
    });
    expect(styleToString(style ?? {})).toBe(
      'object-fit:cover;background:url("a;b.png") no-repeat;--accent:red',
    );
  });

  it.each(['', ' ; ', undefined, null, false])('returns undefined for %j', (value) => {
    expect(toImageStyle(value)).toBeUndefined();
  });
});

describe('toImageCoreProps', () => {
  it('maps Solid attribute names onto next/image props', () => {
    const onClick = () => {};
    expect(
      toImageCoreProps({
        src: '/a.png',
        alt: 'A',
        class: 'one',
        className: 'two',
        fetchpriority: 'high',
        style: 'object-fit: contain',
        srcset: '/ignored.png 1x',
        srcSet: '/ignored.png 2x',
        ref: () => {},
        onload: () => {},
        onClick,
        id: undefined,
      }),
    ).toStrictEqual({
      src: '/a.png',
      alt: 'A',
      style: { objectFit: 'contain' },
      onClick,
      className: 'one two',
      fetchPriority: 'high',
    });
  });

  it('prefers fetchPriority over fetchpriority', () => {
    expect(toImageCoreProps({ fetchpriority: 'high', fetchPriority: 'low' }).fetchPriority).toBe(
      'low',
    );
  });
});

describe('toImageElementAttributes', () => {
  it('renders next/image attribute order with HTML names and src last', () => {
    const onClick = () => {};
    const classList = { active: true };
    const attributes = toImageElementAttributes(
      resolveImageProps(
        toImageCoreProps({
          src: '/a.png',
          alt: 'A',
          width: 100,
          height: 100,
          id: 'avatar',
          classList,
          onClick,
          class: 'rounded',
          fetchpriority: 'low',
          crossorigin: 'anonymous',
        }),
      ),
    );

    expect(Object.keys(attributes)).toEqual([
      'alt',
      'id',
      'classList',
      'onClick',
      'crossorigin',
      'fetchpriority',
      'loading',
      'width',
      'height',
      'decoding',
      'data-nimg',
      'class',
      'style',
      'srcset',
      'src',
    ]);
    expect(attributes).toMatchObject({
      classList,
      onClick,
      fetchpriority: 'low',
      loading: 'lazy',
      'data-nimg': '1',
      class: 'rounded',
      style: 'color:transparent',
      srcset: A_SRCSET,
      src: A_SRC,
    });
  });

  it('marks fill images and turns the placeholder into a CSS string', () => {
    const attributes = toImageElementAttributes(
      resolveImageProps(
        toImageCoreProps({
          src: '/a.png',
          alt: 'A',
          fill: true,
          placeholder: 'data:image/png;base64,AA',
          style: { 'object-fit': 'contain' },
        }),
      ),
    );

    expect(attributes['data-nimg']).toBe('fill');
    expect(attributes.style).toBe(
      'position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;object-fit:contain;color:transparent;background-size:contain;background-position:50% 50%;background-repeat:no-repeat;background-image:url("data:image/png;base64,AA")',
    );
  });

  it('drops the placeholder after loading and the transparent color after an error', () => {
    const props = toImageCoreProps({
      src: '/a.png',
      alt: 'A',
      width: 100,
      height: 100,
      placeholder: 'data:image/png;base64,AA',
    });

    expect(toImageElementAttributes(resolveImageProps(props, { blurComplete: true })).style).toBe(
      'color:transparent',
    );
    expect(
      toImageElementAttributes(resolveImageProps(props, { blurComplete: true, showAltText: true }))
        .style,
    ).toBeUndefined();
  });
});

// Expected values: next@16.4.2 `getImageProps()` (packages/void/test/unit/image-props.golden.ts)
// with Solid's attribute names and a CSS string style.
describe('getImageProps', () => {
  it('returns HTML attributes in getImgProps order without undefined values', () => {
    const { props } = getImageProps({ src: '/a.png', alt: 'A', width: 100, height: 100 });

    expect(Object.entries(props)).toEqual([
      ['alt', 'A'],
      ['loading', 'lazy'],
      ['width', 100],
      ['height', 100],
      ['decoding', 'async'],
      ['style', 'color:transparent'],
      ['srcset', A_SRCSET],
      ['src', A_SRC],
    ]);
  });

  it('maps class, fill styles and sizes', () => {
    const { props } = getImageProps({
      src: '/a.png',
      alt: 'A',
      fill: true,
      sizes: '50vw',
      class: 'c',
    });

    expect(props).toStrictEqual({
      alt: 'A',
      loading: 'lazy',
      decoding: 'async',
      class: 'c',
      style:
        'position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;color:transparent',
      sizes: '50vw',
      srcset:
        '/_void/image?url=%2Fa.png&w=384&q=75 384w, /_void/image?url=%2Fa.png&w=640&q=75 640w, /_void/image?url=%2Fa.png&w=750&q=75 750w, /_void/image?url=%2Fa.png&w=828&q=75 828w, /_void/image?url=%2Fa.png&w=1080&q=75 1080w, /_void/image?url=%2Fa.png&w=1200&q=75 1200w, /_void/image?url=%2Fa.png&w=1920&q=75 1920w, /_void/image?url=%2Fa.png&w=2048&q=75 2048w, /_void/image?url=%2Fa.png&w=3840&q=75 3840w',
      src: '/_void/image?url=%2Fa.png&w=3840&q=75',
    });
  });

  it('keeps fetchpriority for preloaded images and drops lazy loading', () => {
    const props: ImageProps = {
      src: '/a.png',
      alt: 'A',
      width: 100,
      height: 50,
      preload: true,
      fetchpriority: 'high',
    };

    expect(getImageProps(props).props).toStrictEqual({
      alt: 'A',
      fetchpriority: 'high',
      width: 100,
      height: 50,
      decoding: 'async',
      style: 'color:transparent',
      srcset: A_SRCSET,
      src: A_SRC,
    });
  });

  it('serves unoptimized images unchanged', () => {
    expect(
      getImageProps({ src: '/a.png', alt: 'A', width: 100, height: 50, unoptimized: true }).props,
    ).toStrictEqual({
      alt: 'A',
      loading: 'lazy',
      width: 100,
      height: 50,
      decoding: 'async',
      style: 'color:transparent',
      src: '/a.png',
    });
  });
});
