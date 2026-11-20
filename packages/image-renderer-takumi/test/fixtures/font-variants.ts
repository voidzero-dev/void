import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { robotoData } from '../../src/roboto-font.ts';

const original = robotoData();
const header = new DataView(original.buffer, original.byteOffset, original.byteLength);
let directoryEnd = 48;
let streamOffset = 0;
let headOffset = 0;

function readBase128(): number {
  let value = 0;
  for (;;) {
    const byte = original[directoryEnd++]!;
    value = value * 128 + (byte & 127);
    if ((byte & 128) === 0) {
      return value;
    }
  }
}

// Walk this fixture's WOFF2 directory to find the untransformed head table
// inside its Brotli stream. glyf/loca use transform version 0; other tables
// use a nonzero version to signal a transformed length.
for (let index = 0; index < header.getUint16(12); index++) {
  const flags = original[directoryEnd++]!;
  const tag = flags & 63;
  if (tag === 63) {
    directoryEnd += 4;
  }
  const length = readBase128();
  const transformed = tag === 10 || tag === 11 ? flags >> 6 === 0 : flags >> 6 !== 0;
  const storedLength = transformed ? readBase128() : length;
  if (tag === 1) {
    headOffset = streamOffset;
  }
  streamOffset += storedLength;
}
const tables = brotliDecompressSync(
  original.subarray(directoryEnd, directoryEnd + header.getUint32(20)),
);

export const decodedFontSize: number = header.getUint32(16);

/** Distinct font contents, identical glyphs: vary head.modified, then repack WOFF2. */
export function fontVariant(sequence: number): Uint8Array<ArrayBuffer> {
  const modified = new Uint8Array(tables);
  new DataView(modified.buffer).setUint32(headOffset + 32, sequence);
  const compressed = brotliCompressSync(modified, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
  });
  // WOFF2 requires four-byte file alignment, including after the Brotli stream.
  const bytes = new Uint8Array((directoryEnd + compressed.length + 3) & ~3);
  bytes.set(original.subarray(0, directoryEnd));
  bytes.set(compressed, directoryEnd);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, bytes.length);
  view.setUint32(20, compressed.length);
  return bytes;
}
