import { getRawRuntimeEnv } from '../../../env/raw.ts';
import type { ImageRenderer } from '../types.ts';
import {
  browserFontCss,
  type BrowserRunDefaultFontFamily,
  type BrowserRunFontData,
} from './fonts.ts';
import { imageDocument } from './html.ts';

/** The default renderer uses the Worker binding directly, without a browser SDK. */
export const browserRunRenderer: ImageRenderer<
  BrowserRunDefaultFontFamily,
  BrowserRunFontData
> = async (input, options) => {
  const { width, height } = options;
  if (![width, height].every((size) => Number.isSafeInteger(size) && size > 0)) {
    throw new TypeError('void/image: Browser Run requires positive integer dimensions.');
  }

  let browser: BrowserRun | undefined;
  try {
    browser = getRawRuntimeEnv().BROWSER as BrowserRun | undefined;
  } catch {
    // Outside a Worker or a Void request there is no binding environment.
  }
  if (typeof browser?.quickAction !== 'function') {
    throw new Error(
      'void/image: configure a Cloudflare Browser Run binding named BROWSER, or pass an explicit renderer.',
    );
  }

  const fontCss = browserFontCss(options.fonts);
  const response = await browser.quickAction('screenshot', {
    html: await imageDocument(input, options, fontCss),
    viewport: { width, height, deviceScaleFactor: 1 },
    screenshotOptions: { type: 'png', omitBackground: true },
    setJavaScriptEnabled: false,
    gotoOptions: { waitUntil: fontCss ? 'networkidle0' : 'load' },
    cacheTTL: 0,
  });
  if (!response.ok) {
    throw new Error(`void/image: Browser Run screenshot failed (HTTP ${response.status}).`);
  }
  const png = new Uint8Array(await response.arrayBuffer());
  if (png.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => png[i] === byte)) {
    throw new Error('void/image: Browser Run did not return a PNG.');
  }
  return png;
};
