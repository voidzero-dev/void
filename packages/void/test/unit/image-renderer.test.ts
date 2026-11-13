import { render, type FontLoader, type Node } from 'takumi-js';
import { Renderer } from 'takumi-js/wasm/no-init';
import { describe, expect, it, vi } from 'vite-plus/test';
import { interData } from '../../src/runtime/image-inter.ts';
import { withImageRenderer } from '../../src/runtime/image-renderer.ts';

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
  it('keeps an oversized image correct, then releases its fonts', async () => {
    const load = vi.fn(interData);
    const fonts = Array.from({ length: 16 }, (_, index) => ({
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
    expect(load).toHaveBeenCalledTimes(16);
    expect(await draw()).toEqual(first);
    expect(load).toHaveBeenCalledTimes(32);

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
    lateLoad.resolve(interData());
    expect(await result).toBe(error);
    await expect(
      withImageRenderer((renderer) => render(text, { ...options, renderer })),
    ).resolves.toBeInstanceOf(Uint8Array);
  });
});
