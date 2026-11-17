import type { Properties } from 'csstype';
import type { HtmlEscapedString } from 'void/html';

/** A font file's URL, or a font's bytes with its name, weight and style. */
export type ImageFont =
  | string
  | {
      name: string;
      data: ArrayBuffer | Uint8Array;
      /**
       * The weight the font draws, from 1 to 1000. Leave it out for a variable
       * font, so each element's `fontWeight` sets the weight; with it, the font
       * draws only this weight.
       */
      weight?: number;
      style?: 'normal' | 'italic';
      /**
       * Accepted and ignored: text uses the first font that has the glyph. The
       * `lang` option, or attribute on the root element, chooses the font for
       * Chinese characters instead.
       */
      lang?: string;
    };

/** CSS declarations for image nodes, with numeric lengths expressed in pixels. */
export interface ImageStyle extends Properties<string | number> {
  [property: `--${string}`]: string | number | undefined;
  /** Fits text to its available space. */
  textFit?:
    | 'none'
    | 'grow'
    | 'shrink'
    | 'consistent'
    | 'per-line'
    | 'per-line-all'
    | `${number}%`
    | (string & {});
}

/** Raw row-major RGBA pixels, without an encoded image file. */
export interface ImageRgbaData {
  width: number;
  height: number;
  /** RGBA bytes, `width * height * 4` long. */
  data: Uint8Array | ArrayBuffer;
  /** Whether the color channels are already multiplied by alpha. */
  premultiplied?: boolean;
}

interface ImageNodeMetadata {
  tagName?: string;
  className?: string;
  id?: string;
  dir?: 'ltr' | 'rtl';
  lang?: string;
  attributes?: Record<string, string>;
  /** Tailwind classes. */
  tw?: string;
  style?: ImageStyle;
  preset?: ImageStyle;
}

/** A tree of containers, text, and images, independent of a UI framework. */
export type ImageNode = ImageNodeMetadata &
  (
    | { type: 'container'; children?: Array<ImageNode> }
    | { type: 'text'; text: string }
    | {
        type: 'image';
        src: string | Uint8Array | ArrayBuffer | ImageRgbaData;
        width?: number;
        height?: number;
      }
  );

/** A JSX element from a React-shaped runtime, including function and class components. */
export interface ImageJsxElement {
  type:
    | string
    | symbol
    | ((props: never) => unknown)
    | (new (props: never) => unknown)
    | ImageJsxElement;
  props: unknown;
  $$typeof?: symbol | string;
}

/** JSX, an image node tree, or an escaped HTML template from `void/html`. */
export type ImageInput =
  | ImageJsxElement
  | ImageNode
  | HtmlEscapedString
  | Promise<HtmlEscapedString>;
