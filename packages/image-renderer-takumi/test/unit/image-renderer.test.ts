import { render, type FontLoader, type Node } from 'takumi-js';
import { Renderer } from 'takumi-js/wasm/no-init';
import { describe, expect, it, vi } from 'vite-plus/test';
import { withImageRenderer } from '../../src/image-renderer.ts';
import { robotoData } from '../../src/roboto-font.ts';

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

  it('keeps an oversized image correct, then releases its fonts', async () => {
    const load = vi.fn(robotoData);
    // WOFF2 stores the decoded SFNT size in its header. Exceed the 8 MiB budget
    // even if the bundled font changes size.
    const bytes = robotoData();
    const decodedSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      16,
    );
    const count = Math.floor((8 * 1024 * 1024) / decodedSize) + 1;
    const fonts = Array.from({ length: count }, (_, index) => ({
      name: `Oversized${index}`,
      key: `oversized-${index}`,
      data: load,
      weight: 100 + index * 50,
    }));
    const node: Node = {
      type: 'container',
      children: fonts.map((font) => ({
        ...text,
        style: { ...text.style, fontFamily: font.name },
      })),
    };
    const draw = () =>
      withImageRenderer((renderer) => render(node, { ...options, fonts, renderer }));
    const first = await draw();
    expect(load).toHaveBeenCalledTimes(count);
    expect(await draw()).toEqual(first);
    expect(load).toHaveBeenCalledTimes(count * 2);

    // Compare with an unbounded renderer: merely limiting Takumi's font cache
    // would evict some of this image's families before it draws them.
    const reference = new Renderer();
    try {
      expect(first).toEqual(await render(node, { ...options, fonts, renderer: reference }));
    } finally {
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

  it('waits for every font load before returning a failed image’s renderer', async () => {
    const lateLoad = deferred<Uint8Array>();
    const loading = deferred<void>();
    const error = new Error('font download failed');
    const fonts: Array<FontLoader> = [
      { name: 'Failed', key: 'failed-download', data: () => Promise.reject(error) },
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
    await Promise.resolve();
    expect(returned).toBe(false);
    lateLoad.resolve(robotoData());
    expect(await result).toBe(error);
    await expect(
      withImageRenderer((renderer) => render(text, { ...options, renderer })),
    ).resolves.toBeInstanceOf(Uint8Array);
  });
});
