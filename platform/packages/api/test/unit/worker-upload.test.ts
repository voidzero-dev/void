import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  blobWorkerModule,
  r2WorkerModule,
  uploadWatchdog,
  withKnownLength,
  workerUploadBody,
  WorkerModuleIntegrityError,
  type UploadProgress,
  type WorkerModule,
} from '../../src/worker-upload.ts';

const encoder = new TextEncoder();

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Serves fixed objects in small chunks, like an R2 body. It records which
 * keys were requested and opened, how many chunks each body gave up, which
 * bodies ended or were canceled, and can hold `get()` until released.
 */
function bucket(
  objects: Record<string, Uint8Array>,
  options: { chunk?: number; hold?: (key: string) => boolean } = {},
) {
  const chunk = options.chunk ?? 3;
  const state = {
    requested: [] as Array<string>,
    opened: [] as Array<string>,
    pulledChunks: {} as Record<string, number>,
    pulledBytes: {} as Record<string, number>,
    ended: new Set<string>(),
    canceled: [] as Array<string>,
    pending: 0,
    maxPending: 0,
    held: new Map<string, () => void>(),
    /** Each get() call, with the keys whose bodies had ended at that moment. */
    gets: [] as Array<{ key: string; ended: Array<string> }>,
    release(key: string) {
      state.held.get(key)?.();
      state.held.delete(key);
    },
  };
  return Object.assign(state, {
    get: async (key: string) => {
      state.requested.push(key);
      state.gets.push({ key, ended: [...state.ended] });
      state.pending++;
      state.maxPending = Math.max(state.maxPending, state.pending);
      try {
        if (options.hold?.(key)) {
          await new Promise<void>((resolve) => state.held.set(key, resolve));
        }
      } finally {
        state.pending--;
      }
      const bytes = objects[key];
      if (!bytes) {
        return null;
      }
      state.opened.push(key);
      state.pulledChunks[key] = 0;
      state.pulledBytes[key] = 0;
      let offset = 0;
      return {
        size: bytes.byteLength,
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= bytes.byteLength) {
              state.ended.add(key);
              controller.close();
              return;
            }
            const value = bytes.slice(offset, offset + chunk);
            offset += value.byteLength;
            state.pulledChunks[key]!++;
            state.pulledBytes[key]! += value.byteLength;
            controller.enqueue(value);
          },
          cancel() {
            state.canceled.push(key);
          },
        }),
      };
    },
  }) as unknown as Pick<R2Bucket, 'get'> & typeof state;
}

