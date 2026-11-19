import { jsx } from 'hono/jsx';
import { render } from 'takumi-js';
import { Renderer } from 'takumi-js/wasm/no-init';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { html, raw } from 'void/html';
import { ImageResponse, renderImage, type ImageInput } from 'void/image';
import { fallbackFonts, robotoFont } from '../../src/fonts.ts';
import { takumiRenderer } from '../../src/index.ts';
import { robotoData } from '../../src/roboto-font.ts';

vi.mock('takumi-js', async (importOriginal) => {
  const takumi = await importOriginal<typeof import('takumi-js')>();
  return { ...takumi, render: vi.fn(takumi.render) };
});

const card = html`<div style="display:flex;width:100%;height:100%;background:#fff">Hello</div>`;

async function expectPng(response: Response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
}

// A css2 answer shaped like Google Fonts': a numbered subset can mix ASCII with
// common CJK characters, and the Latin subset covers Latin-1.
const NOTO_SANS_JP_CSS = `/* [0] */
@font-face {
  font-family: 'Noto Sans JP';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/noto-sans-jp/kana.woff2) format('woff2');
  unicode-range: U+3040-309F, U+4E16, U+754C;
}
/* [5] */
@font-face {
  font-family: 'Noto Sans JP';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/noto-sans-jp/unused.woff2) format('woff2');
  unicode-range: U+4E00-4E0F;
}
/* [118] */
@font-face {
  font-family: 'Noto Sans JP';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/noto-sans-jp/common.woff2) format('woff2');
  unicode-range: U+20-22, U+27-2A, U+2C-38, U+41-47, U+61-7B, U+3001, U+65E5;
}
/* latin */
@font-face {
  font-family: 'Noto Sans JP';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/noto-sans-jp/latin.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+2000-206F;
}
`;

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const requests: Array<string> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      return handler(url);
    }),
  );
  return requests;
}

