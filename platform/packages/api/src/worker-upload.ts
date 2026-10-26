/**
 * Streaming access to user Worker modules.
 *
 * A Worker can carry 64 MiB of code plus source maps of any size, while one
 * API isolate has 128 MiB for every request it serves. Module bytes are
 * therefore never held whole: they pass through in chunks, and no module is
 * read into the body before its turn. An upload body may open a few later
 * modules early, bounded by count and declared size, so storage latency
 * overlaps the send instead of adding up module by module.
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

/** How far a stream may open sources ahead of the one it is reading. */
export type ReadAhead = Readonly<{ modules: number; bytes: number }>;

/**
 * An upload body opens up to 4 later modules, with at most 8 MiB of declared
 * size between them. The PUT holds one of the 6 connections a Worker may have
 * waiting for headers, so 4 storage reads leave one free for other I/O.
 */
export const WORKER_UPLOAD_READ_AHEAD: ReadAhead = { modules: 4, bytes: 8 * 1024 * 1024 };

/** An upload attempt is cut after this long without sending a body byte. */
export const WORKER_UPLOAD_IDLE_MS = 60_000;

/** An upload attempt is cut when Cloudflare has not answered this long after the body ended. */
export const WORKER_UPLOAD_RESPONSE_MS = 120_000;

/** All attempts of one application upload together get this long. */
export const WORKER_UPLOAD_BUDGET_MS = 480_000;

/** How far a tracked stream has got. Counts and times only. */
export type UploadProgress = Readonly<{
  /** Bytes enqueued so far, and the total the stream will produce. */
  bytes: number;
  length: number;
  sourcesStarted: number;
  sourcesTotal: number;
  /** Time spent waiting for a source to open or yield a chunk. */
  sourceWaitMs: number;
  /** Whether the stream is waiting for a source right now. */
  pulling: boolean;
  lastProgressAt: number;
  done: boolean;
  doneAt: number | undefined;
}>;

/** A stream that remembers the first failure of the sources it reads. */
export type TrackedStream = Readonly<{
  stream: ReadableStream<Uint8Array>;
  failure(): unknown;
  /**
   * Stop reading and cancel every open source, including those opened ahead.
   * The stream itself may be locked by its consumer, so this does not go
   * through `stream.cancel()`. Calling it again, or after the end, does nothing.
   */
  release(reason?: unknown): void;
  progress(): UploadProgress;
}>;

type Source = Readonly<{ size: number; open(): Promise<ReadableStream<Uint8Array>> }>;

const noop = () => {};

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
 * one chunk is in flight at a time, and a source's bytes are read only when
 * the stream reaches it. With `readAhead`, later sources open early, in order,
 * up to the given count and total declared size; the scan stops at the first
 * source that does not fit, so a source larger than the byte bound opens only
 * at its turn. An opened source is not read here before its turn, and its
 * failure surfaces only when the stream reaches it.
 *
 * Progress is counted when a chunk is enqueued. A consumer that pulls through
 * an identity transform takes the next chunk once it has sent the previous
 * one, so this follows the transport to within about one chunk.
 */
function sequence(
  pieces: ReadonlyArray<Uint8Array | Source>,
  readAhead: ReadAhead = { modules: 0, bytes: 0 },
): TrackedStream {
  let failure: unknown;
  let canceled = false;
  let releaseReason: unknown;
  let index = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  // Sources opened before their turn, in order.
  const ahead: Array<{ index: number; size: number; opened: Promise<ReadableStream<Uint8Array>> }> =
    [];
  let aheadBytes = 0;
  let nextToOpen = 0;

  let length = 0;
  let sourcesTotal = 0;
  for (const piece of pieces) {
    if (piece instanceof Uint8Array) {
      length += piece.byteLength;
    } else {
      length += piece.size;
      sourcesTotal++;
    }
  }
  let bytes = 0;
  let sourcesStarted = 0;
  let sourceWaitMs = 0;
  let pulling = false;
  let lastProgressAt = Date.now();
  let doneAt: number | undefined;

  const fill = () => {
    while (!canceled && nextToOpen < pieces.length) {
      const piece = pieces[nextToOpen]!;
      if (piece instanceof Uint8Array) {
        nextToOpen++;
        continue;
      }
      if (ahead.length >= readAhead.modules || aheadBytes + piece.size > readAhead.bytes) {
        return;
      }
      const opened = piece.open();
      // Its failure is thrown when the stream reaches it.
      opened.catch(noop);
      ahead.push({ index: nextToOpen, size: piece.size, opened });
      aheadBytes += piece.size;
      nextToOpen++;
    }
  };

  const release = (reason?: unknown) => {
    if (canceled) {
      return;
    }
    canceled = true;
    releaseReason = reason;
    reader?.cancel(reason).catch(noop);
    reader = undefined;
    for (const entry of ahead) {
      entry.opened.then((stream) => stream.cancel(reason).catch(noop), noop);
    }
    ahead.length = 0;
    aheadBytes = 0;
  };

  const waitFor = async <T>(promise: Promise<T>): Promise<T> => {
    const started = Date.now();
    pulling = true;
    try {
      return await promise;
    } finally {
      pulling = false;
      sourceWaitMs += Date.now() - started;
    }
  };

  const enqueue = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array) => {
    bytes += chunk.byteLength;
    lastProgressAt = Date.now();
    controller.enqueue(chunk);
  };

  const released = () => releaseReason ?? new Error('The stream was released.');

  return {
    failure: () => failure,
    release,
    progress: () => ({
      bytes,
      length,
      sourcesStarted,
      sourcesTotal,
      sourceWaitMs,
      pulling,
      lastProgressAt,
      done: doneAt !== undefined,
      doneAt,
    }),
    stream: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          for (;;) {
            if (canceled) {
              throw released();
            }
            if (reader) {
              const { done, value } = await waitFor(reader.read());
              if (!done) {
                enqueue(controller, value);
                fill();
                return;
              }
              reader = undefined;
            } else if (index === pieces.length) {
              controller.close();
              doneAt = Date.now();
              return;
            } else {
              const at = index++;
              const piece = pieces[at]!;
              if (piece instanceof Uint8Array) {
                enqueue(controller, piece);
                return;
              }
              sourcesStarted++;
              let opened: Promise<ReadableStream<Uint8Array>>;
              if (ahead[0]?.index === at) {
                const entry = ahead.shift()!;
                aheadBytes -= entry.size;
                opened = entry.opened;
              } else {
                opened = piece.open();
                nextToOpen = Math.max(nextToOpen, at + 1);
              }
              const stream = await waitFor(opened);
              if (canceled) {
                // Released while it opened: nothing else will cancel it.
                stream.cancel(releaseReason).catch(noop);
                throw released();
              }
              reader = stream.getReader();
              fill();
            }
          }
        } catch (error) {
          // A canceled reader's own errors are not source failures.
          if (!canceled) {
            failure ??= error;
          }
          release(error);
          throw error;
        }
      },
      cancel(reason) {
        release(reason);
      },
    }),
  };
}

