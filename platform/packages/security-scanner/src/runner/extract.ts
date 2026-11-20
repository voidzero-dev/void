// Safe tar extraction for the scan input the controller streams in (spec §15.2 T3).
// Only regular files and directories are written. Symlinks, hard links, devices,
// fifos, absolute paths, `..`, duplicate entries and anything outside the allowed
// top-level names are refused, and the whole input is refused with them.
// Hand-written ustar/pax reader: no dependency, no regex.

import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { SCAN_INPUT_LIMITS } from './limits.ts';

export type ExtractLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
};

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxFiles: SCAN_INPUT_LIMITS.maxFiles,
  maxFileBytes: SCAN_INPUT_LIMITS.maxFileBytes,
  maxTotalBytes: SCAN_INPUT_LIMITS.maxTotalBytes,
};

export type ExtractOptions = {
  /** Fresh directory to write into. */
  dest: string;
  /** Allowed first path segments, e.g. `task.json`, `input`, `memory`. Empty = any. */
  allowedRoots?: ReadonlyArray<string>;
  limits?: Partial<ExtractLimits>;
  /** Stops a read that waits on the stream (the controller's SIGTERM). */
  signal?: AbortSignal;
};

export type ExtractResult = { files: number; directories: number; bytes: number };

export class ExtractError extends Error {}

const BLOCK = 512;
const FILE_MODE = 0o444;
const DIR_MODE = 0o755;

type Header = { name: string; size: number; type: string };

export async function extractTar(
  source: AsyncIterable<Uint8Array> | Uint8Array,
  options: ExtractOptions,
): Promise<ExtractResult> {
  const limits = { ...DEFAULT_EXTRACT_LIMITS, ...options.limits };
  const allowed = new Set(options.allowedRoots ?? []);
  const reader = new BlockReader(
    source instanceof Uint8Array ? single(source) : source,
    options.signal,
  );
  const seen = new Map<string, 'file' | 'dir'>();
  const result: ExtractResult = { files: 0, directories: 0, bytes: 0 };
  let paxPath: string | null = null;
  let paxSize: number | null = null;
  let longName: string | null = null;

  await mkdir(options.dest, { recursive: true });

  for (;;) {
    const block = await reader.read(BLOCK);
    if (block === null) {
      throw new ExtractError('tar input ended without an end marker');
    }
    if (isZero(block)) {
      return result;
    }
    const header = readHeader(block);

    if (header.type === 'x' || header.type === 'g' || header.type === 'L') {
      if (header.size > 1024 * 1024) {
        throw new ExtractError('tar extended header is too large');
      }
      const data = await readData(reader, header.size, padTo(header.size));
      if (header.type === 'x') {
        const records = readPaxRecords(data);
        paxPath = records.path ?? paxPath;
        if (records.size !== undefined) {
          paxSize = readDecimal(records.size, 'pax size');
        }
      } else if (header.type === 'L') {
        longName = cString(data);
      }
      // 'g' (global pax header) sets nothing we use.
      continue;
    }

    const size = paxSize ?? header.size;
    const dataLength = padTo(size);
    const rawName = paxPath ?? longName ?? header.name;
    paxPath = null;
    paxSize = null;
    longName = null;

    if (header.type !== '0' && header.type !== '\0' && header.type !== '5') {
      throw new ExtractError(`tar entry ${quote(rawName)} is not a regular file or directory`);
    }
    const isDir = header.type === '5';
    const segments = safeSegments(rawName, isDir);
    if (allowed.size > 0 && !allowed.has(segments[0]!)) {
      throw new ExtractError(`tar entry ${quote(rawName)} is outside the scan input`);
    }
    const key = segments.join('/');
    if (seen.has(key)) {
      throw new ExtractError(`tar entry ${quote(rawName)} appears twice`);
    }
    // A parent that was a file, or a file under a path seen as a file, is refused.
    for (let depth = 1; depth < segments.length; depth++) {
      const parent = segments.slice(0, depth).join('/');
      if (seen.get(parent) === 'file') {
        throw new ExtractError(`tar entry ${quote(rawName)} is inside a file`);
      }
      if (!seen.has(parent)) {
        seen.set(parent, 'dir');
      }
    }
    const target = join(options.dest, ...segments);

    if (isDir) {
      if (size !== 0) {
        throw new ExtractError(`tar directory ${quote(rawName)} has data`);
      }
      seen.set(key, 'dir');
      await mkdir(target, { recursive: true, mode: DIR_MODE });
      result.directories++;
      continue;
    }

    if (result.files + 1 > limits.maxFiles) {
      throw new ExtractError(`tar input has more than ${limits.maxFiles} files`);
    }
    if (size > limits.maxFileBytes) {
      throw new ExtractError(
        `tar entry ${quote(rawName)} is larger than ${limits.maxFileBytes} bytes`,
      );
    }
    if (result.bytes + size > limits.maxTotalBytes) {
      throw new ExtractError(`tar input is larger than ${limits.maxTotalBytes} bytes`);
    }
    seen.set(key, 'file');
    if (segments.length > 1) {
      await mkdir(join(options.dest, ...segments.slice(0, -1)), {
        recursive: true,
        mode: DIR_MODE,
      });
    }
    const data = await readData(reader, size, dataLength);
    let handle;
    try {
      // O_EXCL + O_NOFOLLOW: never replace or follow what is already there.
      handle = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        FILE_MODE,
      );
    } catch (error) {
      throw new ExtractError(
        `tar entry ${quote(rawName)} could not be written (${String((error as { code?: unknown }).code ?? 'error')})`,
      );
    }
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    result.files++;
    result.bytes += size;
  }
}

