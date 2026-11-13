import type { Node, ReactElementLike } from 'takumi-js';
import { describe, expectTypeOf, it } from 'vite-plus/test';
import { html, raw, type HtmlEscapedString } from '../../src/runtime/html.ts';
import { ImageResponse, type ImageInput } from '../../src/runtime/image.ts';
import { OgImageResponse } from '../../src/runtime/og.ts';

type ImageResponseInput = ConstructorParameters<typeof ImageResponse>[0];
type OgImageResponseInput = ConstructorParameters<typeof OgImageResponse>[0];

describe('image response input types', () => {
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

  it('accepts JSX elements and Takumi nodes', () => {
    expectTypeOf<ReactElementLike>().toExtend<ImageInput>();
    expectTypeOf<Node>().toExtend<ImageInput>();
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
