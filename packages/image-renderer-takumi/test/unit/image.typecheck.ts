import { jsx, type JSXNode } from 'hono/jsx';
import { describe, expectTypeOf, it } from 'vite-plus/test';
import { html, raw, type HtmlEscapedString } from 'void/html';
import {
  ImageResponse,
  OgImageResponse,
  renderImage,
  renderOgImage,
  type BrowserRunFontData,
  type DefaultImageRenderer,
  type ImageFont,
  type ImageInput,
  type RenderImageOptions,
  type RenderOgImageOptions,
  type OgImageResponseOptions,
} from 'void/image';
import {
  takumiRenderer,
  type TakumiRendererFontData,
  type TakumiRendererOptions,
} from '../../src/index.ts';

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

  it('accepts Hono JSX but not React-shaped or raw image nodes', () => {
    expectTypeOf(jsx('div', null, 'Hello')).toExtend<ImageInput>();
    expectTypeOf<ImageInput>().toEqualTypeOf<
      JSXNode | HtmlEscapedString | Promise<HtmlEscapedString>
    >();
    expectTypeOf<{ type: 'div'; props: { children: string } }>().not.toExtend<ImageInput>();
    expectTypeOf<{ type: 'text'; text: string }>().not.toExtend<ImageInput>();
  });

  it('derives font families, font data and tuple options from the renderer', () => {
    type BrowserOptions = RenderImageOptions<DefaultImageRenderer, 'Brand'>;
    type TakumiOptions = RenderImageOptions<typeof takumiRenderer, 'Brand'>;
    expectTypeOf<NonNullable<BrowserOptions['fonts']>[number]>().toEqualTypeOf<
      ImageFont<'Brand', BrowserRunFontData>
    >();
    expectTypeOf<NonNullable<TakumiOptions['fonts']>[number]>().toEqualTypeOf<
      ImageFont<'Brand', TakumiRendererFontData>
    >();
    type Font = 'Brand' | 'Roboto' | 'Geist';
    type FontStack = Font | Array<Font>;
    expectTypeOf<NonNullable<TakumiOptions['font']>>().toExtend<FontStack>();
    expectTypeOf<FontStack>().toExtend<NonNullable<TakumiOptions['font']>>();
    expectTypeOf<NonNullable<TakumiOptions['renderer']>>().toEqualTypeOf<
      typeof takumiRenderer | [typeof takumiRenderer, TakumiRendererOptions]
    >();
  });

  it('infers built-in and declared families at each public entry point', () => {
    const input = html`<div>Hello</div>`;
    const size = { width: 32, height: 32 };
    const fonts = [{ name: 'Brand' as const, data: new Uint8Array() }];

    void renderImage(input, { ...size, font: ['Arial', 'Noto Sans CJK JP', 'serif'] });
    void renderOgImage(input, { fonts, font: ['Brand', 'DejaVu Sans Mono'] });
    new ImageResponse(input, { ...size, fonts, font: ['Brand', 'Webdings'] });
    new OgImageResponse(input, { font: ['FreeMono', 'Noto Color Emoji'] });
    // @ts-expect-error A missing renderer means Browser Run, not Takumi.
    void renderImage(input, { ...size, font: 'Geist' });
    // @ts-expect-error Only built-in and declared custom families are accepted.
    void renderOgImage(input, { fonts, font: ['Brand', 'Random Font'] });
    // @ts-expect-error Brand is not declared on this call.
    new ImageResponse(input, { ...size, font: 'Brand' });
    // @ts-expect-error Unknown families are rejected even with custom faces.
    new OgImageResponse(input, { fonts, font: 'Random Font' });

    void renderImage(input, { ...size, renderer: takumiRenderer, font: ['Roboto', 'Geist'] });
    void renderOgImage(input, { renderer: takumiRenderer, fonts, font: ['Brand', 'Roboto'] });
    new ImageResponse(input, {
      ...size,
      renderer: takumiRenderer,
      fonts,
      font: ['Brand', 'Geist'],
    });
    new OgImageResponse(input, {
      renderer: [takumiRenderer, { fallbackFonts: false }],
      font: 'Roboto',
    });
    // @ts-expect-error Arial is not built into Takumi.
    void renderImage(input, { ...size, renderer: takumiRenderer, font: 'Arial' });
    // @ts-expect-error Unknown families are rejected even with custom faces.
    void renderOgImage(input, { renderer: takumiRenderer, fonts, font: ['Brand', 'Random Font'] });
    // @ts-expect-error Brand is not declared on this call.
    new ImageResponse(input, { ...size, renderer: takumiRenderer, font: 'Brand' });
    // @ts-expect-error Renderer tuple options must not widen the font family.
    new OgImageResponse(input, { renderer: [takumiRenderer, {}], font: 'Random Font' });
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