function padTo(size: number): number {
  return Math.ceil(size / BLOCK) * BLOCK;
}

function readHeader(block: Uint8Array): Header {
  const stored = readOctal(block.subarray(148, 156), 'checksum');
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
  }
  if (sum !== stored) {
    throw new ExtractError('tar header checksum does not match');
  }
  const magic = ascii(block.subarray(257, 262));
  const name = cString(block.subarray(0, 100));
  const prefix = magic === 'ustar' ? cString(block.subarray(345, 500)) : '';
  return {
    name: prefix ? `${prefix}/${name}` : name,
    size: readSize(block.subarray(124, 136)),
    type: String.fromCharCode(block[156]!),
  };
}

function readSize(field: Uint8Array): number {
  if ((field[0]! & 0x80) !== 0) {
    // Base-256 (GNU) for sizes past 8 GiB: always beyond our limits.
    throw new ExtractError('tar entry is too large');
  }
  return readOctal(field, 'size');
}

function readOctal(field: Uint8Array, name: string): number {
  let value = 0;
  let digits = 0;
  for (const byte of field) {
    if (byte === 0 || byte === 0x20) {
      if (digits > 0) {
        break;
      }
      continue;
    }
    if (byte < 0x30 || byte > 0x37) {
      throw new ExtractError(`tar header ${name} is not an octal number`);
    }
    value = value * 8 + (byte - 0x30);
    digits++;
  }
  return value;
}

function readDecimal(text: string, name: string): number {
  if (text.length === 0 || text.length > 15) {
    throw new ExtractError(`tar ${name} is not a number`);
  }
  let value = 0;
  for (const char of text) {
    if (char < '0' || char > '9') {
      throw new ExtractError(`tar ${name} is not a number`);
    }
    value = value * 10 + (char.charCodeAt(0) - 0x30);
  }
  return value;
}

/**
 * pax records: `<length> <key>=<value>\n`, length counting the whole record.
 * Keys are ASCII. Only `path` (UTF-8) and `size` (decimal) are decoded; every
 * other value is skipped as bytes, since some (`SCHILY.xattr.*`) are raw binary.
 */
