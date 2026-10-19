import {
  streamSha256,
  trackedModuleStream,
  withKnownLength,
  WorkerModuleIntegrityError,
  type WorkerModule,
} from '../worker-upload.ts';

export async function snapshotDigest(value: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = new Uint8Array(
    typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : value,
  );
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

type SnapshotBody = Readonly<{
  value: string | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>;
  failure?: () => unknown;
}>;

/** Immutable release writes can be recovered after a lost R2 acknowledgement. */
export async function putDurableSnapshotObject(
  bucket: Pick<R2Bucket, 'put' | 'get'>,
  key: string,
  value: string | ArrayBuffer | Uint8Array,
  digest?: string,
): Promise<void> {
  await putVerifiedSnapshotObject(bucket, key, digest ?? (await snapshotDigest(value)), () => ({
    value,
  }));
}

/** Stream one Worker module into an immutable release copy. */
export async function putDurableSnapshotModule(
  bucket: Pick<R2Bucket, 'put' | 'get'>,
  key: string,
  module: WorkerModule,
  digest: string,
): Promise<void> {
  await putVerifiedSnapshotObject(bucket, key, digest, () => {
    // A stream is written once, so every attempt reopens the module.
    const source = trackedModuleStream(module);
    return { value: withKnownLength(source.stream, module.size), failure: source.failure };
  });
}

async function putVerifiedSnapshotObject(
  bucket: Pick<R2Bucket, 'put' | 'get'>,
  key: string,
  expected: string,
  body: () => SnapshotBody,
): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { value, failure: sourceFailure } = body();
    try {
      const written = await bucket.put(key, value, { onlyIf: { etagDoesNotMatch: '*' } });
      if (written) {
        return;
      }
    } catch (error) {
      // Source bytes that fail their integrity check fail every retry too.
      const integrity = sourceFailure?.();
      if (integrity instanceof WorkerModuleIntegrityError) {
        throw integrity;
      }
      failure = error;
    }
    // R2 reads are strongly consistent. Verify an acknowledged or ambiguous
    // write before accepting it; the condition also fences any late PUT.
    const stored = await bucket.get(key);
    if (stored) {
      if ((await streamSha256(stored.body)) === expected) {
        return;
      }
      throw new Error(`Custom Durable Object release snapshot changed: ${key}`);
    }
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }
  }
  throw new Error(`Could not store custom Durable Object release snapshot: ${key}`, {
    cause: failure,
  });
}
