/**
 * Reads a GitHub source tarball (`git archive` output, gzip) one entry at a time,
 * for the T1 source diff (design doc 0095, M11). Hand-written ustar / pax reader:
 * no dependency, no regex, nothing held but the entry being read.
 *
 *   gzip ─► 512-byte headers ─► pax `path` / `size`, GNU long name, ustar prefix
 *        └► regular files only, the top folder (`owner-repo-sha/`) cut off
 *
 * Links, devices and folders are skipped. A name with an empty, `.` or `..` part,
 * or one starting with `/`, is skipped too: the archive is not trusted.
 */

const BLOCK = 512;
const MAX_EXTENDED_HEADER_BYTES = 1024 * 1024;
const decoder = new TextDecoder();

export class SourceTarballError extends Error {}

/** The archive holds more than the limits allow; the scan falls back to T2. */
export class SourceTarballTooLarge extends SourceTarballError {}

export type SourceTarballLimits = Readonly<{
  /** Regular files, at most. */
  maxFiles: number;
  /** Bytes of all regular files, uncompressed. */
  maxBytes: number;
}>;

export type SourceTarballEntry = Readonly<{ path: string; size: number }>;

/**
 * Called for each regular file. Return a sink to get its bytes (called once per
 * chunk, then with `null` at the end), or `null` to skip it.
 */
export type SourceTarballVisitor = (
  entry: SourceTarballEntry,
) => ((chunk: Uint8Array | null) => void) | null;

/** Reads `n` bytes at a time from a byte stream, keeping what is left over. */
class StreamBytes {
  private pending: Uint8Array = new Uint8Array(0);
  private done = false;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(): Promise<boolean> {
    if (this.done) {
      return false;
    }
    const { value, done } = await this.reader.read();
    if (done) {
      this.done = true;
      return false;
    }
    if (value.length === 0) {
      return true;
    }
    if (this.pending.length === 0) {
      this.pending = value;
    } else {
      const joined = new Uint8Array(this.pending.length + value.length);
      joined.set(this.pending);
      joined.set(value, this.pending.length);
      this.pending = joined;
    }
    return true;
  }

  /** Exactly `n` bytes, or `null` when the stream ends first. */
  async take(n: number): Promise<Uint8Array | null> {
    while (this.pending.length < n) {
      if (!(await this.fill())) {
        return null;
      }
    }
    const out = this.pending.subarray(0, n);
    this.pending = this.pending.subarray(n);
    return out;
  }

  /** Hands `n` bytes to `sink` as they come (or drops them), then skips `pad` more. */
  async pipe(n: number, pad: number, sink: ((chunk: Uint8Array) => void) | null): Promise<void> {
    let left = n;
    while (left > 0) {
      if (this.pending.length === 0 && !(await this.fill())) {
        throw new SourceTarballError('the source archive ends inside a file');
      }
      const size = Math.min(left, this.pending.length);
      sink?.(this.pending.subarray(0, size));
      this.pending = this.pending.subarray(size);
      left -= size;
    }
    if (pad > 0 && (await this.take(pad)) === null) {
      throw new SourceTarballError('the source archive ends inside a file');
    }
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => {});
  }
}

function cString(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  while (end < offset + length && block[end] !== 0) {
    end++;
  }
  return decoder.decode(block.subarray(offset, end));
}

/** An octal number field, or a base-256 one (high bit set) for large sizes. */
function numberField(block: Uint8Array, offset: number, length: number): number {
  if ((block[offset]! & 0x80) !== 0) {
    let value = block[offset]! & 0x7f;
    for (let index = offset + 1; index < offset + length; index++) {
      value = value * 256 + block[index]!;
    }
    return value;
  }
  let value = 0;
  let seen = false;
  for (let index = offset; index < offset + length; index++) {
    const byte = block[index]!;
    if (byte === 0 || byte === 0x20) {
      if (seen) {
        break;
      }
      continue;
    }
    if (byte < 0x30 || byte > 0x37) {
      throw new SourceTarballError('the source archive has a bad number field');
    }
    value = value * 8 + (byte - 0x30);
    seen = true;
  }
  return value;
}

function checksumOk(block: Uint8Array): boolean {
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
  }
  return sum === numberField(block, 148, 8);
}

function isZeroBlock(block: Uint8Array): boolean {
  for (const byte of block) {
    if (byte !== 0) {
      return false;
    }
  }
  return true;
}

