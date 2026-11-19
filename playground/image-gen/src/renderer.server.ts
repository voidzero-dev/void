import {
  takumiRenderer,
  type TakumiRendererFontData,
  type TakumiRendererOptions,
} from '@void/image-renderer-takumi';
import {
  ImageResponse,
  renderImage,
  type DefaultImageRenderer,
  type ImageFont,
  type ImageInput,
  type ImageResponseOptions,
} from 'void/image';

type PreviewOptions = Omit<ImageResponseOptions<DefaultImageRenderer, string>, 'renderer'> & {
  renderer?: typeof takumiRenderer | [typeof takumiRenderer, TakumiRendererOptions];
};

export function selectRenderer(value: string | undefined): typeof takumiRenderer | undefined {
  return value === 'browser' ? undefined : takumiRenderer;
}

export async function previewImage(
  input: ImageInput,
  { renderer, fonts, ...options }: PreviewOptions,
): Promise<Response> {
  if (renderer) {
    const byteFonts = fonts?.map((font): ImageFont<string, TakumiRendererFontData> => {
      if (!(font.data instanceof Uint8Array || font.data instanceof ArrayBuffer)) {
        throw new TypeError('The Takumi preview requires font bytes.');
      }
      return { ...font, data: font.data };
    });
    return new ImageResponse(input, { ...options, renderer, fonts: byteFonts });
  }

  // Resolve the remote call before sending PNG headers so Vite doesn't append
  // its HTML error overlay when the downstream stream fails.
  const { status, statusText, headers, ...renderOptions } = options;
  try {
    const png = await renderImage(input, { ...renderOptions, fonts });
    const responseHeaders = new Headers(headers);
    responseHeaders.set('Content-Type', 'image/png');
    return new Response(png, { status, statusText, headers: responseHeaders });
  } catch (error) {
    console.error('Image playground: Browser Run screenshot failed.', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(`Browser Run screenshot failed: ${message}`, {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
}
