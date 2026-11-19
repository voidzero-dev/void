import type { JSXNode } from 'hono/jsx';
import type { HtmlEscapedString } from '../../html.ts';
import type { browserRunRenderer } from './browser-run/index.ts';

/** Encoded font-file bytes. */
export type ImageFontBytes = ArrayBuffer | Uint8Array;

/** A remote font file. */
export interface ImageFontUrl {
  url: string;
}

/** A named font face with a source supported by the selected renderer. */
export interface ImageFont<FontFamily extends string, RendererFontData> {
  name: FontFamily;
  /**
   * The weight the font draws, from 1 to 1000. Leave it out for a variable
   * font, so each element's `fontWeight` sets the weight; with it, the font
   * draws only this weight.
   */
  weight?: number;
  style?: 'normal' | 'italic';
  /**
   * Accepted for compatibility. Set the render's `lang` or the root element's
   * `lang` attribute to choose how Chinese characters are drawn.
   */
  lang?: string;
  data: RendererFontData;
}

/** Hono JSX or an escaped HTML template from `void/html`. */
export type ImageInput = JSXNode | HtmlEscapedString | Promise<HtmlEscapedString>;

// The constraint accepts renderer callables without widening their settings.
export type AnyImageRenderer = ImageRenderer<never, never, never>;
export type DefaultImageRenderer = typeof browserRunRenderer;

type RendererSettings<Renderer extends AnyImageRenderer> =
  Renderer extends ImageRenderer<infer DefaultFontFamily, infer FontData, infer Options>
    ? { defaultFontFamily: DefaultFontFamily; fontData: FontData; options: Options }
    : never;

/** Selects a renderer, optionally with its own options. */
export type ImageRendererOption<Renderer extends AnyImageRenderer> =
  | Renderer
  | [Renderer, NoInfer<RendererSettings<Renderer>['options']>];

/** Rendering options, without HTTP response options. */
export interface RenderImageOptions<
  Renderer extends AnyImageRenderer = DefaultImageRenderer,
  FontFamily extends string = never,
> extends ImageRenderSettings<
  RendererSettings<Renderer>['defaultFontFamily'],
  FontFamily,
  RendererSettings<Renderer>['fontData']
> {
  /** Defaults to Cloudflare Browser Run using the BROWSER binding. */
  renderer?: ImageRendererOption<Renderer>;
}

interface ImageRenderSettings<
  RendererDefaultFontFamily extends string,
  FontFamily extends string,
  RendererFontData,
> {
  /* Image width. */
  width: number;
  /* Image height. */
  height: number;
  /** Language of the text, such as `ja` or `zh-TW`. */
  lang?: string;
  /** Draws a border around every box. */
  debug?: boolean;
  /** Default font family or ordered fallback stack. */
  font?: NoInfer<
    RendererDefaultFontFamily | FontFamily | Array<RendererDefaultFontFamily | FontFamily>
  >;
  /** Custom font faces. Browser Run requires a name with an HTTPS file URL or bytes. */
  fonts?: Array<ImageFont<FontFamily, RendererFontData>>;
}

/** Takes the original image input and returns encoded PNG bytes. */
export type ImageRenderer<
  RendererDefaultFontFamily extends string,
  RendererFontData,
  RendererOptions = undefined,
> = <FontFamily extends string>(
  element: ImageInput,
  options: ImageRenderSettings<RendererDefaultFontFamily, FontFamily, RendererFontData> &
    (RendererOptions extends {} ? RendererOptions : {}),
) => Promise<Uint8Array<ArrayBuffer>>;
