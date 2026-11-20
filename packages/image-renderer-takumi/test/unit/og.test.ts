import { jsx } from 'hono/jsx';
import { describe, expect, it, vi } from 'vite-plus/test';
import { html } from 'void/html';
import { ImageResponse, OgImageResponse, renderOgImage } from 'void/image';
import { takumiRenderer } from '../../src/index.ts';

const card = html`<div style="display:flex">Hello</div>`;

describe('OgImageResponse', () => {
  it('preserves response options independently of rendering options', async () => {
    const response = new OgImageResponse(card, {
      renderer: takumiRenderer,
      width: 600,
      height: 600,
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
    const component = vi.fn(() => jsx('div', {}, 'Lazy OG'));
    const response = new OgImageResponse(jsx(component, {}), { renderer: takumiRenderer });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(component).not.toHaveBeenCalled();
    await response.arrayBuffer();
    expect(component).toHaveBeenCalledTimes(1);
  });

  it.each([
    {},
    { width: 600, height: 600 },
    { width: 400, height: 300 },
    { width: 400 },
    { height: 300 },
  ] as const)('renderOgImage matches the response for %j', async (options) => {
    const renderOptions = { ...options, renderer: takumiRenderer };
    const bytes = await renderOgImage(card, renderOptions);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toEqual(
      new Uint8Array(await new OgImageResponse(card, renderOptions).arrayBuffer()),
    );
  });

  it('renderOgImage rejects invalid content without logging', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        renderOgImage('plain string' as never, { renderer: takumiRenderer }),
      ).rejects.toThrow('Use the html template tag');
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it('omits the default cache header when Vite sets DEV', () => {
    const response = new OgImageResponse(card, { renderer: takumiRenderer });
    expect(response.headers.get('cache-control')).toBeNull();
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
    const response = new OgImageResponse(card, { renderer: takumiRenderer, headers });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-image')).toBe('card');
    expect([...new Headers(headers)]).toEqual([...original]);
    await response.arrayBuffer();
  });

  it('inherits Roboto by default and allows the built-in Geist', async () => {
    const roboto = new Uint8Array(
      await new OgImageResponse(card, {
        renderer: [takumiRenderer, { fallbackFonts: false }],
      }).arrayBuffer(),
    );
    const geist = new Uint8Array(
      await new OgImageResponse(card, {
        renderer: [takumiRenderer, { fallbackFonts: false }],
        font: 'Geist',
      }).arrayBuffer(),
    );
    expect(roboto).not.toEqual(geist);
    expect(roboto).toEqual(
      new Uint8Array(
        await new OgImageResponse(card, {
          renderer: [takumiRenderer, { fallbackFonts: false }],
          font: 'Roboto',
        }).arrayBuffer(),
      ),
    );
  });

  it('rejects plain strings', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = new OgImageResponse('<div>Hello</div>' as never, {
        renderer: takumiRenderer,
      });
      await expect(response.arrayBuffer()).rejects.toThrow(
        'Use the html template tag from void/html instead of a plain string.',
      );
    } finally {
      error.mockRestore();
    }
  });

  it('renders asynchronous Hono templates', async () => {
    const response = new OgImageResponse(html`<div>${Promise.resolve('Hello')}</div>`, {
      renderer: takumiRenderer,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it('extends ImageResponse', async () => {
    const response = new OgImageResponse(card, { renderer: takumiRenderer });
    expect(response).toBeInstanceOf(ImageResponse);
    await response.arrayBuffer();
  });

  it('renders a 1200x630 PNG by default', async () => {
    const response = new OgImageResponse(card, { renderer: takumiRenderer });
    const view = new DataView(await response.arrayBuffer());
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([1200, 630]);
  });

  it.each([
    { options: { width: 400, height: 300 }, size: [400, 300] },
    { options: { width: 400 }, size: [400, 630] },
    { options: { height: 300 }, size: [1200, 300] },
  ] as const)('allows size overrides: $options', async ({ options, size }) => {
    const response = new OgImageResponse(card, { ...options, renderer: takumiRenderer });
    const view = new DataView(await response.arrayBuffer());
    expect([view.getUint32(16), view.getUint32(20)]).toEqual(size);
  });
});