/** `len key=value\n` records; only `path` and `size` are kept. */
function paxRecords(data: Uint8Array): { path?: string; size?: number } {
  const out: { path?: string; size?: number } = {};
  let at = 0;
  while (at < data.length) {
    let space = at;
    while (space < data.length && data[space] !== 0x20) {
      space++;
    }
    const length = Number(decoder.decode(data.subarray(at, space)));
    if (!Number.isInteger(length) || length <= 0 || at + length > data.length) {
      break;
    }
    const record = decoder.decode(data.subarray(space + 1, at + length - 1));
    const equals = record.indexOf('=');
    if (equals !== -1) {
      const key = record.slice(0, equals);
      const value = record.slice(equals + 1);
      if (key === 'path') {
        out.path = value;
      } else if (key === 'size' && Number.isSafeInteger(Number(value))) {
        out.size = Number(value);
      }
    }
    at += length;
  }
  return out;
}

/** The path inside the repository (top folder cut off), or `null` when it is unsafe. */
export function sourceTarballPath(name: string): string | null {
  if (name.startsWith('/')) {
    return null;
  }
  const segments = name.split('/');
  if (segments.at(-1) === '') {
    segments.pop();
  }
  const inside = segments.slice(1);
  if (inside.length === 0) {
    return null;
  }
  for (const segment of inside) {
    if (segment === '' || segment === '.' || segment === '..') {
      return null;
    }
    for (let index = 0; index < segment.length; index++) {
      const code = segment.charCodeAt(index);
      if (code < 0x20 || code === 0x7f || code === 0x5c) {
        return null;
      }
    }
  }
  return inside.join('/');
}

function padOf(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

/**
 * Walks a gzip tar stream. Throws `SourceTarballTooLarge` past the limits and
 * `SourceTarballError` on a broken archive or a failed read; the stream is canceled
 * either way.
 */
export async function walkSourceTarball(
  gzipped: ReadableStream<Uint8Array>,
  limits: SourceTarballLimits,
  visit: SourceTarballVisitor,
): Promise<void> {
  // The Workers types read the writable side as `BufferSource`; it takes these bytes.
  const tar = gzipped.pipeThrough(
    new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
  );
  const bytes = new StreamBytes(tar.getReader());
  let files = 0;
  let total = 0;
  let paxPath: string | null = null;
  let paxSize: number | null = null;
  let longName: string | null = null;
  try {
    for (;;) {
      const block = await bytes.take(BLOCK);
      if (block === null || isZeroBlock(block)) {
        return;
      }
      if (!checksumOk(block)) {
        throw new SourceTarballError('the source archive has a bad header');
      }
      const type = String.fromCharCode(block[156]!);
      let size = numberField(block, 124, 12);
      if (type === 'x' || type === 'g' || type === 'L') {
        if (size > MAX_EXTENDED_HEADER_BYTES) {
          throw new SourceTarballError('the source archive has an oversized header');
        }
        total += size;
        if (total > limits.maxBytes) {
          throw new SourceTarballTooLarge('the source archive is larger than the scan limits');
        }
        const data = await bytes.take(size + padOf(size));
        if (data === null) {
          throw new SourceTarballError('the source archive ends inside a header');
        }
        if (type === 'x') {
          const records = paxRecords(data.subarray(0, size));
          paxPath = records.path ?? paxPath;
          paxSize = records.size ?? paxSize;
        } else if (type === 'L') {
          longName = cString(data, 0, size);
        }
        continue;
      }
      let name = longName ?? paxPath;
      if (name === null) {
        name = cString(block, 0, 100);
        if (cString(block, 257, 5) === 'ustar') {
          const prefix = cString(block, 345, 155);
          if (prefix !== '') {
            name = `${prefix}/${name}`;
          }
        }
      }
      if (paxSize !== null) {
        size = paxSize;
      }
      paxPath = null;
      paxSize = null;
      longName = null;

      // Every entry counts toward the limits, a skipped one too: its bytes are still
      // decompressed (a gzip bomb under an unsafe name must not get past them).
      const regular = type === '0' || type === '\0' || type === '7';
      if (regular) {
        files++;
      }
      total += size;
      if (files > limits.maxFiles || total > limits.maxBytes) {
        throw new SourceTarballTooLarge('the source archive is larger than the scan limits');
      }
      const path = regular ? sourceTarballPath(name) : null;
      const sink = path === null ? null : visit({ path, size });
      await bytes.pipe(size, padOf(size), sink);
      sink?.(null);
    }
  } catch (error) {
    // A broken gzip stream rejects the read with a plain error.
    if (error instanceof SourceTarballError) {
      throw error;
    }
    throw new SourceTarballError(
      `the source archive cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await bytes.cancel();
  }
}