const errors = { missing: 'module missing', changed: 'module changed' };

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(chunks: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** `count` R2 modules named m0, m1, ... stored at in/0, in/1, ... */
function storedModules(
  sizes: ReadonlyArray<number>,
  options: Parameters<typeof bucket>[1] = {},
  stored: (index: number, bytes: Uint8Array) => Uint8Array | undefined = (_index, bytes) => bytes,
) {
  const contents = sizes.map((size, index) =>
    Uint8Array.from({ length: size }, (_, offset) => (index * 31 + offset) % 251),
  );
  const objects: Record<string, Uint8Array> = {};
  contents.forEach((bytes, index) => {
    const value = stored(index, bytes);
    if (value) {
      objects[`in/${index}`] = value;
    }
  });
  const r2 = bucket(objects, options);
  const modules: Array<WorkerModule> = contents.map((bytes, index) =>
    r2WorkerModule(
      r2,
      {
        name: `m${index}`,
        key: `in/${index}`,
        type: 'application/octet-stream',
        size: bytes.byteLength,
        sha256: sha256(bytes),
      },
      errors,
    ),
  );
  return { r2, modules, contents };
}

async function expectSameForm(
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
  contents: ReadonlyArray<Uint8Array>,
) {
  const form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData();
  expect([...form.keys()]).toEqual(['metadata', ...contents.map((_, index) => `m${index}`)]);
  for (const [index, expected] of contents.entries()) {
    expect(new Uint8Array(await (form.get(`m${index}`) as File).arrayBuffer())).toEqual(expected);
  }
}

const ticks = async (count = 10) => {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('workerUploadBody', () => {
  it('declares the exact length it streams and keeps every part byte-identical', async () => {
    const code = encoder.encode('export default {};');
    const map = encoder.encode('{"version":3,"mappings":""}');
    const wasm = Uint8Array.from({ length: 256 }, (_, index) => index);
    const objects = { 'in/0': code, 'in/1': map };
    const r2 = bucket(objects);
    const modules = [
      r2WorkerModule(
        r2,
        {
          name: 'index.js',
          key: 'in/0',
          type: 'application/javascript+module',
          size: code.byteLength,
          sha256: sha256(code),
        },
        errors,
      ),
      // Names may carry quotes and non-ASCII characters.
      r2WorkerModule(
        r2,
        {
          name: 'chunks/ü"x.js.map',
          key: 'in/1',
          type: 'application/source-map',
          size: map.byteLength,
          sha256: sha256(map),
        },
        errors,
      ),
      blobWorkerModule('add.wasm', new Blob([wasm], { type: 'application/wasm' })),
    ];
    const upload = workerUploadBody({ main_module: 'index.js' }, modules);
    // No module opens before the body is read.
    expect(r2.opened).toEqual([]);
    const bytes = await readAll(upload.stream);
    expect(bytes.byteLength).toBe(upload.length);
    expect(upload.failure()).toBeUndefined();

    const form = await new Response(bytes, {
      headers: { 'content-type': upload.contentType },
    }).formData();
    const metadata = form.get('metadata') as File;
    expect(metadata.type).toBe('application/json');
    expect(JSON.parse(await metadata.text())).toEqual({ main_module: 'index.js' });
    const parts = [...form.keys()];
    expect(parts).toEqual(['metadata', 'index.js', 'chunks/ü"x.js.map', 'add.wasm']);
    for (const [name, expected, type] of [
      ['index.js', code, 'application/javascript+module'],
      ['chunks/ü"x.js.map', map, 'application/source-map'],
      ['add.wasm', wasm, 'application/wasm'],
    ] as const) {
      const file = form.get(name) as File;
      expect(file.type).toBe(type);
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(expected);
    }
  });

  it.each([
    ['same-size different bytes', encoder.encode('export default {!};')],
    ['longer bytes', encoder.encode('export default {}; // more')],
    ['shorter bytes', encoder.encode('export {};')],
  ])('stops before the closing boundary when a stored module has %s', async (_case, stored) => {
    const expected = encoder.encode('export default {};');
    const r2 = bucket({ 'in/0': stored });
    const upload = workerUploadBody({}, [
      r2WorkerModule(
        r2,
        {
          name: 'index.js',
          key: 'in/0',
          type: 'application/javascript+module',
          size: expected.byteLength,
          sha256: sha256(expected),
        },
        errors,
      ),
    ]);
    const reader = upload.stream.getReader();
    const received: Array<Uint8Array> = [];
    let failure: unknown;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        received.push(value);
      }
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(WorkerModuleIntegrityError);
    expect((failure as Error).message).toBe('module changed');
    expect(upload.failure()).toBe(failure);
    const decoder = new TextDecoder();
    const text =
      received.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
    const boundary = upload.contentType.split('boundary=')[1]!;
    expect(text).not.toContain(`--${boundary}--`);
    // A longer object never passes more bytes than the declared size.
    expect(text).not.toContain('more');
  });

  it('opens nothing before the first read', async () => {
    const { r2, modules } = storedModules([4, 4]);
    workerUploadBody({}, modules);
    await ticks();
    expect(r2.requested).toEqual([]);
  });

  it('opens later modules ahead, in order, bounded by count', async () => {
    const { r2, modules, contents } = storedModules(Array(10).fill(9), { hold: () => true });
    const upload = workerUploadBody({}, modules);
    const reader = upload.stream.getReader();
    const chunks: Array<Uint8Array> = [];
    const read = async () => {
      const { done, value } = await reader.read();
      if (!done) {
        chunks.push(value);
      }
      return done;
    };
    // The metadata part header, its bytes, CRLF and the m0 part header.
    for (let i = 0; i < 4; i++) {
      await read();
    }
    expect(r2.requested).toEqual(['in/0', 'in/1', 'in/2', 'in/3']);
    const firstOfM0 = read();
    await ticks();
    for (const key of ['in/3', 'in/2', 'in/1', 'in/0']) {
      r2.release(key);
      await ticks();
    }
    await firstOfM0;
    expect(r2.requested).toEqual(['in/0', 'in/1', 'in/2', 'in/3', 'in/4']);
    expect(r2.requested).not.toContain('in/5');
    // Release every later get as soon as it is made.
    const releaser = setInterval(() => {
      for (const key of r2.held.keys()) {
        r2.release(key);
      }
    }, 0);
    try {
      while (!(await read())) {
        // Read to the end.
      }
    } finally {
      clearInterval(releaser);
    }
    expect(r2.requested).toEqual(contents.map((_, index) => `in/${index}`));
    expect(r2.maxPending).toBeLessThanOrEqual(5);
    const bytes = concat(chunks);
    expect(bytes.byteLength).toBe(upload.length);
    expect(upload.failure()).toBeUndefined();
    await expectSameForm(bytes, upload.contentType, contents);
  });

  it('stops at the byte budget and never skips a module', async () => {
    const { r2, modules, contents } = storedModules([10, 10, 10, 100, 10], { chunk: 2 });
    const upload = workerUploadBody({}, modules, { modules: 8, bytes: 25 });
    const bytes = await readAll(upload.stream);
    expect(bytes.byteLength).toBe(upload.length);
    await expectSameForm(bytes, upload.contentType, contents);
    const at = (key: string) => r2.gets.find((get) => get.key === key)!.ended;
    expect(r2.gets.map((get) => get.key)).toEqual(['in/0', 'in/1', 'in/2', 'in/3', 'in/4']);
    // m1 and m2 open while m0 still streams.
    expect(at('in/2')).not.toContain('in/0');
    // m3 is larger than the budget: it opens only once m2 has ended.
    expect(at('in/3')).toEqual(expect.arrayContaining(['in/0', 'in/1', 'in/2']));
    // m4 opens ahead while m3 streams.
    expect(at('in/4')).not.toContain('in/3');
  });

  it('never buffers whole modules', async () => {
    const kib = 1024;
    const { r2, modules, contents } = storedModules(Array(5).fill(64 * kib), { chunk: kib });
    const upload = workerUploadBody({}, modules);
    const reader = upload.stream.getReader();
    const chunks: Array<Uint8Array> = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      received += value.byteLength;
      // The first module not yet fully pulled may be the one being read;
      // any module opened after it has given up at most two chunks.
      const open = r2.opened.filter((key) => !r2.ended.has(key));
      for (const key of open.slice(1)) {
        expect(r2.pulledChunks[key]).toBeLessThanOrEqual(2);
      }
      const pulled = Object.values(r2.pulledBytes).reduce((total, value) => total + value, 0);
      expect(pulled - received).toBeLessThanOrEqual((1 + 4) * 2 * kib);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await expectSameForm(concat(chunks), upload.contentType, contents);
  });

  it.each([
    ['missing', () => undefined],
    ['changed', (bytes: Uint8Array) => bytes.map((byte) => byte ^ 1)],
  ])('surfaces a %s module opened ahead only at its turn', async (_case, change) => {
    const { modules, contents } = storedModules([6, 6, 6, 6], {}, (index, bytes) =>
      index === 3 ? change(bytes) : bytes,
    );
    const upload = workerUploadBody({}, modules);
    const reader = upload.stream.getReader();
    const received: Array<Uint8Array> = [];
    let failure: unknown;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        received.push(value);
      }
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(WorkerModuleIntegrityError);
    expect(upload.failure()).toBe(failure);
    const text = Buffer.from(concat(received)).toString('latin1');
    for (const bytes of contents.slice(0, 3)) {
      expect(text).toContain(Buffer.from(bytes).toString('latin1'));
    }
    const boundary = upload.contentType.split('boundary=')[1]!;
    expect(text).not.toContain(`--${boundary}--`);
  });

  it.each([
    [
      'release()',
      (upload: ReturnType<typeof workerUploadBody>, reader: ReadableStreamDefaultReader) => {
        upload.release(new Error('stop'));
        void reader.closed.catch(() => {});
      },
    ],
    [
      'reader.cancel()',
      (_upload: ReturnType<typeof workerUploadBody>, reader: ReadableStreamDefaultReader) => {
        void reader.cancel(new Error('stop'));
      },
    ],
  ])('%s cancels the current and opened-ahead sources', async (_case, stop) => {
    const { r2, modules } = storedModules(Array(6).fill(9), { hold: (key) => key === 'in/4' });
    const upload = workerUploadBody({}, modules);
    const reader = upload.stream.getReader();
    // Up to the first chunk of m0, which opens m1..m4 ahead.
    for (let i = 0; i < 5; i++) {
      await reader.read();
    }
    expect(r2.requested).toEqual(['in/0', 'in/1', 'in/2', 'in/3', 'in/4']);
    stop(upload, reader);
    await ticks(20);
    expect([...r2.canceled].sort()).toEqual(['in/0', 'in/1', 'in/2', 'in/3']);
    // The held get resolves after the release; its body is canceled too.
    r2.release('in/4');
    await ticks(20);
    expect([...r2.canceled].sort()).toEqual(['in/0', 'in/1', 'in/2', 'in/3', 'in/4']);
    expect(r2.requested).not.toContain('in/5');
    expect(upload.failure()).toBeUndefined();
  });

  it('reports a module missing from storage', async () => {
    const upload = workerUploadBody({}, [
      r2WorkerModule(
        bucket({}),
        {
          name: 'index.js',
          key: 'in/0',
          type: 'application/javascript+module',
          size: 1,
          sha256: 'a'.repeat(64),
        },
        errors,
      ),
    ]);
    await expect(readAll(upload.stream)).rejects.toThrow('module missing');
    expect(upload.failure()).toBeInstanceOf(WorkerModuleIntegrityError);
  });
});

