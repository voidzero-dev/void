import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toSlash } from 'pathslash';
import { render } from 'takumi-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import voidManifest from '../../package.json' with { type: 'json' };
import { findVoidPackageDir, nodeTargetPlugin } from '../../src/plugin-node-target.ts';
import { ImageResponse } from '../../src/runtime/image.ts';

vi.mock('takumi-js', async (importOriginal) => {
  const takumi = await importOriginal<typeof import('takumi-js')>();
  return { ...takumi, render: vi.fn(takumi.render) };
});

const card = '<div style="display:flex;width:100%;height:100%;background:#fff">Hello</div>';

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
  it('renders a PNG response', async () => {
    const response = new ImageResponse(card, { width: 320, height: 168 });
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    await expectPng(response);
  });

  it('renders React-style elements and runs each function component once', async () => {
    const Title = vi.fn(({ text }: { text: string }) => ({
      type: 'span',
      props: { children: text },
    }));
    const response = new ImageResponse(
      {
        type: 'div',
        props: { style: { display: 'flex' }, children: { type: Title, props: { text: 'Hello' } } },
      },
      { width: 600, height: 315 },
    );
    await expectPng(response);
    expect(Title).toHaveBeenCalledOnce();
  });

  it('tells clients to revalidate the image on each use', () => {
    expect(new ImageResponse(card, { width: 320, height: 168 }).headers.get('cache-control')).toBe(
      'public, max-age=0, must-revalidate',
    );
  });

  it('keeps the status and headers it is given', () => {
    const response = new ImageResponse(card, {
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
      await new ImageResponse(card, { width: 320, height: 168 }).arrayBuffer(),
    );
    const debug = new Uint8Array(
      await new ImageResponse(card, { width: 320, height: 168, debug: true }).arrayBuffer(),
    );
    expect(debug).not.toEqual(plain);
  });

  it('applies a style element in the markup', async () => {
    const response = new ImageResponse(
      '<style>.card { background: #000 }</style><div class="card" style="display:flex">Hi</div>',
      { width: 320, height: 168 },
    );
    await expectPng(response);
    expect(vi.mocked(render).mock.lastCall![1]!.css).toEqual(['.card { background: #000 }']);
  });

  it('keys a font by its bytes, so a font read for each request registers once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fontKey = async (data: Uint8Array) => {
      await new ImageResponse(card, { width: 320, height: 168, fonts: [{ name: 'Broken', data }] })
        .arrayBuffer()
        .catch(() => {});
      const fonts = vi.mocked(render).mock.lastCall?.[1]?.fonts as Array<{ key: string }>;
      return fonts[0]!.key;
    };
    const key = await fontKey(new Uint8Array([1, 2, 3]));
    expect(key).toMatch(/^void\/image Broken:::[0-9a-f]{16}$/);
    expect(await fontKey(new Uint8Array([1, 2, 3]))).toBe(key);
    expect(await fontKey(new Uint8Array([1, 2, 4]))).not.toBe(key);
  });

  it('passes any font weight to Takumi, and none when it is left out', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const data = new Uint8Array([1, 2, 3]);
    await new ImageResponse(card, {
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
    ]);
  });

  it('errors the body when the image cannot render', async () => {
    const data = new Uint8Array([1, 2, 3]);
    // A font entry may carry `lang`, which takumi does not take.
    const response = new ImageResponse(card, {
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
  it('requests no font for text the built-in font draws', async () => {
    const requests = stubFetch(() => new Response(null, { status: 404 }));
    await new ImageResponse(card, { width: 320, height: 168 }).arrayBuffer();
    await new ImageResponse('<div style="display:flex">C++ © 2026 “quotes” — … • ™ €</div>', {
      width: 320,
      height: 168,
    }).arrayBuffer();
    expect(requests).toEqual([]);
  });

  it('renders each image with only its own fonts', async () => {
    vi.mocked(render).mockClear();
    await new ImageResponse(card, { width: 320, height: 168 }).arrayBuffer();
    // Without a font list, takumi uses every font registered in the process,
    // such as the fallback fonts of an earlier image.
    expect(vi.mocked(render).mock.calls.map(([, options]) => options?.fonts)).toEqual([[]]);
  });

  it('keeps Latin text off the Japanese family', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests = stubFetch((url) =>
      url.startsWith('https://fonts.googleapis.com/')
        ? new Response(NOTO_SANS_JP_CSS, { headers: { 'content-type': 'text/css' } })
        : new Response(null, { status: 404 }),
    );
    const response = new ImageResponse('<div style="display:flex">Hello こんにちは日本</div>', {
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
      'void/image: could not download Noto Sans JP. Rendering without it.',
      expect.anything(),
    );
  });

  it("uses Geist's own subsets for letters the built-in Geist lacks", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests = stubFetch(() => new Response(null, { status: 404 }));
    await new ImageResponse('<div style="display:flex">Łódź 5µs</div>', {
      width: 320,
      height: 168,
    }).arrayBuffer();
    expect(new URL(requests[0]!).searchParams.getAll('family')).toEqual(['Geist:wght@100..900']);
  });

  it('downloads no fallback font when fallbackFonts is false', async () => {
    const requests = stubFetch(() => new Response(null, { status: 404 }));
    vi.mocked(render).mockClear();
    const data = new Uint8Array([1, 2, 3]);
    await new ImageResponse('<div style="display:flex">日本語 ★ Łódź</div>', {
      width: 320,
      height: 168,
      fonts: [{ name: 'App', data }],
      fallbackFonts: false,
    })
      .arrayBuffer()
      .catch(() => {});
    expect(requests).toEqual([]);
    const fonts = vi.mocked(render).mock.lastCall?.[1]?.fonts as Array<{ name: string }>;
    expect(fonts.map(({ name }) => name)).toEqual(['App']);
  });

  it('asks each family for only the characters it draws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests = stubFetch(() => new Response(null, { status: 404 }));
    await new ImageResponse('<div style="display:flex">本日 ★ 日本語 ★</div>', {
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
      'Noto Sans Symbols:wght@100..900': '★',
      'Noto Sans Symbols 2:wght@400': '★',
    });
  });

  it('asks the Korean family for both Han and Hangul in Korean text', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests = stubFetch(() => new Response(null, { status: 404 }));
    await new ImageResponse('<div style="display:flex">中文・한국어</div>', {
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
    await new ImageResponse(`<div style="display:flex">${kanji}</div>`, {
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
    await new ImageResponse('<div style="display:flex">東京・ラーメン</div>', {
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
    await new ImageResponse('<div style="display:flex;font-weight:700">日 → B</div>', {
      width: 320,
      height: 168,
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
      'void/image Noto Sans JP': undefined,
      'void/image Noto Sans Math': 400,
    });
  });

  it('takes a whole font for a subset without ranges, beyond Latin-1', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests = stubFetch((url) =>
      url.startsWith('https://fonts.googleapis.com/')
        ? new Response(
            `@font-face { font-family: 'Noto Sans Math'; src: url(https://fonts.gstatic.com/math.woff2) format('woff2'); }`,
            { headers: { 'content-type': 'text/css' } },
          )
        : new Response(null, { status: 404 }),
    );
    await new ImageResponse('<div style="display:flex">A → B</div>', {
      width: 320,
      height: 168,
    }).arrayBuffer();
    expect(requests.slice(1)).toEqual(['https://fonts.gstatic.com/math.woff2']);
    const [, options] = vi.mocked(render).mock.calls.at(-2)!;
    expect(options?.fonts).toMatchObject([
      { name: 'void/image Noto Sans Math', unicodeRange: [[0x100, 0x10ffff]] },
    ]);
  });

  it('draws Han text as Japanese unless lang says otherwise', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests = stubFetch(() => new Response(null, { status: 404 }));
    const family = async (html: string, lang?: string) => {
      requests.length = 0;
      await new ImageResponse(html, { width: 320, height: 168, lang }).arrayBuffer();
      return new URL(requests[0]!).searchParams.getAll('family');
    };
    expect(await family('<div style="display:flex">東京都</div>')).toEqual([
      'Noto Sans JP:wght@100..900',
    ]);
    expect(await family('<div style="display:flex">東京都</div>', 'zh-TW')).toEqual([
      'Noto Sans TC:wght@100..900',
    ]);
    expect(await family('<div lang="zh" style="display:flex">东京都</div>')).toEqual([
      'Noto Sans SC:wght@100..900',
    ]);
    expect(await family('<div style="display:flex">漢字 한국어</div>')).toEqual([
      'Noto Sans KR:wght@100..900',
    ]);
    // Kana alone marks Japanese only when no `lang` names the language.
    expect(await family('<div style="display:flex">東京タワー</div>')).toEqual([
      'Noto Sans JP:wght@100..900',
    ]);
    expect(await family('<div lang="zh-TW" style="display:flex">東京タワー</div>')).toEqual([
      'Noto Sans TC:wght@100..900',
    ]);
    expect(await family('<div style="display:flex">咖啡コーヒー</div>', 'zh-CN')).toEqual([
      'Noto Sans SC:wght@100..900',
    ]);
  });

  it('draws emoji as images, fetched once per isolate, without a font', async () => {
    const requests = stubFetch(() => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    const emoji = '<div style="display:flex">🪩</div>';
    await expectPng(new ImageResponse(emoji, { width: 320, height: 168 }));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/.*\.svg$/);
    await new ImageResponse(emoji, { width: 320, height: 168 }).arrayBuffer();
    expect(requests).toHaveLength(1);
  });

  it('fails on an emoji that cannot download, unless told to leave it out', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(() => new Response(null, { status: 404 }));
    const emoji = '<div style="display:flex">🪅</div>';
    await expect(
      new ImageResponse(emoji, { width: 320, height: 168 }).arrayBuffer(),
    ).rejects.toThrow();
    const response = new ImageResponse(emoji, {
      width: 320,
      height: 168,
      images: { throwOnError: false },
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
    await new ImageResponse('<div style="display:flex">A → B ★ ₹ 🎉</div>', {
      width: 320,
      height: 168,
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
        const range = family === 'Noto Sans JP' ? 'U+65E5, U+672C' : 'U+2605';
        const file = `https://fonts.gstatic.com/${family.replaceAll(' ', '-')}.woff2`;
        return new Response(
          `@font-face { font-family: '${family}'; src: url(${file}) format('woff2'); unicode-range: ${range}; }`,
          { headers: { 'content-type': 'text/css' } },
        );
      }
      return url.endsWith('Noto-Sans-JP.woff2')
        ? new Response(new Uint8Array([0, 1, 0, 0]))
        : new Response(null, { status: 404 });
    });
    // Stand in for Takumi's font loading, one file at a time, so the order of
    // failures is fixed; the bytes above are not a real font to draw with.
    const original = vi.mocked(render).getMockImplementation();
    vi.mocked(render).mockClear();
    vi.mocked(render).mockImplementation(async (_node, options) => {
      for (const font of (await options?.fonts) ?? []) {
        if (typeof font === 'object' && 'data' in font && typeof font.data === 'function') {
          await font.data();
        }
      }
      return new Uint8Array();
    });
    try {
      await new ImageResponse('<div style="display:flex">日本 ★</div>', {
        width: 320,
        height: 168,
      }).arrayBuffer();
    } finally {
      vi.mocked(render).mockImplementation(original!);
    }
    // Noto Sans JP, Symbols and Symbols 2. Each failure drops that file only,
    // so the Japanese font stays, where the image used to lose every fallback.
    const attempts = vi
      .mocked(render)
      .mock.calls.map(([, options]) =>
        ((options?.fonts ?? []) as Array<{ name?: string }>).map((font) => font.name),
      );
    expect(attempts.map((fonts) => fonts.length)).toEqual([3, 2, 1]);
    expect(attempts.at(-1)).toEqual(['void/image Noto Sans JP']);
    // A file that failed is not requested again.
    expect(
      requests.filter((url) => url.includes('Symbols')).filter((url) => url.endsWith('.woff2')),
    ).toHaveLength(2);
    expect(warned).toHaveBeenCalledTimes(2);
  });

  it('renders without fallback fonts when Google Fonts cannot be reached', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const response = new ImageResponse('<div style="display:flex">안녕하세요</div>', {
      width: 320,
      height: 168,
    });
    await expectPng(response);
    expect(warned).toHaveBeenCalledWith(
      'void/image: could not load Noto Sans KR from Google Fonts.',
      expect.anything(),
    );
  });
});

describe('void/image on Node.js targets', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  function rendererPlugin() {
    return nodeTargetPlugin('node').find(
      (candidate) => candidate.name === 'void:node-target-image-renderer',
    )!;
  }

  function resolveRenderer(
    importer = toSlash(fileURLToPath(new URL('../../src/runtime/image.ts', import.meta.url))),
    plugin = rendererPlugin(),
  ) {
    const resolveId = plugin.resolveId as {
      handler: (this: unknown, id: string, importer: string) => unknown;
    };
    return resolveId.handler.call(
      { environment: { config: { root, command } }, warn },
      'takumi-js/helpers',
      importer,
    );
  }
  let command = 'build';
  const warn = vi.fn();

  // The range void/image declares; the app must install a version in it.
  const range = voidManifest.dependencies['takumi-js'];

  function installTakumi(version: string) {
    root ??= mkdtempSync(join(tmpdir(), 'void-image-node-'));
    mkdirSync(join(root, 'node_modules', 'takumi-js'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'takumi-js', 'package.json'),
      JSON.stringify({ name: 'takumi-js', version }),
    );
  }

  it('fails the build when the app cannot load takumi-js itself', () => {
    root = mkdtempSync(join(tmpdir(), 'void-image-node-'));
    expect(resolveRenderer).toThrow(
      `void/image needs takumi-js@${range} in your app's dependencies with target 'node'`,
    );
  });

  it('fails the build when the app has a takumi-js that void/image does not support', () => {
    installTakumi('2.15.2');
    expect(resolveRenderer).toThrow('The app has takumi-js 2.15.2.');
    installTakumi('3.0.0');
    expect(resolveRenderer).toThrow('The app has takumi-js 3.0.0.');
    installTakumi('2.18.2');
    expect(resolveRenderer).toThrow('The app has takumi-js 2.18.2.');
    installTakumi('2.20.1-beta.1');
    expect(resolveRenderer).toThrow('The app has takumi-js 2.20.1-beta.1.');
    // takumi-js 2.19.0 draws boxes for text its first matching font lacks.
    installTakumi('2.19.0');
    expect(resolveRenderer).toThrow('The app has takumi-js 2.19.0.');
  });

  it('warns once in the dev server instead', () => {
    root = mkdtempSync(join(tmpdir(), 'void-image-node-'));
    const plugin = rendererPlugin();
    command = 'serve';
    warn.mockClear();
    try {
      expect(resolveRenderer(undefined, plugin)).toBeUndefined();
      expect(resolveRenderer(undefined, plugin)).toBeUndefined();
    } finally {
      command = 'build';
    }
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain(`npm install takumi-js@${range}`);
  });

  it("leaves a supported takumi-js in the app's dependencies to Node.js", () => {
    installTakumi(range.replace(/^[~^]/, ''));
    expect(resolveRenderer()).toBeUndefined();
    installTakumi('2.20.9');
    expect(resolveRenderer()).toBeUndefined();
  });

  it('leaves takumi-js that the app imports itself alone', () => {
    installTakumi('3.0.0');
    expect(resolveRenderer(toSlash(join(root!, 'src', 'image.ts')))).toBeUndefined();
  });

  it("finds void's package.json wherever the bundler places the plugin", () => {
    root = toSlash(mkdtempSync(join(tmpdir(), 'void-image-node-')));
    const voidDir = `${root}/node_modules/void`;
    mkdirSync(`${voidDir}/dist/chunks`, { recursive: true });
    writeFileSync(`${voidDir}/package.json`, JSON.stringify({ name: 'void' }));
    // A package.json without void's name, such as a nested `type` marker, is skipped.
    writeFileSync(`${voidDir}/dist/package.json`, JSON.stringify({ type: 'module' }));
    expect(findVoidPackageDir(`${voidDir}/dist/index.mjs`)).toBe(voidDir);
    expect(findVoidPackageDir(`${voidDir}/dist/chunks/plugin-abc.mjs`)).toBe(voidDir);
    expect(() => findVoidPackageDir(`${root}/elsewhere/index.mjs`)).toThrow(
      "could not find void's package.json",
    );
  });
});
