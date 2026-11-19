import type { BrowserRunFontData } from './browser-run/fonts.ts';
import type {
  AnyImageRenderer,
  DefaultImageRenderer,
  ImageFont,
  ImageInput,
  RenderImageOptions,
} from './types.ts';

/** Renders Hono JSX or an escaped HTML template to PNG bytes. */
export async function renderImage<
  Renderer extends AnyImageRenderer = DefaultImageRenderer,
  FontFamily extends string = never,
>(
  element: ImageInput,
  options: RenderImageOptions<Renderer, FontFamily>,
): Promise<Uint8Array<ArrayBuffer>> {
  const { renderer: selection, ...renderOptions } = options;
  if (!selection) {
    const { browserRunRenderer } = await import('./browser-run/index.ts');
    return browserRunRenderer(element, {
      ...renderOptions,
      fonts: renderOptions.fonts as Array<ImageFont<string, BrowserRunFontData>> | undefined,
    });
  }
  const [renderer, rendererOptions] =
    typeof selection === 'function' ? ([selection, undefined] as const) : selection;
  // The callable signature sees the renderer-specific options flattened alongside
  // the shared options, whether they were supplied in a tuple or omitted.
  const invoke = renderer as unknown as (
    input: ImageInput,
    settings: typeof renderOptions,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  return invoke(element, Object.assign({}, rendererOptions, renderOptions));
}

/** Open Graph rendering options, with default dimensions of 1200 × 630. */
export interface RenderOgImageOptions<
  Renderer extends AnyImageRenderer = DefaultImageRenderer,
  FontFamily extends string = never,
> extends Omit<RenderImageOptions<Renderer, FontFamily>, 'width' | 'height'> {
  /** Image width in pixels. Defaults to 1200. */
  width?: number;
  /** Image height in pixels. Defaults to 630. */
  height?: number;
}

/** Renders PNG bytes at 1200 × 630 by default, or with custom dimensions. */
export async function renderOgImage<
  Renderer extends AnyImageRenderer = DefaultImageRenderer,
  FontFamily extends string = never,
>(
  element: ImageInput,
  options: RenderOgImageOptions<Renderer, FontFamily> = {},
): Promise<Uint8Array<ArrayBuffer>> {
  return renderImage(element, resolveOgImageOptions(options));
}

/** Shared by the byte API and lazy response wrapper. */
export function resolveOgImageOptions<Renderer extends AnyImageRenderer, FontFamily extends string>(
  options: RenderOgImageOptions<Renderer, FontFamily>,
): RenderImageOptions<Renderer, FontFamily> {
  return {
    ...options,
    width: options.width ?? 1200,
    height: options.height ?? 630,
  };
}
