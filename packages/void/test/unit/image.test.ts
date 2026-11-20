import { spawnSync } from 'node:child_process';
import { jsx } from 'hono/jsx';
import { describe, expect, it, vi } from 'vite-plus/test';
import { envContext } from '../../src/runtime/env/raw.ts';
import { html } from '../../src/runtime/html.ts';
import {
  ImageResponse,
  OgImageResponse,
  renderImage,
  renderOgImage,
} from '../../src/runtime/image/index.ts';

const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, ...new Uint8Array(16));

describe('void/image', () => {
  it('selects an explicit renderer lazily and forwards only rendering options', async () => {
    const renderer = vi.fn(async () => png);
    const input = html`<div>Hello</div>`;
    const response = new OgImageResponse(input, {
      renderer,
      status: 201,
      headers: { 'x-image': '1' },
    });
    expect(renderer).not.toHaveBeenCalled();
    expect(response.status).toBe(201);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    expect(renderer).toHaveBeenCalledExactlyOnceWith(input, { width: 1200, height: 630 });

    await renderOgImage(input, { renderer, width: 320 });
    expect(renderer).toHaveBeenLastCalledWith(input, { width: 320, height: 630 });
  });

  it('does not start a render if the body is cancelled before reading', async () => {
    const renderer = vi.fn(async () => png);
    const response = new ImageResponse(html`<div>Hello</div>`, {
      width: 320,
      height: 200,
      renderer,
    });
    await response.body?.cancel();
    expect(renderer).not.toHaveBeenCalled();
  });

  it.each(['unread', 'cancelled', 'read later'] as const)(
    'handles a rejected async template in a %s response without crashing Node',
    (state) => {
      const responseModule = new URL(
        '../../src/runtime/image/generate/image-response.ts',
        import.meta.url,
      ).href;
      const htmlModule = new URL('../../src/runtime/html.ts', import.meta.url).href;
      // Run outside Vitest's rejection listener: Node must survive with strict
      // unhandled-rejection handling, even if nobody ever consumes the body.
      const script = `
        import assert from 'node:assert/strict';
        import { setImmediate } from 'node:timers/promises';
        import { ImageResponse } from ${JSON.stringify(responseModule)};
        import { html } from ${JSON.stringify(htmlModule)};
        const { promise, reject } = Promise.withResolvers();
        const failure = new Error('async template failed');
        let renders = 0;
        const response = new ImageResponse(html\`<div>\${promise}</div>\`, {
          width: 320,
          height: 200,
          renderer: async (input) => {
            renders++;
            await input;
            return new Uint8Array();
          },
        });
        if (${JSON.stringify(state)} === 'cancelled') await response.body.cancel();
        reject(failure);
        await setImmediate();
        assert.equal(renders, 0);
        if (${JSON.stringify(state)} === 'read later') {
          const errors = [];
          console.error = (...args) => errors.push(args);
          await assert.rejects(response.arrayBuffer(), (error) => error === failure);
          assert.equal(renders, 1);
          assert.equal(errors.length, 1);
          assert.equal(errors[0][1], failure);
        }
      `;
      const child = spawnSync(
        process.execPath,
        ['--unhandled-rejections=strict', '--input-type=module', '--eval', script],
        { encoding: 'utf8', timeout: 10_000 },
      );
      expect(child.error).toBeUndefined();
      expect(child.stderr).toBe('');
      expect(child.status).toBe(0);
    },
  );

  it('sends escaped HTML to Browser Run', async () => {
    const quickAction = vi.fn(async () => new Response(png));
    const input = html`<div>${Promise.resolve('<img src="injected">')} 🎉</div>`;
    const bytes = await envContext.run({ BROWSER: { quickAction } }, () =>
      renderImage(input, {
        width: 320,
        height: 200,
      }),
    );
    expect(bytes).toEqual(png);
    expect(quickAction).toHaveBeenCalledExactlyOnceWith(
      'screenshot',
      expect.objectContaining({
        html: expect.stringContaining('&lt;img src=&quot;injected&quot;&gt; 🎉'),
        viewport: { width: 320, height: 200, deviceScaleFactor: 1 },
        setJavaScriptEnabled: false,
      }),
    );
    expect(quickAction).toHaveBeenCalledWith(
      'screenshot',
      expect.objectContaining({
        html: expect.stringContaining('body{font-family:"Roboto",sans-serif}'),
      }),
    );
    expect(JSON.stringify(quickAction.mock.calls)).not.toContain('font.woff2');
  });

  it('adds named URL and byte fonts to the Browser Run document', async () => {
    const quickAction = vi.fn(
      async (_action: string, _options: BrowserRunScreenshotOptions) => new Response(png),
    );
    await envContext.run({ BROWSER: { quickAction } }, () =>
      renderImage(html`<div style="font-family: Demo">Hello</div>`, {
        width: 320,
        height: 200,
        font: ['Demo', 'Arial', 'sans-serif'],
        fonts: [
          { name: 'Demo', data: { url: 'https://fonts.gstatic.com/example.woff2' } },
          {
            name: '</style><script>',
            data: Uint8Array.of(119, 79, 70, 50),
            weight: 700,
            style: 'italic',
          },
        ],
      }),
    );
    const [, options] = quickAction.mock.calls[0]!;
    expect(options).toHaveProperty('html');
    if (!('html' in options)) {
      throw new Error('Expected Browser Run to receive an HTML document.');
    }
    expect(options.html).toContain('font-src https: data:;');
    expect(options.html).toContain('body{font-family:"Demo","Arial",sans-serif}');
    expect(options.html).toContain(
      'font-family:"Demo";src:url("https://fonts.gstatic.com/example.woff2");font-weight:1 1000',
    );
    expect(options.html).toContain(
      'url("data:font/woff2;base64,d09GMg==");font-weight:700;font-style:italic',
    );
    expect(options.html).not.toContain('</style><script>');
    expect(options.gotoOptions?.waitUntil).toBe('networkidle0');
  });

  it('renders Hono JSX once and escapes async component text', async () => {
    const quickAction = vi.fn(async () => new Response(png));
    const component = vi.fn(async () =>
      jsx('div', { style: { fontWeight: 700, fontSize: 32 } }, '<text>'),
    );
    await envContext.run({ BROWSER: { quickAction } }, () =>
      renderImage(jsx(component, {}), { width: 320, height: 200 }),
    );
    expect(component).toHaveBeenCalledTimes(1);
    expect(quickAction).toHaveBeenCalledWith(
      'screenshot',
      expect.objectContaining({
        html: expect.stringContaining('font-weight:700;font-size:32px">&lt;text&gt;</div>'),
      }),
    );
  });

  it('reports the missing Browser Run binding', async () => {
    await expect(
      envContext.run({}, () => renderImage(html`<div>Hello</div>`, { width: 320, height: 200 })),
    ).rejects.toThrow('binding named BROWSER');
  });
});
