import { html, raw } from '../../../html.ts';
import type { ImageInput } from '../types.ts';
import { browserFontFamily } from './fonts.ts';

export async function imageDocument(
  input: ImageInput,
  { debug, lang, font }: { debug?: boolean; lang?: string; font?: string | Array<string> },
  fontCss: string,
): Promise<string> {
  const element = await input;
  if ((element as { isEscaped?: unknown } | null)?.isEscaped !== true) {
    if (typeof element === 'string' || element instanceof String) {
      throw new TypeError('Use the html template tag from void/html instead of a plain string.');
    }
    throw new TypeError('void/image: expected JSX or an escaped HTML template.');
  }

  // Hono escapes normal JSX and template interpolations. Authored markup is
  // trusted in both forms; Browser Run still enforces the CSP and disables JS.
  const body = raw(String(await element.toString()));
  const fontPolicy = fontCss ? ' font-src https: data:;' : '';
  const styles = raw(
    `${fontCss}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{font-family:${browserFontFamily(font)}}${debug ? 'body *{outline:1px solid magenta}' : ''}`,
  );
  return String(
    html`<!doctype html>
      <html lang="${lang ?? ''}">
        <head>
          <meta charset="utf-8" />
          <meta
            http-equiv="Content-Security-Policy"
            content="default-src 'none'; style-src 'unsafe-inline'; img-src https: http: data:;${fontPolicy} base-uri 'none'; form-action 'none'"
          />
          <style>
            ${styles}
          </style>
        </head>
        <body>
          ${body}
        </body>
      </html>`,
  );
}
