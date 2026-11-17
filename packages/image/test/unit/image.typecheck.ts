import { describe, expectTypeOf, it } from 'vite-plus/test';
import { html, raw, type HtmlEscapedString } from 'void/html';
import {
  ImageResponse,
  OgImageResponse,
  renderImage,
  renderOgImage,
  type ImageFont,
  type ImageInput,
  type ImageJsxElement,
  type ImageNode,
  type ImageRgbaData,
  type ImageStyle,
  type RenderImageOptions,
  type RenderOgImageOptions,
  type OgImageResponseOptions,
} from '../../src/generate/index.ts';

type ImageResponseInput = ConstructorParameters<typeof ImageResponse>[0];
type OgImageResponseInput = ConstructorParameters<typeof OgImageResponse>[0];

describe('image response input types', () => {
  it('exposes awaitable PNG bytes with rendering-only options', () => {
    expectTypeOf<Parameters<typeof renderImage>[0]>().toEqualTypeOf<ImageInput>();
    expectTypeOf<Parameters<typeof renderOgImage>[0]>().toEqualTypeOf<ImageInput>();
    expectTypeOf<ReturnType<typeof renderImage>>().toEqualTypeOf<
      Promise<Uint8Array<ArrayBuffer>>
    >();
    expectTypeOf<ReturnType<typeof renderOgImage>>().toEqualTypeOf<
      Promise<Uint8Array<ArrayBuffer>>
    >();
    expectTypeOf<'headers'>().not.toExtend<keyof RenderImageOptions>();
    expectTypeOf<'headers'>().not.toExtend<keyof RenderOgImageOptions>();
    expectTypeOf<'headers'>().toExtend<keyof OgImageResponseOptions>();
  });

  it('uses ImageInput for both constructors', () => {
    expectTypeOf<ImageResponseInput>().toEqualTypeOf<ImageInput>();
    expectTypeOf<OgImageResponseInput>().toEqualTypeOf<ImageInput>();
  });

  it('accepts escaped templates, asynchronous templates, and trusted raw markup', () => {
    expectTypeOf(html`<div>${'Hello'}</div>`).toExtend<ImageInput>();
    expectTypeOf(html`<div>${Promise.resolve('Hello')}</div>`).toExtend<ImageInput>();
    expectTypeOf(raw('<div>Hello</div>')).toExtend<ImageInput>();
    expectTypeOf<HtmlEscapedString>().toExtend<ImageInput>();
    expectTypeOf<Promise<HtmlEscapedString>>().toExtend<ImageInput>();
  });

  it('accepts JSX elements without importing a UI framework', () => {
    expectTypeOf<ImageJsxElement>().toExtend<ImageInput>();
    expectTypeOf<{ type: 'div'; props: { children: string } }>().toExtend<ImageJsxElement>();
    expectTypeOf<{
      type: (props: { title: string }) => ImageJsxElement;
      props: { title: string };
    }>().toExtend<ImageJsxElement>();
    expectTypeOf<{
      type: new (props: { title: string }) => { render(): ImageJsxElement };
      props: { title: string };
    }>().toExtend<ImageJsxElement>();
    expectTypeOf<{
      type: symbol;
      props: { children: Array<ImageJsxElement> };
    }>().toExtend<ImageJsxElement>();
    expectTypeOf<{ type: ImageJsxElement; props: unknown }>().toExtend<ImageJsxElement>();
  });

  it('accepts recursive nodes and each image source', () => {
    expectTypeOf<ImageNode>().toExtend<ImageInput>();
    expectTypeOf<{ type: 'container'; children: Array<ImageNode> }>().toExtend<ImageNode>();
    expectTypeOf<{ type: 'text'; text: string; lang: 'ja'; dir: 'rtl' }>().toExtend<ImageNode>();
    for (const src of [
      'https://example.com/logo.png',
      new Uint8Array(4),
      new ArrayBuffer(4),
      { width: 1, height: 1, data: new Uint8Array(4), premultiplied: true } satisfies ImageRgbaData,
    ]) {
      expectTypeOf({ type: 'image', src, width: 1, height: 1 } as const).toExtend<ImageNode>();
    }
    expectTypeOf<{ type: 'text' }>().not.toExtend<ImageNode>();
    expectTypeOf<{ type: 'image'; src: number }>().not.toExtend<ImageNode>();
    expectTypeOf<{ type: 'container'; children: Array<string> }>().not.toExtend<ImageNode>();
    expectTypeOf<{ type: 'video'; src: string }>().not.toExtend<ImageInput>();
  });

  it('owns styles and font descriptors', () => {
    const style = {
      display: 'flex',
      fontSize: 24,
      fontWeight: 900,
      width: '100%',
      '--accent': '#f00',
      textFit: 'shrink per-line 90%',
    } satisfies ImageStyle;
    expectTypeOf(style).toExtend<ImageStyle>();
    expectTypeOf<{ color: number }>().not.toExtend<ImageStyle>();
    expectTypeOf<NonNullable<RenderImageOptions['fonts']>[number]>().toEqualTypeOf<ImageFont>();
  });

  it('rejects plain, promised, and boxed strings for ImageResponse', () => {
    expectTypeOf<'<div>Hello</div>'>().not.toExtend<ImageResponseInput>();
    expectTypeOf<string>().not.toExtend<ImageResponseInput>();
    expectTypeOf<Promise<string>>().not.toExtend<ImageResponseInput>();
    expectTypeOf(new String('Hello')).not.toExtend<ImageResponseInput>();
  });

  it('rejects plain, promised, and boxed strings for OgImageResponse', () => {
    expectTypeOf<'<div>Hello</div>'>().not.toExtend<OgImageResponseInput>();
    expectTypeOf<string>().not.toExtend<OgImageResponseInput>();
    expectTypeOf<Promise<string>>().not.toExtend<OgImageResponseInput>();
    expectTypeOf(new String('Hello')).not.toExtend<OgImageResponseInput>();
  });
});
