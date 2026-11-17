import { describe, expect, it, vi } from 'vite-plus/test';
import { html } from 'void/html';
import { ImageResponse, OgImageResponse } from '../../src/generate/index.ts';
import * as imageApi from '../../src/generate/index.ts';

const card = html`<div style="display:flex">Hello</div>`;

describe('OgImageResponse', () => {
  it('preserves response options independently of rendering options', async () => {
    const response = new OgImageResponse(card, {
      preset: 'x-summary',
      status: 201,
      statusText: 'Created',
      headers: { 'Content-Type': 'image/custom', 'Cache-Control': 'private, no-store' },
    });
    expect(response.status).toBe(201);
    expect(response.statusText).toBe('Created');
    expect(response.headers.get('content-type')).toBe('image/custom');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const view = new DataView(await response.arrayBuffer());
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([600, 600]);
  });

  it('does not evaluate content until the body is read', async () => {
    const component = vi.fn(() => ({ type: 'div', props: { children: 'Lazy OG' } }));
    const response = new OgImageResponse({ type: component, props: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(component).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400');
    await response.arrayBuffer();
    expect(component).toHaveBeenCalledTimes(1);
  });

  it.each([
    {},
    { preset: 'x-summary' },
    { width: 400, height: 300 },
    { width: 400 },
    { height: 300 },
  ] as const)('renderOgImage matches the response for %j', async (options) => {
    const bytes = await imageApi.renderOgImage(card, options);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toEqual(new Uint8Array(await new OgImageResponse(card, options).arrayBuffer()));
  });

  it('renderOgImage rejects invalid content without logging', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(imageApi.renderOgImage('plain string' as never)).rejects.toThrow(
        'Use the html template tag',
      );
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

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
