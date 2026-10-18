import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toSlash } from 'pathslash';
import { render } from 'takumi-js';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
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

  it('draws box borders with debug', async () => {
    const plain = new Uint8Array(await new ImageResponse(card).arrayBuffer());
    const debug = new Uint8Array(await new ImageResponse(card, { debug: true }).arrayBuffer());
    expect(debug).not.toEqual(plain);
  });

  it('accepts the deprecated stylesheets option beside a style element', async () => {
    // takumi warns that the option is deprecated.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = new ImageResponse(
      '<style>.card { background: #000 }</style><div class="card" style="display:flex">Hi</div>',
      { stylesheets: ['.card { color: #fff }'] },
    );
    expect(await pngSize(response)).toEqual({ width: 1200, height: 630 });
  });

  it('errors the body when the image cannot render', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = new ImageResponse(card, { fonts: [new Uint8Array([1, 2, 3])] });
    await expect(response.arrayBuffer()).rejects.toThrow();
    expect(logged).toHaveBeenCalledWith('void/og: failed to render the image.', expect.anything());
  });
});

describe('ImageResponse fallback fonts', () => {
  it('requests no font for Latin text', async () => {
    const requests = stubFetch(() => new Response(null, { status: 500 }));
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
    // The subset that mixes ASCII with 日 still serves 日; the Latin subset is never fetched.
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
    const requests = stubFetch(() => new Response(null, { status: 503 }));
    await new ImageResponse('<div style="display:flex">Łódź</div>').arrayBuffer();
    expect(new URL(requests[0]!).searchParams.getAll('family')).toEqual(['Noto Sans:wght@400']);
  });

  it('uses the Simplified Chinese family for Han text without kana or Hangul', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests = stubFetch(() => new Response(null, { status: 503 }));
    await new ImageResponse('<div style="display:flex">你好世界</div>').arrayBuffer();
    expect(new URL(requests[0]!).searchParams.getAll('family')).toEqual(['Noto Sans SC:wght@400']);
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

  function resolveRenderer(
    importer = toSlash(fileURLToPath(new URL('../../src/runtime/og.ts', import.meta.url))),
  ) {
    const plugin = nodeTargetPlugin('node').find(
      (candidate) => candidate.name === 'void:node-target-image-renderer',
    )!;
    const resolveId = plugin.resolveId as {
      handler: (this: unknown, id: string, importer: string) => unknown;
    };
    return resolveId.handler.call(
      { environment: { config: { root } } },
      'takumi-js/helpers',
      importer,
    );
  }

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