// Only the cases below that stub fetch may reach the network.
beforeEach(() => {
  stubFetch(() => {
    throw new Error('unexpected fetch');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ImageResponse', () => {
  it('defers rendering until the body is read, then renders only once', async () => {
    const component = vi.fn(() => jsx('div', {}, 'Lazy'));
    const response = new ImageResponse(jsx(component, {}), {
      renderer: [takumiRenderer, { fallbackFonts: false }],
      width: 320,
      height: 168,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(component).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    const reader = response.body!.getReader();
    expect(component).not.toHaveBeenCalled();
    expect((await reader.read()).value!.subarray(0, 8)).toEqual(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(await reader.read()).toEqual({ value: undefined, done: true });
    expect(component).toHaveBeenCalledTimes(1);
  });

  it('does not render a body cancelled before reading', async () => {
    const component = vi.fn(() => jsx('div', {}, 'Cancelled'));
    const response = new ImageResponse(jsx(component, {}), {
      renderer: takumiRenderer,
      width: 320,
      height: 168,
    });
    await response.body!.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(component).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('defers content failures until consumption and preserves the original error', async () => {
    const error = new Error('invalid content');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const component = vi.fn(() => {
      throw error;
    });
    const response = new ImageResponse(jsx(component, {}), {
      renderer: takumiRenderer,
      width: 320,
      height: 168,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(component).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalled();
    await expect(response.arrayBuffer()).rejects.toBe(error);
    expect(component).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)(
    'handles cancellation during rendering when the renderer later %ss',
    async (outcome) => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      let finish!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      vi.mocked(render).mockImplementationOnce(() => {
        entered();
        return new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
          finish = () =>
            outcome === 'resolve'
              ? resolve(new Uint8Array([1]))
              : reject(new Error('cancelled render'));
        });
      });
      const response = new ImageResponse(card, {
        renderer: [takumiRenderer, { fallbackFonts: false }],
        width: 320,
        height: 168,
      });
      const reader = response.body!.getReader();
      const reading = reader.read();
      await started;
      await reader.cancel();
      finish();
      expect(await reading).toEqual({ value: undefined, done: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(logged).not.toHaveBeenCalled();
    },
  );

  it('renders a cloned response only once', async () => {
    const component = vi.fn(() => jsx('div', {}, 'Clone'));
    const response = new ImageResponse(jsx(component, {}), {
      renderer: [takumiRenderer, { fallbackFonts: false }],
      width: 320,
      height: 168,
    });
    const clone = response.clone();
    const [original, copy] = await Promise.all([response.arrayBuffer(), clone.arrayBuffer()]);
    expect(new Uint8Array(original)).toEqual(new Uint8Array(copy));
    expect(component).toHaveBeenCalledTimes(1);
  });

  it('exposes renderImage as an awaitable PNG primitive matching ImageResponse', async () => {
    const options = {
      renderer: [takumiRenderer, { fallbackFonts: false }] satisfies [unknown, unknown],
      width: 320,
      height: 168,
    };
    const bytes = await renderImage(card, options);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toEqual(new Uint8Array(await new ImageResponse(card, options).arrayBuffer()));
  });

  it('rejects renderImage before a response is created, without logging', async () => {
    const error = new Error('render failed');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(render).mockRejectedValueOnce(error);
    await expect(
      renderImage(card, {
        renderer: [takumiRenderer, { fallbackFonts: false }],
        width: 320,
        height: 168,
      }),
    ).rejects.toBe(error);
    expect(logged).not.toHaveBeenCalled();
  });

  it('always supplies the WASM renderer instead of selecting the native backend', async () => {
    void new Uint8Array(
      await new ImageResponse(card, {
        renderer: [takumiRenderer, { fallbackFonts: false }],
        width: 320,
        height: 168,
      }).arrayBuffer(),
    );
    expect(vi.mocked(render).mock.lastCall![1]).toEqual(
      expect.objectContaining({ renderer: expect.any(Renderer) }),
    );
  });

  it('defaults to offline Roboto and switches to Takumi Geist without leaking fonts', async () => {
    const requests = stubFetch(() => {
      throw new Error('unexpected fetch');
    });
    const options = {
      renderer: [takumiRenderer, { fallbackFonts: false }] satisfies [unknown, unknown],
      width: 320,
      height: 168,
    };
    const roboto = new Uint8Array(await new ImageResponse(card, options).arrayBuffer());
    const geist = new Uint8Array(
      await new ImageResponse(card, { ...options, font: 'Geist' }).arrayBuffer(),
    );
    expect(roboto).not.toEqual(geist);
    expect(
      new Uint8Array(await new ImageResponse(card, { ...options, font: 'Roboto' }).arrayBuffer()),
    ).toEqual(roboto);
    expect(
      new Uint8Array(await new ImageResponse(card, { ...options, font: 'Geist' }).arrayBuffer()),
    ).toEqual(geist);
    expect(vi.mocked(render).mock.lastCall![1]!.fonts).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('draws Cyrillic, Greek, and extended Latin offline with Roboto', async () => {
    const requests = stubFetch(() => {
      throw new Error('unexpected fetch');
    });
    for (const text of ['Тёплый чай · Свіжі булочки', 'Ελληνικά Ελλάδα', 'Łódź ş µ ₹']) {
      const markup = html`<div style="display:flex;font-size:30px">${text}</div>`;
      const options = { renderer: takumiRenderer, width: 600, height: 80 };
      const roboto = new Uint8Array(await new ImageResponse(markup, options).arrayBuffer());
      expect(roboto).not.toEqual(
        new Uint8Array(
          await new ImageResponse(markup, {
            ...options,
            renderer: [takumiRenderer, { fallbackFonts: false }],
            font: 'Geist',
          }).arrayBuffer(),
        ),
      );
    }
    expect(requests).toEqual([]);
    expect(robotoData()).toBe(robotoData());
  });

  it('keeps custom fonts ahead of bundled Roboto, including custom faces named Roboto', async () => {
    const options = {
      renderer: [takumiRenderer, { fallbackFonts: false }] satisfies [unknown, unknown],
      width: 320,
      height: 168,
    };
    const fonts = [{ name: 'Roboto', data: robotoData(), weight: 900 }];
    const custom = new Uint8Array(
      await new ImageResponse(card, { ...options, fonts }).arrayBuffer(),
    );
    expect(custom).not.toEqual(
      new Uint8Array(await new ImageResponse(card, options).arrayBuffer()),
    );
    expect(custom).toEqual(
      new Uint8Array(
        await new ImageResponse(card, {
          ...options,
          fonts,
          font: ['Roboto', 'Geist'],
        }).arrayBuffer(),
      ),
    );
  });

  it('uses Roboto variable weights rather than a fixed-weight face', async () => {
    const images = await Promise.all(
      [400, 550, 700, 900].map((weight) =>
        new ImageResponse(
          html`<div style="display:flex;font-size:40px;font-weight:${weight}">Variable</div>`,
          {
            renderer: [takumiRenderer, { fallbackFonts: false }],
            width: 320,
            height: 80,
          },
        ).arrayBuffer(),
      ),
    );
    expect(new Set(images.map((bytes) => Buffer.from(bytes).toString('base64'))).size).toBe(4);
    expect(robotoFont).not.toHaveProperty('weight');
  });

  it.each([false, true])(
    'does not retain earlier faces of a custom family (explicit family: %s)',
    async (explicitFamily) => {
      const name = `Brand ${explicitFamily}`;
      const node = jsx(
        'span',
        {
          style: {
            fontSize: 40,
            fontWeight: 900,
            ...(explicitFamily ? { fontFamily: name } : {}),
          },
        },
        'Brand example',
      );
      const draw = async (weight: number) =>
        new Uint8Array(
          await new ImageResponse(node, {
            renderer: [takumiRenderer, { fallbackFonts: false }],
            width: 400,
            height: 90,
            fonts: [{ name, data: robotoData(), weight }],
          }).arrayBuffer(),
        );
      const regular = await draw(400);
      expect(await draw(900)).not.toEqual(regular);
      expect(await draw(400)).toEqual(regular);
    },
  );

  it.each([
    ['synchronous', (value: string) => html`<div style="display:flex">${value}</div>`],
    [
      'asynchronous',
      (value: string) => html`<div style="display:flex">${Promise.resolve(value)}</div>`,
    ],
    [
      'nested',
      (value: string) => html`<div style="display:flex">${html`<span>${value}</span>`}</div>`,
    ],
  ])('escapes interpolated markup in %s Hono templates', async (_name, template) => {
    const title = '<img src="https://example.com/injected.png"> & "quotes" \'single\'';
    vi.mocked(render).mockClear();
    await expectPng(
      new ImageResponse(template(title), {
        renderer: [takumiRenderer, { fallbackFonts: false }],
        width: 320,
        height: 168,
      }),
    );
    const node = vi.mocked(render).mock.lastCall![0];
    expect(JSON.stringify(node)).toContain(JSON.stringify(title).slice(1, -1));
    expect(JSON.stringify(node)).not.toContain('"type":"image"');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    '<div>Hello</div>',
    Promise.resolve('<div>Hello</div>'),
    new String('<div>Hello</div>'),
  ])('rejects unmarked strings rather than rendering HTML: %s', async (input) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(render).mockClear();
    const response = new ImageResponse(input as never, {
      renderer: takumiRenderer,
      width: 320,
      height: 168,
    });
    await expect(response.arrayBuffer()).rejects.toThrow(
      'Use the html template tag from void/html instead of a plain string.',
    );
    expect(render).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps styles and class names but ignores utility props in Hono JSX and HTML', async () => {
    vi.mocked(render).mockClear();
    const inputs = [
      jsx(
        'section',
        { className: 'card', tw: 'hidden', style: { display: 'flex', textFit: 'shrink' } },
        jsx('span', { tw: 'text-white' }, 'Hello'),
      ),
      html`<section class="card" tw="hidden" style="display:flex;text-fit:shrink">
        <span tw="text-white">Hello</span>
      </section>`,
    ];
    for (const input of inputs) {
      await expectPng(
        new ImageResponse(input, {
          renderer: [takumiRenderer, { fallbackFonts: false }],
          width: 320,
          height: 168,
        }),
      );
      const node = vi.mocked(render).mock.lastCall![0];
      expect(node).toMatchObject({
        tagName: 'section',
        className: 'card',
        style: { display: 'flex', textFit: 'shrink' },
        children: expect.arrayContaining([
          expect.objectContaining({ tagName: 'span', text: 'Hello' }),
        ]),
      });
      expect(JSON.stringify(node)).not.toContain('"tw"');
    }
  });

  it('renders a PNG response', async () => {
    const response = new ImageResponse(card, { renderer: takumiRenderer, width: 320, height: 168 });
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    await expectPng(response);
  });

  it('renders explicitly trusted raw HTML', async () => {
    await expectPng(
      new ImageResponse(raw('<div style="display:flex">Hello</div>'), {
        renderer: takumiRenderer,
        width: 320,
        height: 168,
      }),
    );
    expect(JSON.stringify(vi.mocked(render).mock.lastCall![0])).toContain('Hello');
  });

  it('renders Hono JSX and runs each async function component once', async () => {
    const Title = vi.fn(async ({ text }: { text: string }) => jsx('span', {}, text));
    const response = new ImageResponse(
      jsx('div', { style: { display: 'flex' } }, jsx(Title, { text: 'Hello' })),
      { renderer: takumiRenderer, width: 600, height: 315 },
    );
    await expectPng(response);
    expect(Title).toHaveBeenCalledOnce();
  });

  it('leaves the cache policy to the caller', () => {
    expect(
      new ImageResponse(card, { renderer: takumiRenderer, width: 320, height: 168 }).headers.get(
        'cache-control',
      ),
    ).toBe(null);
  });

  it('keeps the status and headers it is given', () => {
    const response = new ImageResponse(card, {
      renderer: takumiRenderer,
      width: 320,
      height: 168,
      status: 201,
      statusText: 'Created',
      headers: { 'cache-control': 'public, max-age=60', 'x-image': 'card' },
    });
    expect(response.status).toBe(201);
    expect(response.statusText).toBe('Created');
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(response.headers.get('x-image')).toBe('card');
    expect(response.headers.get('content-type')).toBe('image/png');
  });

  it('passes Takumi none of its options that ImageResponseOptions leaves out', async () => {
    const response = new ImageResponse(card, {
      renderer: takumiRenderer,
      width: 320,
      height: 168,
      emoji: 'noto',
      lang: 'ja',
      // Takumi takes these, but void/image does not.
      format: 'jpeg',
      devicePixelRatio: 2,
      drawDebugBorder: true,
      images: { maxBytes: 1024, throwOnError: false, fetch: () => {} },
    } as never);
    expect(response.headers.get('content-type')).toBe('image/png');
    await expectPng(response);
    const options = vi.mocked(render).mock.lastCall![1]!;
    expect(Object.keys(options).sort()).toEqual([
      'css',
      'drawDebugBorder',
      'emoji',
      'fonts',
      'height',
      'images',
      'lang',
      'renderer',
      'width',
    ]);
    expect(options).toMatchObject({ drawDebugBorder: undefined, emoji: 'noto', lang: 'ja' });
    expect(Object.keys(options.images!).sort()).toEqual([
      'allowUrl',
      'fetchCache',
      'maxBytes',
      'throwOnError',
      'timeout',
    ]);
  });

  it('draws box borders with debug', async () => {
    const plain = new Uint8Array(
      await new ImageResponse(card, {
        renderer: takumiRenderer,
        width: 320,
        height: 168,
      }).arrayBuffer(),
    );
    const debug = new Uint8Array(
      await new ImageResponse(card, {
        renderer: takumiRenderer,
        width: 320,
        height: 168,
        debug: true,
      }).arrayBuffer(),
    );
    expect(debug).not.toEqual(plain);
  });

  it('applies a style element in the markup', async () => {
    const css = '.card { background: #000 }';
    const response = new ImageResponse(
      html`<style>
          ${css}
        </style>
        <div class="card" style="display:flex">Hi</div>`,
      { renderer: takumiRenderer, width: 320, height: 168 },
    );
    await expectPng(response);
    expect(vi.mocked(render).mock.lastCall![1]!.css).toEqual([expect.stringContaining(css)]);
  });

  it('keys a font by its bytes, so a font read for each request registers once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fontKey = async (data: Uint8Array) => {
      await new ImageResponse(card, {
        renderer: takumiRenderer,
        width: 320,
        height: 168,
        fonts: [{ name: 'Broken', data }],
      })
        .arrayBuffer()
        .catch(() => {});
      const fonts = vi.mocked(render).mock.lastCall?.[1]?.fonts as Array<{ key: string }>;
      return fonts[0]!.key;
    };
    const key = await fontKey(new Uint8Array([1, 2, 3]));
    expect(key).toMatch(/^@void\/image Broken:::[0-9a-f]{16}$/);
    expect(await fontKey(new Uint8Array([1, 2, 3]))).toBe(key);
    expect(await fontKey(new Uint8Array([1, 2, 4]))).not.toBe(key);
  });

  it('passes any font weight to Takumi, and none when it is left out', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const data = new Uint8Array([1, 2, 3]);
    await new ImageResponse(card, {
      renderer: takumiRenderer,
      width: 320,
      height: 168,
      fonts: [
        { name: 'Medium', data, weight: 550 },
        { name: 'Variable', data },
      ],
    })
      .arrayBuffer()
      .catch(() => {});
    const fonts = vi.mocked(render).mock.lastCall?.[1]?.fonts as Array<{
      name: string;
      weight?: number;
    }>;
    expect(fonts.map(({ name, weight }) => [name, weight])).toEqual([
      ['Medium', 550],
      ['Variable', undefined],
      ['@void/image Roboto', undefined],
    ]);
  });

  it('errors the body when the image cannot render', async () => {
    const data = new Uint8Array([1, 2, 3]);
    // A font entry may carry `lang`, which takumi does not take.
    const response = new ImageResponse(card, {
      renderer: takumiRenderer,
      width: 320,
      height: 168,
      fonts: [{ name: 'Broken', data, weight: 400, lang: 'ja-JP' }],
    });
    await expect(response.arrayBuffer()).rejects.toThrow();
    const fonts = vi.mocked(render).mock.lastCall?.[1]?.fonts as Array<object>;
    expect(fonts[0]).not.toHaveProperty('lang');
  });
});

describe('ImageResponse fallback fonts', () => {
  it('reuses subset downloads across changes in a fallback family', async () => {
    const requests = stubFetch((url) => {
      if (url.startsWith('https://fonts.googleapis.com/')) {
        const point = new URL(url).searchParams.get('text')!.codePointAt(0)!.toString(16);
        return new Response(
          `@font-face { font-family: 'Geist'; src: url(https://fonts.gstatic.com/cache-regression/${point}.woff2); unicode-range: U+${point}; }`,
        );
      }
      return new Response(new Uint8Array(robotoData()));
    });
    const renderTitle = async (point: number) =>
      new Uint8Array(
        await new ImageResponse(
          html`<div style="font-size:24px">${String.fromCodePoint(point)}</div>`,
          {
            renderer: takumiRenderer,
            width: 80,
            height: 40,
            font: 'Geist',
          },
        ).arrayBuffer(),
      );
    const first = await renderTitle(0x410);
    // Font-list changes clear registrations, but not downloaded subset bytes.
    expect(await renderTitle(0x410)).toEqual(first);
    const firstUrl = 'https://fonts.gstatic.com/cache-regression/410.woff2';
    expect(requests.filter((url) => url === firstUrl)).toHaveLength(1);
    for (let point = 0x411; point < 0x414; point++) {
      await renderTitle(point);
    }
    expect(await renderTitle(0x410)).toEqual(first);
    expect(requests.filter((url) => url === firstUrl)).toHaveLength(1);
  });

  it('requests no font for text the built-in font draws', async () => {
    const requests = stubFetch(() => new Response(null, { status: 404 }));
    await new ImageResponse(card, {
      renderer: takumiRenderer,
      width: 320,
      height: 168,
    }).arrayBuffer();
    await new ImageResponse(html`<div style="display:flex">C++ © 2026 “quotes” — … • ™ €</div>`, {
      renderer: takumiRenderer,
      width: 320,
      height: 168,
    }).arrayBuffer();
    expect(requests).toEqual([]);
  });

  it('renders each image with only its own fonts', async () => {
    vi.mocked(render).mockClear();
    await new ImageResponse(card, {
      renderer: takumiRenderer,
      width: 320,
      height: 168,
    }).arrayBuffer();
    // Without a font list, takumi uses every font registered in the process,
    // such as the fallback fonts of an earlier image.
    expect(vi.mocked(render).mock.calls.map(([, options]) => options?.fonts)).toEqual([
      [robotoFont],
    ]);
  });

  it('keeps Latin text off the Japanese family', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests = stubFetch((url) =>
      url.startsWith('https://fonts.googleapis.com/')
        ? new Response(NOTO_SANS_JP_CSS, { headers: { 'content-type': 'text/css' } })
        : new Response(null, { status: 404 }),
    );
    const response = new ImageResponse(html`<div style="display:flex">Hello こんにちは日本</div>`, {
      renderer: takumiRenderer,
      width: 320,
      height: 168,
    });
    // The font files are missing, so the image renders without them.
    await expectPng(response);
    const css = new URL(requests[0]!);
    expect(css.origin + css.pathname).toBe('https://fonts.googleapis.com/css2');
    expect(css.searchParams.getAll('family')).toEqual(['Noto Sans JP:wght@100..900']);
    // The subset that mixes ASCII with 日 still serves 日; the Latin subset and
    // the subset the text does not use are never fetched.
    expect(requests.slice(1).sort()).toEqual([
      'https://fonts.gstatic.com/noto-sans-jp/common.woff2',
      'https://fonts.gstatic.com/noto-sans-jp/kana.woff2',
    ]);
    expect(warned).toHaveBeenCalledWith(
      '@void/image: could not download Noto Sans JP. Rendering without it.',
      expect.anything(),
    );
  });

  it("uses Geist's own subsets for letters the built-in Geist lacks", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests = stubFetch(() => new Response(null, { status: 404 }));
    await new ImageResponse(html`<div style="display:flex">Łódź 5µs</div>`, {
      renderer: takumiRenderer,
      width: 320,
      height: 168,
      font: 'Geist',
    }).arrayBuffer();
    expect(new URL(requests[0]!).searchParams.getAll('family')).toEqual(['Geist:wght@100..900']);
  });

  it('downloads no fallback font when fallbackFonts is false', async () => {
    const requests = stubFetch(() => new Response(null, { status: 404 }));
    vi.mocked(render).mockClear();
    const data = new Uint8Array([1, 2, 3]);
    await new ImageResponse(html`<div style="display:flex">日本語 ★ Łódź</div>`, {
      renderer: [takumiRenderer, { fallbackFonts: false }],
      width: 320,
      height: 168,
      fonts: [{ name: 'App', data }],
    })
      .arrayBuffer()
      .catch(() => {});
    expect(requests).toEqual([]);
    const fonts = vi.mocked(render).mock.lastCall?.[1]?.fonts as Array<{ name: string }>;
    expect(fonts.map(({ name }) => name)).toEqual(['App', '@void/image Roboto']);
  });

  it('asks each family for only the characters it draws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests = stubFetch(() => new Response(null, { status: 404 }));
    await new ImageResponse(html`<div style="display:flex">本日 ♜ 日本語 ♜</div>`, {
      renderer: takumiRenderer,
      width: 320,
      height: 168,
    }).arrayBuffer();
    const texts = Object.fromEntries(
      requests.map((url) => {
        const { searchParams } = new URL(url);
        return [searchParams.get('family'), searchParams.get('text')];
      }),
    );
    expect(texts).toEqual({
      'Noto Sans JP:wght@100..900': '日本語',
      'Noto Sans Symbols:wght@100..900': '♜',
      'Noto Sans Symbols 2:wght@400': '♜',
    });
  });

  it('combines missing Cyrillic and unmatched Greek in the same Noto Sans request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests = stubFetch(() => new Response(null, { status: 404 }));
    void new Uint8Array(
      await new ImageResponse(html`<div>Ꙁ Ϡ</div>`, {
        renderer: takumiRenderer,
        width: 320,
        height: 168,
      }).arrayBuffer(),
    );
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!);
    expect(url.searchParams.getAll('family')).toEqual(['Noto Sans:wght@100..900']);
    expect([...url.searchParams.get('text')!].sort()).toEqual(['Ꙁ', 'Ϡ'].sort());
  });

  it('asks the Korean family for both Han and Hangul in Korean text', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests = stubFetch(() => new Response(null, { status: 404 }));
    await new ImageResponse(html`<div style="display:flex">中文・한국어</div>`, {
      renderer: takumiRenderer,
      width: 320,
      height: 168,
    }).arrayBuffer();
    expect(
      requests.map((url) => {
        const { searchParams } = new URL(url);
        return [searchParams.get('family'), searchParams.get('text')];
      }),
    ).toEqual([['Noto Sans KR:wght@100..900', [...'中文・한국어'].sort().join('')]]);
  });

  it('asks for the whole family when the text is too long for one request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests = stubFetch(() => new Response(null, { status: 404 }));
    const kanji = Array.from({ length: 700 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('');
    await new ImageResponse(html`<div style="display:flex">${kanji}</div>`, {
      renderer: takumiRenderer,
      width: 320,
      height: 168,
    }).arrayBuffer();
    const css = new URL(requests[0]!);
    expect(css.searchParams.getAll('family')).toEqual(['Noto Sans JP:wght@100..900']);
    expect(css.searchParams.has('text')).toBe(false);
  });

  it('draws the marks ・ and ー with the Japanese family', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests = stubFetch(() => new Response(null, { status: 404 }));
    await new ImageResponse(html`<div style="display:flex">東京・ラーメン</div>`, {
      renderer: takumiRenderer,
      width: 320,
      height: 168,
    }).arrayBuffer();
    expect(requests.flatMap((url) => new URL(url).searchParams.getAll('family'))).toEqual([
      'Noto Sans JP:wght@100..900',
    ]);
  });

  it('leaves variable fallback faces free to draw bold', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Google answers a weight range with `font-weight: 100 900`, and a single
    // weight with that weight.
    stubFetch((url) => {
      if (!url.startsWith('https://fonts.googleapis.com/')) {
        return new Response(null, { status: 404 });
      }
      const [family, weight] = new URL(url).searchParams.get('family')!.split(':wght@');
      const range = family === 'Noto Sans JP' ? 'U+65E5' : 'U+2192';
      return new Response(
        `@font-face { font-family: '${family}'; font-weight: ${weight!.replace('..', ' ')}; src: url(https://fonts.gstatic.com/${weight}.woff2) format('woff2'); unicode-range: ${range}; }`,
        { headers: { 'content-type': 'text/css' } },
      );
    });
    vi.mocked(render).mockClear();
    await new ImageResponse(html`<div style="display:flex;font-weight:700">日 → B</div>`, {
      renderer: takumiRenderer,
      width: 320,
      height: 168,
      font: 'Geist',
    }).arrayBuffer();
    const [, options] = vi.mocked(render).mock.calls[0]!;
    const weights = Object.fromEntries(
      ((options?.fonts ?? []) as Array<{ name: string; weight?: number }>).map((font) => [
        font.name,
        font.weight,
      ]),
    );
    // A face without a fixed weight follows `font-weight` along its axis; one
    // pinned to 400 is only thickened for bold text.
    expect(weights).toEqual({
      '@void/image Geist fallback Noto Sans JP': undefined,
      '@void/image Geist fallback Noto Sans Math': 400,
    });
  });

  it('restricts a subset without ranges to missing characters', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests = stubFetch((url) =>
      url.startsWith('https://fonts.googleapis.com/')
        ? new Response(
            `@font-face { font-family: 'Noto Sans Math'; src: url(https://fonts.gstatic.com/math.woff2) format('woff2'); }`,
            { headers: { 'content-type': 'text/css' } },
          )
        : new Response(null, { status: 404 }),
    );
    await new ImageResponse(html`<div style="display:flex">A → B</div>`, {
      renderer: takumiRenderer,
      width: 320,
      height: 168,
      font: 'Geist',
    }).arrayBuffer();
    expect(requests.slice(1)).toEqual(['https://fonts.gstatic.com/math.woff2']);
    const [, options] = vi.mocked(render).mock.calls.at(-2)!;
    const [font] = options!.fonts as Array<{ name: string; unicodeRange: Array<[number, number]> }>;
    expect(font!.name).toBe('@void/image Geist fallback Noto Sans Math');
    const covers = (codepoint: number) =>
      font!.unicodeRange.some(([start, end]) => codepoint >= start && codepoint <= end);
    expect(covers(0x2192)).toBe(true);
    expect(covers(0x41)).toBe(false);
    expect(covers(0x20ac)).toBe(false);
  });

  it('keeps fallback coverage stable across texts and separate between defaults', async () => {
    stubFetch(
      () =>
        new Response(
          `@font-face { font-family: 'Noto Sans JP'; src: url(https://fonts.gstatic.com/all.woff2) format('woff2'); unicode-range: U+0-10FFFF; }`,
        ),
    );
    const subsets = [];
    for (const defaultFont of ['Roboto', 'Geist'] as const) {
      const [first] = await fallbackFonts(
        { type: 'text', text: '日本' },
        undefined,
        undefined,
        new Set(),
        defaultFont,
      );
      const [second] = await fallbackFonts(
        { type: 'text', text: '東京' },
        undefined,
        undefined,
        new Set(),
        defaultFont,
      );
      expect(first!.key).toBe(second!.key);
      expect(first!.unicodeRange).toEqual(second!.unicodeRange);
      const covers = (codepoint: number) =>
        first!.unicodeRange.some(([start, end]) => codepoint >= start && codepoint <= end);
      expect(covers(0x41)).toBe(false);
      expect(covers(0x65e5)).toBe(true);
      expect(covers(0x410)).toBe(defaultFont === 'Geist');
      expect(covers(0x391)).toBe(defaultFont === 'Geist');
      subsets.push(first!);
    }
    expect(subsets[0]!.name).not.toBe(subsets[1]!.name);
    expect(subsets[0]!.key).not.toBe(subsets[1]!.key);
  });

  it('draws Han text as Japanese unless lang says otherwise', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests = stubFetch(() => new Response(null, { status: 404 }));
    const family = async (element: ImageInput, lang?: string) => {
      requests.length = 0;
      await new ImageResponse(element, {
        renderer: takumiRenderer,
        width: 320,
        height: 168,
        lang,
      }).arrayBuffer();
      return new URL(requests[0]!).searchParams.getAll('family');
    };
    expect(await family(html`<div style="display:flex">東京都</div>`)).toEqual([
      'Noto Sans JP:wght@100..900',
    ]);
    expect(await family(html`<div style="display:flex">東京都</div>`, 'zh-TW')).toEqual([
      'Noto Sans TC:wght@100..900',
    ]);
    expect(await family(html`<div lang="zh" style="display:flex">东京都</div>`)).toEqual([
      'Noto Sans SC:wght@100..900',
    ]);
    expect(await family(html`<div style="display:flex">漢字 한국어</div>`)).toEqual([
      'Noto Sans KR:wght@100..900',
    ]);
    // Kana alone marks Japanese only when no `lang` names the language.
    expect(await family(html`<div style="display:flex">東京タワー</div>`)).toEqual([
      'Noto Sans JP:wght@100..900',
    ]);
    expect(await family(html`<div lang="zh-TW" style="display:flex">東京タワー</div>`)).toEqual([
      'Noto Sans TC:wght@100..900',
    ]);
    expect(await family(html`<div style="display:flex">咖啡コーヒー</div>`, 'zh-CN')).toEqual([
      'Noto Sans SC:wght@100..900',
    ]);
  });

  it.each(['twemoji', 'blobmoji', 'noto', 'openmoji', 'fluent', 'fluentFlat'] as const)(
    'draws %s emoji as images, fetched once per isolate, without a font',
    async (emoji) => {
      const requests = stubFetch(() => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>'));
      const markup = html`<div style="display:flex">🪩</div>`;
      const options = { renderer: takumiRenderer, width: 320, height: 168, emoji };
      await expectPng(new ImageResponse(markup, options));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/.*\.svg$/);
      await new ImageResponse(markup, options).arrayBuffer();
      expect(requests).toHaveLength(1);
    },
  );

  it.each([
    'https://cdn.jsdelivr.net/gh/example/brand@main/logo.svg',
    'https://cdn.jsdelivr.net/npm/example-brand/logo.svg',
    'https://cdn.jsdelivr.net/gh/jdecked/twemoji@17.0.2/assets/svg/../../logo.svg',
  ])('fetches ordinary jsDelivr images anew for each render: %s', async (url) => {
    let version = 0;
    const requests = stubFetch(
      () =>
        new Response(
          `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="${version++ === 0 ? 'red' : 'blue'}"/></svg>`,
          { headers: { 'content-type': 'image/svg+xml' } },
        ),
    );
    const node = jsx('img', {
      src: url,
      style: { width: 32, height: 32 },
    });
    const options = {
      renderer: [takumiRenderer, { fallbackFonts: false }] satisfies [unknown, unknown],
      width: 32,
      height: 32,
    };
    const first = new Uint8Array(await new ImageResponse(node, options).arrayBuffer());
    const second = new Uint8Array(await new ImageResponse(node, options).arrayBuffer());
    expect(requests).toEqual([url, url]);
    expect(second).not.toEqual(first);
  });

  it('fails on an emoji that cannot download, unless told to leave it out', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(() => new Response(null, { status: 404 }));
    const emoji = html`<div style="display:flex">🪅</div>`;
    await expect(
      new ImageResponse(emoji, { renderer: takumiRenderer, width: 320, height: 168 }).arrayBuffer(),
    ).rejects.toThrow();
    const response = new ImageResponse(emoji, {
      renderer: [takumiRenderer, { images: { throwOnError: false } }],
      width: 320,
      height: 168,
    });
    await expectPng(response);
  });

  it('uses the symbol and math families for characters Geist lacks', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests = stubFetch((url) =>
      url.endsWith('.svg')
        ? new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
            headers: { 'content-type': 'image/svg+xml' },
          })
        : new Response(null, { status: 404 }),
    );
    await new ImageResponse(html`<div style="display:flex">A → B ★ ₹ 🎉</div>`, {
      renderer: takumiRenderer,
      width: 320,
      height: 168,
      font: 'Geist',
    }).arrayBuffer();
    // The emoji is an image, so it asks for no font. ₹ has no row and goes to Noto Sans.
    const families = requests
      .filter((url) => url.startsWith('https://fonts.googleapis.com/'))
      .flatMap((url) => new URL(url).searchParams.getAll('family'))
      .sort();
    expect(families).toEqual([
      'Noto Sans Math:wght@400',
      'Noto Sans Symbols 2:wght@400',
      'Noto Sans Symbols:wght@100..900',
      'Noto Sans:wght@100..900',
    ]);
  });

  it('leaves out only the fallback files that fail to download', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // One subset per family. The Japanese file downloads; both symbol files are missing.
    const requests = stubFetch((url) => {
      if (url.startsWith('https://fonts.googleapis.com/')) {
        const family = new URL(url).searchParams.get('family')!.split(':')[0]!;
        const range = family === 'Noto Sans JP' ? 'U+65E5, U+672C' : 'U+265C';
        const file = `https://fonts.gstatic.com/${family.replaceAll(' ', '-')}.woff2`;
        return new Response(
          `@font-face { font-family: '${family}'; src: url(${file}) format('woff2'); unicode-range: ${range}; }`,
          { headers: { 'content-type': 'text/css' } },
        );
      }
      return url.endsWith('Noto-Sans-JP.woff2')
        ? new Response(new Uint8Array(robotoData()))
        : new Response(null, { status: 404 });
    });
    vi.mocked(render).mockClear();
    await expectPng(
      new ImageResponse(html`<div style="display:flex">日本 ♜</div>`, {
        renderer: takumiRenderer,
        width: 320,
        height: 168,
      }),
    );
    // Noto Sans JP, Symbols and Symbols 2. Each failure drops that file only,
    // so the Japanese font stays, where the image used to lose every fallback.
    const attempts = vi
      .mocked(render)
      .mock.calls.map(([, options]) =>
        ((options?.fonts ?? []) as Array<{ name?: string }>).map((font) => font.name),
      );
    expect(attempts.map((fonts) => fonts.length)).toEqual([4, 2]);
    expect(attempts.at(-1)).toEqual([
      '@void/image Roboto',
      '@void/image Roboto fallback Noto Sans JP',
    ]);
    // A file that failed is not requested again.
    expect(
      requests.filter((url) => url.includes('Symbols')).filter((url) => url.endsWith('.woff2')),
    ).toHaveLength(2);
    expect(requests.filter((url) => url.endsWith('Noto-Sans-JP.woff2'))).toHaveLength(1);
    expect(warned).toHaveBeenCalledTimes(2);
  });

  it('records shared fallback download failures separately for concurrent images', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests = stubFetch((url) => {
      if (url.startsWith('https://fonts.googleapis.com/')) {
        const family = new URL(url).searchParams.get('family')!.split(':')[0]!;
        const range = family === 'Noto Sans JP' ? 'U+65E5, U+672C' : 'U+265C';
        return new Response(
          `@font-face { font-family: '${family}'; src: url(https://fonts.gstatic.com/concurrent/${family.replaceAll(' ', '-')}.woff2); unicode-range: ${range}; }`,
        );
      }
      return url.endsWith('Noto-Sans-JP.woff2')
        ? new Response(new Uint8Array(robotoData()))
        : new Response(null, { status: 404 });
    });
    vi.mocked(render).mockClear();
    const draw = async () =>
      new Uint8Array(
        await new ImageResponse(html`<div style="display:flex">日本 ♜</div>`, {
          renderer: takumiRenderer,
          width: 320,
          height: 168,
        }).arrayBuffer(),
      );
    const [first, second] = await Promise.all([draw(), draw()]);
    expect(second).toEqual(first);
    const retries = vi
      .mocked(render)
      .mock.calls.map(([, options]) => (options?.fonts ?? []) as Array<{ name?: string }>)
      .filter((fonts) => fonts.length < 4);
    expect(retries.map((fonts) => fonts.map((font) => font.name))).toEqual([
      ['@void/image Roboto', '@void/image Roboto fallback Noto Sans JP'],
      ['@void/image Roboto', '@void/image Roboto fallback Noto Sans JP'],
    ]);
    expect(requests.filter((url) => url.endsWith('.woff2'))).toHaveLength(3);
    expect(warned).toHaveBeenCalledTimes(4);
  });

  it('renders without fallback fonts when Google Fonts cannot be reached', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const response = new ImageResponse(html`<div style="display:flex">안녕하세요</div>`, {
      renderer: takumiRenderer,
      width: 320,
      height: 168,
    });
    await expectPng(response);
    expect(warned).toHaveBeenCalledWith(
      '@void/image: could not load Noto Sans KR from Google Fonts.',
      expect.anything(),
    );
  });
});
