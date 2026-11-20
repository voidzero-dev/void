import { render, type FontLoader, type Node } from 'takumi-js';
import { Renderer } from 'takumi-js/wasm/no-init';
import { describe, expect, it, vi } from 'vite-plus/test';
import { withImageRenderer } from '../../src/image-renderer.ts';
import { robotoData } from '../../src/roboto-font.ts';
import { decodedFontSize, fontVariant } from '../fixtures/font-variants.ts';

const options = { width: 320, height: 80 };
const text: Node = { type: 'text', text: 'A Ω', style: { fontSize: 24 } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('image renderer font retention', () => {
  it('reuses downloaded bytes after switching font lists', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(new Uint8Array(robotoData())));
    try {
      const a = 'https://example.com/font-cache/brand-a.woff2';
      const b = 'https://example.com/font-cache/brand-b.woff2';
      const draw = (url: string) =>
        withImageRenderer((renderer) => render(text, { ...options, fonts: [url], renderer }));
      const first = await draw(a);
      expect(await draw(a)).toEqual(first);
      await draw(b);
      expect(await draw(a)).toEqual(first);
      expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([a, b]);
    } finally {
      fetch.mockRestore();
    }
  });

  it('shares an in-flight font download across simultaneous renderers', async () => {
    const entered = deferred<void>();
    const finish = deferred<void>();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      entered.resolve();
      await finish.promise;
      return new Response(new Uint8Array(robotoData()));
    });
    try {
      const draw = () =>
        withImageRenderer((renderer) =>
          render(text, {
            ...options,
            fonts: ['https://example.com/font-cache/concurrent.woff2'],
            renderer,
          }),
        );
      const first = draw();
      const second = draw();
      await entered.promise;
      finish.resolve();
      const [a, b] = await Promise.all([first, second]);
      expect(a).toEqual(b);
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      finish.resolve();
      fetch.mockRestore();
    }
  });

  it('retries a font URL after a failed download', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockImplementation(async () => new Response(new Uint8Array(robotoData())));
    try {
      const draw = () =>
        withImageRenderer((renderer) =>
          render(text, {
            ...options,
            fonts: ['https://example.com/font-cache/retry.woff2'],
            renderer,
          }),
        );
      await expect(draw()).rejects.toThrow('HTTP 404');
      await expect(draw()).resolves.toBeInstanceOf(Uint8Array);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      fetch.mockRestore();
    }
  });

  it('reuses an identical font list but removes faces omitted by a later image', async () => {
    const regularLoad = vi.fn(robotoData);
    const heavyLoad = vi.fn(robotoData);
    const regular = {
      name: 'Retained Brand',
      key: 'retained-brand-400',
      data: regularLoad,
      weight: 400,
    };
    const heavy = {
      name: regular.name,
      key: 'retained-brand-900',
      data: heavyLoad,
      weight: 900,
    };
    const node: Node = {
      ...text,
      style: { ...text.style, fontFamily: regular.name, fontWeight: 900 },
    };
    const draw = (fonts: Array<FontLoader>) =>
      withImageRenderer((renderer) => render(node, { ...options, fonts, renderer }));
    const first = await draw([regular]);
    expect(await draw([{ ...regular }])).toEqual(first);
    expect(regularLoad).toHaveBeenCalledOnce();
    const both = await draw([regular, heavy]);
    expect(both).not.toEqual(first);
    expect(await draw([regular])).toEqual(first);
    const loads = regularLoad.mock.calls.length;
    expect(await draw([{ ...regular }])).toEqual(first);
    expect(regularLoad).toHaveBeenCalledTimes(loads);
    expect(await draw([regular, heavy])).toEqual(both);
  });

  it('keeps an oversized image correct while evicting fonts between renders', async () => {
    // Distinct binaries matter: Takumi deduplicates identical font contents,
    // even when registered under different keys and family names.
    const count = Math.floor((8 * 1024 * 1024) / decodedFontSize) + 1;
    const fonts = Array.from({ length: count }, (_, index) => ({
      name: `Oversized${index}`,
      key: `oversized-${index}`,
      data: () => fontVariant(index),
      weight: 100 + index * 50,
    }));
    const node: Node = {
      type: 'container',
      style: { display: 'flex', flexDirection: 'column' },
      children: fonts.map((font) => ({
        ...text,
        style: { ...text.style, fontFamily: font.name, height: 40 },
      })),
    };
    const size = { ...options, height: count * 40 };
    const draw = () =>
      withImageRenderer(async (renderer) => {
        const bytes = await render(node, { ...size, fonts, renderer });
        expect(renderer.cacheStats().memory.current).toBeLessThanOrEqual(8 * 1024 * 1024);
        expect(renderer.cacheStats().fonts.evictions).toBeGreaterThan(0);
        return bytes;
      });
    const first = await draw();
    expect(await draw()).toEqual(first);

    // A budget smaller than this image's working set must still draw every face.
    const reference = new Renderer();
    try {
      expect(first).toEqual(await render(node, { ...size, fonts, renderer: reference }));
    } finally {
      reference.free();
    }
  });

  it('bounds a warm renderer during same-family font churn without changing pixels', async () => {
    let first: Uint8Array | undefined;
    let previousEvictions = 0;
    for (let index = 0; index < 80; index++) {
      await withImageRenderer(async (renderer) => {
        const bytes = await render(text, {
          ...options,
          renderer,
          fontFamilies: ['Churn'],
          fonts: [{ name: 'Churn', key: `churn-${index}`, data: () => fontVariant(index) }],
        });
        first ??= bytes;
        expect(bytes).toEqual(first);
        const stats = renderer.cacheStats();
        expect(stats.memory.current).toBeLessThanOrEqual(8 * 1024 * 1024);
        if (index === 39 || index === 79) {
          expect(stats.fonts.evictions).toBeGreaterThan(previousEvictions);
          previousEvictions = stats.fonts.evictions;
        }
      });
    }
  });

  it('isolates overlapping requests with different faces of the same family', async () => {
    const entered = deferred<void>();
    const finish = deferred<void>();
    const node: Node = {
      ...text,
      style: { ...text.style, fontFamily: 'Concurrent', fontWeight: 900 },
    };
    const regular = { name: 'Concurrent', key: 'concurrent-400', weight: 400, data: robotoData };
    const heavy = { name: 'Concurrent', key: 'concurrent-900', weight: 900, data: robotoData };
    const reference = new Renderer();
    try {
      const expectedRegular = await render(node, {
        ...options,
        fonts: [regular],
        renderer: reference,
      });
      const expectedHeavy = await render(node, { ...options, fonts: [heavy], renderer: reference });
      expect(expectedHeavy).not.toEqual(expectedRegular);
      const first = withImageRenderer((renderer) =>
        render(node, {
          ...options,
          renderer,
          fonts: [
            {
              ...regular,
              data: async () => {
                entered.resolve();
                await finish.promise;
                return robotoData();
              },
            },
          ],
        }),
      );
      await entered.promise;
      const second = await withImageRenderer((renderer) =>
        render(node, { ...options, fonts: [heavy], renderer }),
      );
      finish.resolve();
      expect(await first).toEqual(expectedRegular);
      expect(second).toEqual(expectedHeavy);
    } finally {
      finish.resolve();
      reference.free();
    }
  });

  it('isolates simultaneous images and retains only one idle renderer', async () => {
    const firstEntered = deferred<void>();
    const finishFirst = deferred<void>();
    let firstRenderer: Renderer;
    const first = withImageRenderer(async (renderer) => {
      firstRenderer = renderer;
      firstEntered.resolve();
      await finishFirst.promise;
      return render(text, { ...options, renderer });
    });
    await firstEntered.promise;
    const second = await withImageRenderer(async (renderer) => {
      expect(renderer).not.toBe(firstRenderer);
      return render(text, { ...options, renderer });
    });
    const free = vi.spyOn(firstRenderer!, 'free');
    finishFirst.resolve();
    expect(await first).toEqual(second);
    expect(free).toHaveBeenCalledOnce();
    free.mockRestore();
  });

  it.each(['download', 'decode'])(
    'waits for every font load after a %s failure',
    async (failure) => {
      const lateLoad = deferred<Uint8Array>();
      const loading = deferred<void>();
      const error = new Error('font download failed');
      const fonts: Array<FontLoader> = [
        {
          name: 'Failed',
          key: `failed-${failure}`,
          data: () => (failure === 'download' ? Promise.reject(error) : Uint8Array.of(0, 1, 2, 3)),
        },
        {
          name: 'Late',
          key: 'late-download',
          data: () => {
            loading.resolve();
            return lateLoad.promise;
          },
        },
      ];
      let returned = false;
      const image = withImageRenderer((renderer) => render(text, { ...options, fonts, renderer }));
      const result = image.catch((reason) => {
        returned = true;
        return reason;
      });
      await loading.promise;
      await setImmediate();
      expect(returned).toBe(false);
      // Fill the idle slot while the failed render still owns its renderer.
      // Its eventual return must free it only after the late loader finishes.
      const node: Node = { ...text, style: { ...text.style, fontFamily: 'Late', fontWeight: 900 } };
      const otherFonts = [{ name: 'Late', key: 'other-late', weight: 900, data: robotoData }];
      const reference = new Renderer();
      try {
        const other = await withImageRenderer((renderer) =>
          render(node, { ...options, fonts: otherFonts, renderer }),
        );
        expect(other).toEqual(
          await render(node, { ...options, fonts: otherFonts, renderer: reference }),
        );
      } finally {
        lateLoad.resolve(robotoData());
        reference.free();
      }
      if (failure === 'download') {
        expect(await result).toBe(error);
      } else {
        expect(await result).toBeInstanceOf(Error);
      }
      await expect(
        withImageRenderer((renderer) => render(text, { ...options, renderer })),
      ).resolves.toBeInstanceOf(Uint8Array);
    },
  );
});
import { setImmediate } from 'node:timers/promises';
