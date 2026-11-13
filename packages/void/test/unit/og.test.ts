import { describe, expect, it, vi } from 'vite-plus/test';
import { html } from '../../src/runtime/html.ts';
import { ImageResponse } from '../../src/runtime/image.ts';
import { OgImageResponse } from '../../src/runtime/og.ts';

const card = html`<div style="display:flex">Hello</div>`;

describe('OgImageResponse', () => {
  it('caches public images for 24 hours by default', async () => {
    const response = new OgImageResponse(card);
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400');
    await response.arrayBuffer();
  });

  it.each([
    { 'Cache-Control': 'private, no-store', 'x-image': 'card' },
    new Headers({ 'Cache-Control': 'private, no-store', 'x-image': 'card' }),
    [
      ['Cache-Control', 'private, no-store'],
      ['x-image', 'card'],
    ],
  ] satisfies Array<HeadersInit>)('preserves caller headers: %j', async (headers) => {
    const original = new Headers(headers);
    const response = new OgImageResponse(card, { headers });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-image')).toBe('card');
    expect([...new Headers(headers)]).toEqual([...original]);
    await response.arrayBuffer();
  });

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

  it('renders a 1200x630 PNG by default', async () => {
    const response = new OgImageResponse(card);
    const view = new DataView(await response.arrayBuffer());
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([1200, 630]);
  });

  it('allows size overrides', async () => {
    const response = new OgImageResponse(card, { width: 400, height: 300 });
    const view = new DataView(await response.arrayBuffer());
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([400, 300]);
  });

  it.each([
    { preset: 'x-summary', size: [600, 600] },
    { preset: 'pinterest', size: [1000, 1500] },
  ] as const)('renders the $preset preset', async ({ preset, size }) => {
    const response = new OgImageResponse(card, { preset });
    const view = new DataView(await response.arrayBuffer());
    expect([view.getUint32(16), view.getUint32(20)]).toEqual(size);
  });
});
