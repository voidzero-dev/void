import { describe, expect, it } from 'vite-plus/test';
import { ImageResponse } from '../../src/runtime/image.ts';
import { OgImageResponse } from '../../src/runtime/og.ts';

const card = '<div style="display:flex">Hello</div>';

describe('OgImageResponse', () => {
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
