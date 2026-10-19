/**
 * Streaming access to user Worker modules.
 *
 * A Worker can carry 64 MiB of code plus source maps of any size, while one
 * API isolate has 128 MiB for every request it serves. Module bytes are
 * therefore never held whole: a module opens only when its turn comes and its
 * bytes pass through in chunks.
 */
import { createHash } from 'node:crypto';

/** One Worker module, opened only when its bytes are needed. */
export type WorkerModule = Readonly<{
  name: string;
  /** Multipart Content-Type Cloudflare uses to classify the module. */
  type: string;
  size: number;
  /** Lowercase hex SHA-256, when known before the bytes are read. */
  sha256?: string;
  open(): Promise<ReadableStream<Uint8Array>>;
}>;

/** Stored module bytes are missing or differ from their recorded size and digest. */
export class WorkerModuleIntegrityError extends Error {}

/** A stream that remembers the first failure of the sources it reads. */
export type TrackedStream = Readonly<{
  stream: ReadableStream<Uint8Array>;
  failure(): unknown;
}>;

export function blobWorkerModule(name: string, content: Blob): WorkerModule {
  return {
    name,
    type: content.type,
    size: content.size,
    open: async () => content.stream() as ReadableStream<Uint8Array>,
  };
}

/** A module stored in R2, checked against its size and digest as it streams. */
export function r2WorkerModule(
  bucket: Pick<R2Bucket, 'get'>,
  module: Readonly<{ name: string; key: string; type: string; size: number; sha256: string }>,
  errors: Readonly<{ missing: string; changed: string }>,
): WorkerModule {
  return {
    name: module.name,
    type: module.type,
    size: module.size,
    sha256: module.sha256,
    async open() {
      const object = await bucket.get(module.key);
      if (!object) {
        throw new WorkerModuleIntegrityError(errors.missing);
      }
      return verifiedStream(object.body, module.size, module.sha256, errors.changed);
    },
  };
}

/**
 * Pass `body` through while counting and hashing it. The stream errors as
 * soon as it runs past `size`, and before it ends when the size or digest
 * differs, so a reader never sees a complete copy of changed bytes.
 */
function verifiedStream(
  body: ReadableStream<Uint8Array>,
  size: number,
  sha256: string,
  message: string,
): ReadableStream<Uint8Array> {
  // node:crypto hashes incrementally in both workerd (nodejs_compat) and the
  // Node integration tests; crypto.DigestStream exists only in workerd.
  const hash = createHash('sha256');
  let received = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > size) {
          throw new WorkerModuleIntegrityError(message);
        }
        hash.update(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        if (received !== size || hash.digest('hex') !== sha256) {
          throw new WorkerModuleIntegrityError(message);
        }
      },
    }),
  );
}

/** Lowercase hex SHA-256 of a stream, read in chunks. */
export async function streamSha256(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hash = createHash('sha256');
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return hash.digest('hex');
    }
    hash.update(value);
  }
}

/**
 * Read byte pieces and lazily opened sources one after another. Pull-based:
 * a source opens only after the previous one ends, and one chunk is in
 * flight at a time.
 */
function sequence(
  pieces: ReadonlyArray<Uint8Array | (() => Promise<ReadableStream<Uint8Array>>)>,
): TrackedStream {
  let failure: unknown;
  let canceled = false;
  let index = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return {
    failure: () => failure,
    stream: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          for (;;) {
            if (reader) {
              const { done, value } = await reader.read();
              if (!done) {
                controller.enqueue(value);
                return;
              }
              reader = undefined;
            } else if (index === pieces.length) {
              controller.close();
              return;
            } else {
              const piece = pieces[index++]!;
              if (piece instanceof Uint8Array) {
                controller.enqueue(piece);
                return;
              }
              reader = (await piece()).getReader();
            }
          }
        } catch (error) {
          // A canceled reader's own errors are not source failures.
          if (!canceled) {
            failure ??= error;
          }
          throw error;
        }
      },
      async cancel(reason) {
        canceled = true;
        await reader?.cancel(reason).catch(() => {});
      },
    }),
  };
}

/** Open one module for a single write, remembering a source failure. */
export function trackedModuleStream(module: WorkerModule): TrackedStream {
  return sequence([() => module.open()]);
}

/** HTML multipart/form-data encoding of a part name or filename. */
function quoted(value: string): string {
  return value.replaceAll('"', '%22').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/**
 * The Workers script-upload body as a stream of known length: a `metadata`
 * part, then one part per module, with the part headers FormData writes (a
 * Blob without a filename is named "blob"). Each module opens only when the
 * body reaches it. A module failure stops the body before the closing
 * boundary, so the receiver never gets a complete form.
 */
export function workerUploadBody(
  metadata: unknown,
  modules: ReadonlyArray<WorkerModule>,
): TrackedStream & Readonly<{ contentType: string; length: number }> {
  const encoder = new TextEncoder();
  const boundary = `----VoidWorkerUpload${crypto.randomUUID().replaceAll('-', '')}`;
  const metadataBytes = encoder.encode(JSON.stringify(metadata));
  const parts = [
    {
      name: 'metadata',
      filename: 'blob',
      type: 'application/json',
      size: metadataBytes.byteLength,
      open: async () => new Blob([metadataBytes]).stream() as ReadableStream<Uint8Array>,
    },
    ...modules.map((module) => ({
      name: module.name,
      filename: module.name,
      type: module.type,
      size: module.size,
      open: () => module.open(),
    })),
  ];
  const pieces: Array<Uint8Array | (() => Promise<ReadableStream<Uint8Array>>)> = [];
  let length = 0;
  for (const part of parts) {
    const header = encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(part.name)}"; filename="${quoted(part.filename)}"\r\nContent-Type: ${part.type}\r\n\r\n`,
    );
    pieces.push(header, part.open, new Uint8Array([13, 10]));
    length += header.byteLength + part.size + 2;
  }
  const closing = encoder.encode(`--${boundary}--\r\n`);
  pieces.push(closing);
  length += closing.byteLength;
  return {
    ...sequence(pieces),
    contentType: `multipart/form-data; boundary=${boundary}`,
    length,
  };
}

/**
 * Give a stream the exact length it will produce. Workers send a stream
 * without one chunked, and R2 refuses to store one. A FixedLengthStream sends
 * Content-Length and fails if the stream ends short or runs long. Node, where
 * the integration tests run, has no FixedLengthStream and takes the stream as is.
 */
export function withKnownLength(
  stream: ReadableStream<Uint8Array>,
  length: number,
): ReadableStream<Uint8Array> {
  if (typeof FixedLengthStream !== 'function') {
    return stream;
  }
  const fixed = new FixedLengthStream(length);
  stream.pipeTo(fixed.writable).catch(() => {
    // The readable side reports the failed pipe to whoever reads it.
  });
  return fixed.readable as ReadableStream<Uint8Array>;
}

/** Every object under `prefix`, keyed by its full key, in paginated listings. */
export async function listR2Objects(
  bucket: Pick<R2Bucket, 'list'>,
  prefix: string,
): Promise<Map<string, Readonly<{ size: number; uploaded: Date }>>> {
  const objects = new Map<string, Readonly<{ size: number; uploaded: Date }>>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const object of page.objects) {
      objects.set(object.key, { size: object.size, uploaded: object.uploaded });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return objects;
}