describe('withKnownLength', () => {
  it('declares the length to a FixedLengthStream where the runtime has one', async () => {
    const declared: Array<number> = [];
    vi.stubGlobal(
      'FixedLengthStream',
      class {
        readonly readable: ReadableStream;
        readonly writable: WritableStream;
        constructor(length: number) {
          declared.push(length);
          ({ readable: this.readable, writable: this.writable } = new TransformStream());
        }
      },
    );
    const upload = workerUploadBody({}, [
      blobWorkerModule('index.js', new Blob(['export default {};'])),
    ]);
    const bytes = await readAll(withKnownLength(upload.stream, upload.length));
    expect(declared).toEqual([upload.length]);
    expect(bytes.byteLength).toBe(upload.length);
  });
});

function progressAt(lastProgressAt: number, doneAt?: number): UploadProgress {
  return {
    bytes: 0,
    length: 0,
    sourcesStarted: 0,
    sourcesTotal: 0,
    sourceWaitMs: 0,
    pulling: false,
    lastProgressAt,
    done: doneAt !== undefined,
    doneAt,
  };
}

describe('uploadWatchdog', () => {
  const limits = { idleMs: 60_000, responseMs: 120_000 };

  it('keeps a slow upload that keeps moving', async () => {
    vi.useFakeTimers({ now: 0 });
    let progress = progressAt(0);
    const watchdog = uploadWatchdog(() => progress, { ...limits, deadline: 480_000 });
    for (let at = 50_000; at <= 400_000; at += 50_000) {
      await vi.advanceTimersByTimeAsync(50_000);
      progress = progressAt(Date.now());
    }
    expect(watchdog.signal.aborted).toBe(false);
    expect(watchdog.fired()).toBeUndefined();
    watchdog.dispose();
  });

  it('aborts a stalled storage read', async () => {
    // Real setImmediate lets the body run up to the stall.
    vi.useFakeTimers({ now: 0, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { r2, modules } = storedModules([6, 6, 6], { hold: (key) => key === 'in/1' });
    const upload = workerUploadBody({}, modules);
    const watchdog = uploadWatchdog(upload.progress, { ...limits, deadline: 480_000 });
    const reader = upload.stream.getReader();
    const drained = (async () => {
      for (;;) {
        if ((await reader.read()).done) {
          return;
        }
      }
    })();
    drained.catch(() => {});
    // Let the body run up to m1, whose get never answers.
    while (upload.progress().sourcesStarted < 3) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(upload.progress().lastProgressAt).toBe(0);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(upload.progress().pulling).toBe(true);
    expect(watchdog.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(watchdog.signal.aborted).toBe(true);
    expect((watchdog.signal.reason as Error).name).toBe('TimeoutError');
    expect(watchdog.fired()).toBe('idle');
    expect(watchdog.stalledOn()).toBe('storage');
    expect(upload.progress().pulling).toBe(true);
    upload.release(watchdog.signal.reason);
    r2.release('in/1');
    await vi.advanceTimersByTimeAsync(0);
    expect(r2.canceled).toContain('in/1');
    await expect(drained).rejects.toThrow();
    watchdog.dispose();
  });

  it('reports a stall on the Cloudflare side when the body is not read', async () => {
    vi.useFakeTimers({ now: 0 });
    const { modules } = storedModules([6, 6]);
    const upload = workerUploadBody({}, modules);
    const watchdog = uploadWatchdog(upload.progress, { ...limits, deadline: 480_000 });
    const reader = upload.stream.getReader();
    await reader.read();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(watchdog.fired()).toBe('idle');
    expect(watchdog.stalledOn()).toBe('cloudflare');
    expect(upload.progress().pulling).toBe(false);
    upload.release();
    watchdog.dispose();
  });

  it('limits the wait for the response once the body is sent', async () => {
    vi.useFakeTimers({ now: 0 });
    const { modules } = storedModules([6, 6]);
    const upload = workerUploadBody({}, modules);
    const watchdog = uploadWatchdog(upload.progress, { ...limits, deadline: 480_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    await readAll(upload.stream);
    expect(upload.progress().doneAt).toBe(10_000);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(watchdog.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(watchdog.fired()).toBe('response');
    watchdog.dispose();
  });

  it('aborts at the deadline even while the upload moves', async () => {
    vi.useFakeTimers({ now: 0 });
    let progress = progressAt(0);
    const watchdog = uploadWatchdog(() => progress, { ...limits, deadline: 30_000 });
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      progress = progressAt(Date.now());
    }
    await vi.advanceTimersByTimeAsync(9_999);
    expect(watchdog.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(watchdog.fired()).toBe('deadline');
    watchdog.dispose();
  });

  it('leaves no timer behind once disposed', () => {
    vi.useFakeTimers({ now: 0 });
    const watchdog = uploadWatchdog(() => progressAt(0), { ...limits, deadline: 480_000 });
    expect(vi.getTimerCount()).toBe(1);
    watchdog.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