/** Open one module for a single write, remembering a source failure. */
export function trackedModuleStream(module: WorkerModule): TrackedStream {
  return sequence([{ size: module.size, open: () => module.open() }]);
}

/** HTML multipart/form-data encoding of a part name or filename. */
function quoted(value: string): string {
  return value.replaceAll('"', '%22').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/**
 * The Workers script-upload body as a stream of known length: a `metadata`
 * part, then one part per module, with the part headers FormData writes (a
 * Blob without a filename is named "blob"). Modules open in order, a few
 * ahead of the one being sent (see `readAhead`), and each one's bytes are read
 * only when the body reaches it. A module failure stops the body before the
 * closing boundary, so the receiver never gets a complete form.
 */
export function workerUploadBody(
  metadata: unknown,
  modules: ReadonlyArray<WorkerModule>,
  readAhead: ReadAhead = WORKER_UPLOAD_READ_AHEAD,
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
  const pieces: Array<Uint8Array | Source> = [];
  for (const part of parts) {
    const header = encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(part.name)}"; filename="${quoted(part.filename)}"\r\nContent-Type: ${part.type}\r\n\r\n`,
    );
    pieces.push(header, { size: part.size, open: part.open }, new Uint8Array([13, 10]));
  }
  pieces.push(encoder.encode(`--${boundary}--\r\n`));
  const tracked = sequence(pieces, readAhead);
  return {
    ...tracked,
    contentType: `multipart/form-data; boundary=${boundary}`,
    length: tracked.progress().length,
  };
}

/** Which limit ended an upload: no progress, no answer, or the overall deadline. */
export type UploadTimeout = 'idle' | 'response' | 'deadline';

export type UploadWatchdog = Readonly<{
  signal: AbortSignal;
  fired(): UploadTimeout | undefined;
  /** For an idle timeout: whether the body was waiting on storage or on Cloudflare when it fired. */
  stalledOn(): 'storage' | 'cloudflare' | undefined;
  dispose(): void;
}>;

/**
 * Abort an upload that stops moving, rather than one that is merely large.
 * While the body is sent, the signal aborts `idleMs` after the last chunk;
 * once it has been sent, `responseMs` after its end; and in any case at
 * `deadline` (epoch ms). One timer is re-armed for the nearest of these.
 * Progress is counted per chunk, so a single chunk that takes longer than
 * `idleMs` to send looks idle; storage chunks are small enough for this.
 */
export function uploadWatchdog(
  progress: () => UploadProgress,
  limits: Readonly<{ idleMs: number; responseMs: number; deadline: number }>,
): UploadWatchdog {
  const controller = new AbortController();
  let fired: UploadTimeout | undefined;
  let stalledOn: 'storage' | 'cloudflare' | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    timer = undefined;
    const state = progress();
    let kind: UploadTimeout = 'deadline';
    let at = limits.deadline;
    const limit: [UploadTimeout, number] = state.done
      ? ['response', state.doneAt! + limits.responseMs]
      : ['idle', state.lastProgressAt + limits.idleMs];
    if (limit[1] < at) {
      [kind, at] = limit;
    }
    const now = Date.now();
    if (at > now) {
      timer = setTimeout(check, at - now);
      return;
    }
    fired = kind;
    if (kind === 'idle') {
      stalledOn = state.pulling ? 'storage' : 'cloudflare';
    }
    controller.abort(new DOMException(`The upload reached its ${kind} limit.`, 'TimeoutError'));
  };
  check();
  return {
    signal: controller.signal,
    fired: () => fired,
    stalledOn: () => stalledOn,
    dispose() {
      clearTimeout(timer);
      timer = undefined;
    },
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
