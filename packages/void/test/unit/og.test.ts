import { describe, expect, it, vi } from 'vite-plus/test';
import { html } from '../../src/runtime/html.ts';
import { ImageResponse } from '../../src/runtime/image.ts';
import { OgImageResponse } from '../../src/runtime/og.ts';

const card = html`<div style="display:flex">Hello</div>`;

describe('OgImageResponse', () => {
  it('inherits Inter by default and allows the built-in Geist', async () => {
    const inter = new Uint8Array(
      await new OgImageResponse(card, { fallbackFonts: false }).arrayBuffer(),
    );
    const geist = new Uint8Array(
      await new OgImageResponse(card, { defaultFont: 'Geist', fallbackFonts: false }).arrayBuffer(),
    );
    expect(inter).not.toEqual(geist);
    expect(inter).toEqual(
      new Uint8Array(
        await new OgImageResponse(card, {
          defaultFont: 'Inter',
          fallbackFonts: false,
        }).arrayBuffer(),
      ),
    );
  });

  it('rejects plain strings', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = new OgImageResponse('<div>Hello</div>' as never);
      await expect(response.arrayBuffer()).rejects.toThrow(
        'Use the html template tag from void/html instead of a plain string.',
      );
    } finally {
      error.mockRestore();
    }
  });

  it('renders asynchronous Hono templates', async () => {
    const response = new OgImageResponse(html`<div>${Promise.resolve('Hello')}</div>`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it('extends ImageResponse', async () => {
    const response = new OgImageResponse(card);
    expect(response).toBeInstanceOf(ImageResponse);
    await response.arrayBuffer();
  });

  it.each([undefined, {}, { width: undefined, height: undefined }])(
    'renders a 1200x630 PNG by default with options %j',
    async (options) => {
      const response = new OgImageResponse(card, options);
      const bytes = await response.arrayBuffer();
      const view = new DataView(bytes);
      expect({ width: view.getUint32(16), height: view.getUint32(20) }).toEqual({
        width: 1200,
        height: 630,
      });
    },
  );
});