function readPaxRecords(data: Uint8Array): { path?: string; size?: string } {
  const records: { path?: string; size?: string } = {};
  let position = 0;
  while (position < data.length) {
    let space = position;
    while (space < data.length && data[space] !== 0x20) {
      space++;
    }
    const length = readDecimal(ascii(data.subarray(position, space)), 'pax record length');
    const end = position + length;
    if (length === 0 || end > data.length || space >= end || data[end - 1] !== 0x0a) {
      throw new ExtractError('tar pax record is malformed');
    }
    let equals = space + 1;
    while (equals < end - 1 && data[equals] !== 0x3d) {
      equals++;
    }
    if (equals === space + 1 || equals >= end - 1) {
      throw new ExtractError('tar pax record is malformed');
    }
    const key = ascii(data.subarray(space + 1, equals));
    if (key === 'path' || key === 'size') {
      const value = data.subarray(equals + 1, end - 1);
      try {
        records[key] = new TextDecoder('utf-8', { fatal: true }).decode(value);
      } catch {
        throw new ExtractError(`tar pax ${key} is not UTF-8`);
      }
    }
    position = end;
  }
  return records;
}

/** Splits a tar path into clean segments, or refuses it. */
export function safeSegments(rawName: string, isDir: boolean): Array<string> {
  let name = rawName;
  while (name.startsWith('./')) {
    name = name.slice(2);
  }
  if (isDir && name.endsWith('/')) {
    name = name.slice(0, -1);
  }
  if (name.length === 0 || name.length > SCAN_INPUT_LIMITS.maxTarPathChars) {
    throw new ExtractError(`tar entry ${quote(rawName)} has no usable name`);
  }
  if (name.startsWith('/')) {
    throw new ExtractError(`tar entry ${quote(rawName)} is an absolute path`);
  }
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x5c) {
      throw new ExtractError(`tar entry ${quote(rawName)} has a control character or backslash`);
    }
  }
  const segments = name.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new ExtractError(`tar entry ${quote(rawName)} has an empty, "." or ".." segment`);
    }
    if (Buffer.byteLength(segment, 'utf8') > 255) {
      throw new ExtractError(`tar entry ${quote(rawName)} has a name part that is too long`);
    }
  }
  return segments;
}

async function readData(reader: BlockReader, size: number, padded: number): Promise<Uint8Array> {
  const data = await reader.read(padded);
  if (data === null) {
    throw new ExtractError('tar input ended inside an entry');
  }
  return data.subarray(0, size);
}

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  const slice = end === -1 ? bytes : bytes.subarray(0, end);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(slice);
  } catch {
    throw new ExtractError('tar entry name is not UTF-8');
  }
}

function ascii(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    if (byte === 0) {
      break;
    }
    out += String.fromCharCode(byte);
  }
  return out;
}

function isZero(block: Uint8Array): boolean {
  for (const byte of block) {
    if (byte !== 0) {
      return false;
    }
  }
  return true;
}

function quote(name: string): string {
  return JSON.stringify(name.length > 200 ? `${name.slice(0, 200)}…` : name);
}

async function* single(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/** Reads exact byte counts from a chunked stream. */
class BlockReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private chunks: Array<Uint8Array> = [];
  private buffered = 0;
  private ended = false;

  private readonly signal: AbortSignal | undefined;

  constructor(source: AsyncIterable<Uint8Array>, signal?: AbortSignal) {
    this.iterator = source[Symbol.asyncIterator]();
    this.signal = signal;
  }

  /** `null` when the stream ends before `length` bytes. */
  async read(length: number): Promise<Uint8Array | null> {
    this.throwIfStopped();
    while (this.buffered < length && !this.ended) {
      const next = await this.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      if (next.value.length > 0) {
        this.chunks.push(next.value);
        this.buffered += next.value.length;
      }
    }
    if (this.buffered < length) {
      return null;
    }
    const out = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const chunk = this.chunks[0]!;
      const take = Math.min(chunk.length, length - filled);
      out.set(chunk.subarray(0, take), filled);
      filled += take;
      if (take === chunk.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = chunk.subarray(take);
      }
    }
    this.buffered -= length;
    return out;
  }

  private throwIfStopped(): void {
    if (this.signal?.aborted) {
      throw new ExtractError('tar input was stopped');
    }
  }

  /** The next chunk, or a throw as soon as the signal stops the read. */
  private next(): Promise<IteratorResult<Uint8Array>> {
    const signal = this.signal;
    const pending = this.iterator.next();
    if (signal === undefined) {
      return pending;
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new ExtractError('tar input was stopped'));
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }
}
