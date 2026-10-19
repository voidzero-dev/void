import { afterEach, expect, it, vi } from 'vite-plus/test';
import {
  putDurableSnapshotModule,
  putDurableSnapshotObject,
  snapshotDigest,
} from '../../src/provisioning/durable-snapshot.ts';
import { r2WorkerModule } from '../../src/worker-upload.ts';
const value = new TextEncoder().encode('immutable release');
function fixture() {
  let stored: Uint8Array | undefined;
  const put = vi.fn(async (_key: string, bytes: Uint8Array) => {
    if (stored) {
      return null;
    }
    stored = bytes;
    return {};
  });
  const get = vi.fn(async () =>
    stored ? { body: new Blob([new Uint8Array(stored)]).stream() } : null,
  );
  return {
    bucket: { put, get } as unknown as Pick<R2Bucket, 'put' | 'get'>,
    put,
    get,
    set: (bytes: Uint8Array) => {
      stored = bytes;
    },
  };
}
afterEach(() => vi.useRealTimers());

it('accepts a landed write whose acknowledgement was lost without writing it again', async () => {
  const f = fixture();
  f.put.mockImplementationOnce(async () => {
    f.set(value);
    throw Error('put: internal error (10001)');
  });
  await putDurableSnapshotObject(f.bucket, 'release/module.js', value);
  expect(f.put).toHaveBeenCalledOnce();
  expect(f.get).toHaveBeenCalledOnce();
  expect(f.put.mock.calls[0]).toEqual([
    'release/module.js',
    value,
    { onlyIf: { etagDoesNotMatch: '*' } },
  ]);
});

it('retries a failed write only after confirming that the object is absent', async () => {
  const digest = await snapshotDigest(value);
  vi.useFakeTimers();
  const f = fixture();
  f.put.mockRejectedValueOnce(Error('put: internal error (10001)'));
  const result = putDurableSnapshotObject(f.bucket, 'release/module.js', value, digest);
  await vi.advanceTimersByTimeAsync(200);
  await result;
  expect(f.put).toHaveBeenCalledTimes(2);
  expect(f.get).toHaveBeenCalledOnce();
});

it('rejects changed existing bytes and never overwrites them', async () => {
  const f = fixture();
  f.set(new TextEncoder().encode('other release'));
  await expect(putDurableSnapshotObject(f.bucket, 'release/module.js', value)).rejects.toThrow(
    'snapshot changed',
  );
  expect(f.put).toHaveBeenCalledOnce();
});

it('does not retry when inspection fails after an ambiguous write', async () => {
  const f = fixture();
  f.put.mockRejectedValueOnce(Error('put failed'));
  f.get.mockRejectedValueOnce(Error('read failed'));
  await expect(putDurableSnapshotObject(f.bucket, 'release/module.js', value)).rejects.toThrow(
    'read failed',
  );
  expect(f.put).toHaveBeenCalledOnce();
});

it('bounds persistent failures after three inspected attempts', async () => {
  const digest = await snapshotDigest(value);
  vi.useFakeTimers();
  const f = fixture();
  f.put.mockRejectedValue(Error('put failed'));
  const result = expect(
    putDurableSnapshotObject(f.bucket, 'release/module.js', value, digest),
  ).rejects.toThrow('Could not store');
  await vi.advanceTimersByTimeAsync(600);
  await result;
  expect(f.put).toHaveBeenCalledTimes(3);
  expect(f.get).toHaveBeenCalledTimes(3);
});

it('stops without retrying when a streamed module fails its integrity check', async () => {
  const digest = await snapshotDigest(value);
  const source = {
    get: async () => ({ body: new Blob(['changed']).stream() }),
  } as unknown as Pick<R2Bucket, 'get'>;
  const module = r2WorkerModule(
    source,
    {
      name: 'index.js',
      key: 'input/0',
      type: 'application/javascript+module',
      size: value.byteLength,
      sha256: digest,
    },
    { missing: 'module missing', changed: 'module changed' },
  );
  const put = vi.fn(async (_key: string, body: ReadableStream<Uint8Array>) => {
    await new Response(body).arrayBuffer();
    return {};
  });
  const get = vi.fn();
  await expect(
    putDurableSnapshotModule(
      { put, get } as unknown as Pick<R2Bucket, 'put' | 'get'>,
      'release/index.js',
      module,
      digest,
    ),
  ).rejects.toThrow('module changed');
  expect(put).toHaveBeenCalledOnce();
  expect(get).not.toHaveBeenCalled();
});

it('accepts an identical existing object after its conditional write is rejected', async () => {
  const f = fixture();
  f.set(value);
  await putDurableSnapshotObject(f.bucket, 'release/module.js', value);
  expect(f.put).toHaveBeenCalledOnce();
  expect(f.get).toHaveBeenCalledOnce();
});
