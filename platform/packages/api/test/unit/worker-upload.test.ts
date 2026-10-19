import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  blobWorkerModule,
  r2WorkerModule,
  withKnownLength,
  workerUploadBody,
  WorkerModuleIntegrityError,
} from '../../src/worker-upload.ts';

const encoder = new TextEncoder();

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Serves fixed objects in small chunks, like an R2 body. */
function bucket(objects: Record<string, Uint8Array>) {
  const opened: Array<string> = [];
  return {
    opened,
    get: async (key: string) => {
      const bytes = objects[key];
      if (!bytes) {
        return null;
      }
      opened.push(key);
      let offset = 0;
      return {
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= bytes.byteLength) {
              controller.close();
              return;
            }
            controller.enqueue(bytes.slice(offset, offset + 3));
            offset += 3;
          },
        }),
      };
    },
  } as unknown as Pick<R2Bucket, 'get'> & { opened: Array<string> };
}

const errors = { missing: 'module missing', changed: 'module changed' };

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

afterEach(() => {
  vi.unstubAllGlobals();
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
