// Builds ustar archives by hand so tests can plant entries a normal tar tool would
// not write (symlinks into /etc, `..` names).

export type TarEntry = {
  name: string;
  /** '0' file (default), '5' directory, '2' symlink, ... */
  type?: string;
  data?: string | Uint8Array;
  linkname?: string;
  /** Overrides the size field (to fake a size the data does not match). */
  size?: number;
};

const BLOCK = 512;

export function buildTar(entries: Array<TarEntry>, options: { end?: boolean } = {}): Uint8Array {
  const parts: Array<Uint8Array> = [];
  for (const entry of entries) {
    const data =
      typeof entry.data === 'string'
        ? new TextEncoder().encode(entry.data)
        : (entry.data ?? new Uint8Array());
    parts.push(header(entry, entry.size ?? data.length), pad(data));
  }
  if (options.end !== false) {
    parts.push(new Uint8Array(BLOCK * 2));
  }
  return concat(parts);
}

function header(entry: TarEntry, size: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  writeString(block, 0, 100, entry.name);
  writeString(block, 100, 8, '0000644\0');
  writeString(block, 108, 8, '0000000\0');
  writeString(block, 116, 8, '0000000\0');
  writeString(block, 124, 12, `${size.toString(8).padStart(11, '0')}\0`);
  writeString(block, 136, 12, '00000000000\0');
  block[156] = (entry.type ?? '0').charCodeAt(0);
  writeString(block, 157, 100, entry.linkname ?? '');
  writeString(block, 257, 6, 'ustar\0');
  writeString(block, 263, 2, '00');
  for (let index = 148; index < 156; index++) {
    block[index] = 0x20;
  }
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  writeString(block, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return block;
}

function writeString(block: Uint8Array, offset: number, length: number, text: string): void {
  const bytes = new TextEncoder().encode(text);
  block.set(bytes.subarray(0, length), offset);
}

function pad(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
  padded.set(data);
  return padded;
}

function concat(parts: Array<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
