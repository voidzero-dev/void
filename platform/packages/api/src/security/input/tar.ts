/**
 * The scan input tar (design doc 0095, M10). A small ustar writer: regular files
 * only, mode 0444, no owner, mtime 0. A name that does not fit the 100-byte ustar
 * field, or is not ASCII, gets a pax `path` record. The runner's reader
 * (`security-scanner/src/runner/extract.ts`) refuses anything else, so the writer
 * checks names by the same rules and throws on a name it would refuse.
 */

import { SCAN_INPUT_LIMITS } from '../../../../security-scanner/src/runner/limits.ts';

const BLOCK = 512;
const encoder = new TextEncoder();

/** `data` as text is encoded (UTF-8) only when the entry is written. */
export type TarEntry = Readonly<{ path: string; data: Uint8Array | string }>;

export class TarPathError extends Error {}

/** Throws unless the runner would accept `path` as a file name. */
export function assertTarPath(path: string): void {
  if (path.length === 0 || path.length > SCAN_INPUT_LIMITS.maxTarPathChars) {
    throw new TarPathError(`tar path ${JSON.stringify(path.slice(0, 200))} has no usable length`);
  }
  if (path.startsWith('/') || path.startsWith('./')) {
    throw new TarPathError(`tar path ${JSON.stringify(path)} is not relative`);
  }
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x5c) {
      throw new TarPathError(`tar path ${JSON.stringify(path)} has a control character`);
    }
  }
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new TarPathError(`tar path ${JSON.stringify(path)} has an empty, "." or ".." part`);
    }
    if (encoder.encode(segment).length > 255) {
      throw new TarPathError(`tar path ${JSON.stringify(path)} has a part over 255 bytes`);
    }
  }
}

function writeString(block: Uint8Array, offset: number, length: number, text: string): void {
  const bytes = encoder.encode(text);
  block.set(bytes.subarray(0, length), offset);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  // `length - 1` digits and a NUL.
  writeString(block, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

function header(name: string, size: number, type: '0' | 'x'): Uint8Array<ArrayBuffer> {
  const block = new Uint8Array(BLOCK);
  writeString(block, 0, 100, name);
  writeOctal(block, 100, 8, 0o444);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, 0);
  block.fill(0x20, 148, 156);
  block[156] = type.charCodeAt(0);
  writeString(block, 257, 6, 'ustar\0');
  writeString(block, 263, 2, '00');
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  writeString(block, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return block;
}

function isPlainAscii(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 0x7e) {
      return false;
    }
  }
  return true;
}

/** `<length> path=<value>\n`, where length counts the whole record. */
function paxPathRecord(path: string): Uint8Array<ArrayBuffer> {
  const body = ` path=${path}\n`;
  const bodyLength = encoder.encode(body).length;
  let length = bodyLength + 1;
  while (String(length).length + bodyLength !== length) {
    length = String(length).length + bodyLength;
  }
  return encoder.encode(`${length}${body}`);
}

function padding(size: number): Uint8Array<ArrayBuffer> {
  const rest = size % BLOCK;
  return new Uint8Array(rest === 0 ? 0 : BLOCK - rest);
}

/** Throws unless every path is one the runner accepts, and none appears twice. */
export function assertTarEntries(entries: ReadonlyArray<TarEntry>): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    assertTarPath(entry.path);
    if (seen.has(entry.path)) {
      throw new TarPathError(`tar path ${JSON.stringify(entry.path)} appears twice`);
    }
    seen.add(entry.path);
  }
}

/**
 * One entry's blocks: pax record (when needed), header, data, padding. Bytes are
 * copied, so a byte stream can take them over without touching the caller's.
 */
function entryChunks(entry: TarEntry): Array<Uint8Array<ArrayBuffer>> {
  const data =
    typeof entry.data === 'string' ? encoder.encode(entry.data) : new Uint8Array(entry.data);
  const chunks: Array<Uint8Array<ArrayBuffer>> = [];
  let name = entry.path;
  if (encoder.encode(name).length > 99 || !isPlainAscii(name)) {
    const record = paxPathRecord(entry.path);
    chunks.push(header('PaxHeader', record.length, 'x'), record, padding(record.length));
    // The ustar name is only a fallback for readers without pax.
    name = 'pax-entry';
  }
  chunks.push(header(name, data.length, '0'), data, padding(data.length));
  return chunks;
}

/** The tar as chunks, ending with the two zero blocks. */
export function tarChunks(entries: ReadonlyArray<TarEntry>): Array<Uint8Array> {
  assertTarEntries(entries);
  const chunks = entries.flatMap(entryChunks);
  chunks.push(new Uint8Array(BLOCK * 2));
  return chunks;
}

export function tarByteLength(chunks: ReadonlyArray<Uint8Array>): number {
  return chunks.reduce((sum, chunk) => sum + chunk.length, 0);
}

/**
 * The tar as a byte stream (the shape an RPC return value can carry). Paths are
 * checked first, so a bad one throws here, never halfway through the stream. Each
 * entry is encoded only when the reader asks for it: the whole tar is never held
 * at once.
 */
export function tarStream(entries: ReadonlyArray<TarEntry>): ReadableStream<Uint8Array> {
  assertTarEntries(entries);
  let next = 0;
  return new ReadableStream({
    type: 'bytes',
    pull(controller) {
      if (next === entries.length) {
        controller.enqueue(new Uint8Array(BLOCK * 2));
        controller.close();
        return;
      }
      for (const chunk of entryChunks(entries[next++]!)) {
        if (chunk.length > 0) {
          controller.enqueue(chunk);
        }
      }
    },
  });
}
