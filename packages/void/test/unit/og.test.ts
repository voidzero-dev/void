import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toSlash } from 'pathslash';
import { render } from 'takumi-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import voidManifest from '../../package.json' with { type: 'json' };
import { nodeTargetPlugin } from '../../src/plugin-node-target.ts';
import { ImageResponse } from '../../src/runtime/og.ts';

vi.mock('takumi-js', async (importOriginal) => {
  const takumi = await importOriginal<typeof import('takumi-js')>();
  return { ...takumi, render: vi.fn(takumi.render) };
});

const card = '<div style="display:flex;width:100%;height:100%;background:#fff">Hello</div>';

async function pngSize(response: Response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
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
  it('renders a 1200x630 PNG by default', async () => {
    const response = new ImageResponse(card);
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(await pngSize(response)).toEqual({ width: 1200, height: 630 });
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
    expect(await pngSize(response)).toEqual({ width: 600, height: 315 });
    expect(Title).toHaveBeenCalledOnce();
  });

  // Builds cache images for a year: test/integration/og-image.test.ts.
  it('does not cache images during development', () => {
    expect(new ImageResponse(card).headers.get('cache-control')).toBe('no-cache, no-store');
  });

  it('keeps the status and headers it is given', () => {
    const response = new ImageResponse(card, {
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

  it('labels other formats with their content type', async () => {
    const response = new ImageResponse(card, { format: 'jpeg' });
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
  });

  it('keeps the default size for an undefined width or height', async () => {
    const response = new ImageResponse(card, { width: undefined, height: undefined });
    expect(await pngSize(response)).toEqual({ width: 1200, height: 630 });
  });

  it('draws box borders with debug', async () => {
    const plain = new Uint8Array(await new ImageResponse(card).arrayBuffer());
    const debug = new Uint8Array(await new ImageResponse(card, { debug: true }).arrayBuffer());
    expect(debug).not.toEqual(plain);
  });

  it('accepts css and the deprecated stylesheets option beside a style element', async () => {
    const response = new ImageResponse(
      '<style>.card { background: #000 }</style><div class="card" style="display:flex">Hi</div>',
      { css: '.card { padding: 8px }', stylesheets: ['.card { color: #fff }'] },
    );
    expect(await pngSize(response)).toEqual({ width: 1200, height: 630 });
  });

  it('errors the body when the image cannot render', async () => {
    const data = new Uint8Array([1, 2, 3]);
    // A next/og font entry may carry Satori's `lang`, which takumi does not take.
    const response = new ImageResponse(card, {
      fonts: [{ name: 'Broken', data, weight: 400, lang: 'ja-JP' }],
    });
    await expect(response.arrayBuffer()).rejects.toThrow();
    expect(vi.mocked(render).mock.lastCall?.[1]?.fonts).toEqual([
      { name: 'Broken', data, weight: 400 },
    ]);
  });
});

describe('ImageResponse fallback fonts', () => {
  it('requests no font for Latin text', async () => {
    const requests = stubFetch(() => new Response(null, { status: 404 }));
    await new ImageResponse(card).arrayBuffer();
    expect(requests).toEqual([]);
  });

  it('renders each image with only its own fonts', async () => {
    vi.mocked(render).mockClear();
    await new ImageResponse(card).arrayBuffer();
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
    const response = new ImageResponse('<div style="display:flex">Hello こんにちは日本</div>');
    // The font files are missing, so the image renders without them.
    expect(await pngSize(response)).toEqual({ width: 1200, height: 630 });
    const css = new URL(requests[0]!);
    expect(css.origin + css.pathname).toBe('https://fonts.googleapis.com/css2');
    expect(css.searchParams.getAll('family')).toEqual(['Noto Sans JP:wght@400']);
    // The subset that mixes ASCII with 日 still serves 日; the Latin subset and
    // the subset the text does not use are never fetched.
    expect(requests.slice(1).sort()).toEqual([
      'https://fonts.gstatic.com/noto-sans-jp/common.woff2',
      'https://fonts.gstatic.com/noto-sans-jp/kana.woff2',
    ]);
    expect(warned).toHaveBeenCalledWith(
      'void/og: could not download Noto Sans JP. Rendering without it.',
      expect.anything(),
    );
  });

  it('uses Noto Sans for accented Latin letters that Geist lacks', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests = stubFetch(() => new Response(null, { status: 404 }));
    await new ImageResponse('<div style="display:flex">Łódź</div>').arrayBuffer();
    expect(new URL(requests[0]!).searchParams.getAll('family')).toEqual(['Noto Sans:wght@400']);
  });

  it('draws Han text as Japanese unless lang says otherwise, like next/og', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests = stubFetch(() => new Response(null, { status: 404 }));
    const family = async (html: string, lang?: string) => {
      requests.length = 0;
      await new ImageResponse(html, { lang }).arrayBuffer();
      return new URL(requests[0]!).searchParams.getAll('family');
    };
    expect(await family('<div style="display:flex">東京都</div>')).toEqual([
      'Noto Sans JP:wght@400',
    ]);
    expect(await family('<div style="display:flex">東京都</div>', 'zh-TW')).toEqual([
      'Noto Sans TC:wght@400',
    ]);
    expect(await family('<div lang="zh" style="display:flex">东京都</div>')).toEqual([
      'Noto Sans SC:wght@400',
    ]);
    expect(await family('<div style="display:flex">漢字 한국어</div>')).toEqual([
      'Noto Sans KR:wght@400',
    ]);
  });

  it('draws emoji as images, without a font', async () => {
    const requests = stubFetch(() => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    expect(await pngSize(new ImageResponse('<div style="display:flex">🎉</div>'))).toEqual({
      width: 1200,
      height: 630,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/.*\.svg$/);
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
    await new ImageResponse('<div style="display:flex">A → B ★ 🎉</div>').arrayBuffer();
    // The emoji is an image, so it asks for no font.
    const fonts = requests.filter((url) => url.startsWith('https://fonts.googleapis.com/'));
    expect(new URL(fonts[0]!).searchParams.getAll('family')).toEqual([
      'Noto Sans Math:wght@400',
      'Noto Sans Symbols 2:wght@400',
    ]);
  });

  it('renders without fallback fonts when Google Fonts cannot be reached', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const response = new ImageResponse('<div style="display:flex">안녕하세요</div>');
    expect(await pngSize(response)).toEqual({ width: 1200, height: 630 });
    expect(warned).toHaveBeenCalledWith(
      'void/og: could not load Noto Sans KR from Google Fonts.',
      expect.anything(),
    );
  });
});

describe('void/og on Node.js targets', () => {
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
    importer = toSlash(fileURLToPath(new URL('../../src/runtime/og.ts', import.meta.url))),
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

  // The range void/og declares; the app must install a version in it.
  const range = voidManifest.dependencies['takumi-js'];

  function installTakumi(version: string) {
    root ??= mkdtempSync(join(tmpdir(), 'void-og-node-'));
    mkdirSync(join(root, 'node_modules', 'takumi-js'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'takumi-js', 'package.json'),
      JSON.stringify({ name: 'takumi-js', version }),
    );
  }

  it('fails the build when the app cannot load takumi-js itself', () => {
    root = mkdtempSync(join(tmpdir(), 'void-og-node-'));
    expect(resolveRenderer).toThrow(
      `void/og needs takumi-js@${range} in your app's dependencies with target 'node'`,
    );
  });

  it('fails the build when the app has a takumi-js that void/og does not support', () => {
    installTakumi('2.15.2');
    expect(resolveRenderer).toThrow('The app has takumi-js 2.15.2.');
    installTakumi('3.0.0');
    expect(resolveRenderer).toThrow('The app has takumi-js 3.0.0.');
    installTakumi('2.17.0-beta.1');
    expect(resolveRenderer).toThrow('The app has takumi-js 2.17.0-beta.1.');
  });

  it('warns once in the dev server instead', () => {
    root = mkdtempSync(join(tmpdir(), 'void-og-node-'));
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
    installTakumi(range.replace(/^\^/, ''));
    expect(resolveRenderer()).toBeUndefined();
  });

  it('leaves takumi-js that the app imports itself alone', () => {
    installTakumi('3.0.0');
    expect(resolveRenderer(toSlash(join(root!, 'src', 'image.ts')))).toBeUndefined();
  });
});
