/**
 * Local tree checks (`void project security check`, design doc 0095 M32), shared by
 * the CLI that packs the tree and the platform API that reads it.
 *
 *   git-tracked files ─► securityInputFilter ─► secret: never sent, counted
 *                                           └► skipped: never sent (lockfiles, binaries…)
 *   the rest ─► securityLocalTreeTar (ustar, `tree/` top folder) ─► gzip ─► one R2 PUT
 *
 * The same filter runs on every scan input on the platform side, so a file the CLI
 * would never send is also never read from a deployed bundle.
 */

/**
 * - `secret`: secret-like files, always dropped and listed in the coverage notes
 *   (`.env*`, `*.pem`, `*.key`, `id_*` key files, `*.p12`, `.npmrc`, `.git*`).
 * - `skipped`: lockfiles, `.void/` generated files, `.d.ts`, binaries, images,
 *   fonts and wasm. Out of scope, not counted as dropped code.
 *
 * Plain string checks on the path, no regex. Never drop first-party code because it
 * looks minified.
 */
export type SecurityInputFilter = 'secret' | 'skipped';

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
]);

const SKIPPED_EXTENSIONS = new Set([
  // binaries and archives
  'wasm',
  'exe',
  'dll',
  'so',
  'dylib',
  'node',
  'bin',
  'dat',
  'zip',
  'gz',
  'tgz',
  'br',
  'zst',
  'tar',
  '7z',
  'pdf',
  // images
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'ico',
  'bmp',
  'tif',
  'tiff',
  'heic',
  // fonts
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  // media
  'mp3',
  'mp4',
  'webm',
  'ogg',
  'wav',
  'mov',
]);

const SECRET_EXTENSIONS = new Set(['pem', 'key', 'p12', 'pfx']);

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * `id_*` names an SSH key file (`id_rsa`, `id_ed25519.pub`), not code: it matches
 * only with no extension or `.pub`, so `id_utils.ts` stays.
 */
function isKeyFileName(name: string): boolean {
  if (!name.startsWith('id_')) {
    return false;
  }
  const dot = name.indexOf('.');
  return dot === -1 || name.slice(dot) === '.pub';
}

export function securityInputFilter(path: string): SecurityInputFilter | null {
  const segments = path.split('/');
  const name = baseName(path);
  const lower = name.toLowerCase();
  for (const segment of segments) {
    if (segment.startsWith('.git')) {
      return 'secret';
    }
  }
  if (
    lower.startsWith('.env') ||
    lower === '.npmrc' ||
    SECRET_EXTENSIONS.has(extension(lower)) ||
    isKeyFileName(lower)
  ) {
    return 'secret';
  }
  if (segments.includes('.void')) {
    return 'skipped';
  }
  if (LOCKFILES.has(lower)) {
    return 'skipped';
  }
  if (lower.endsWith('.d.ts') || lower.endsWith('.d.mts') || lower.endsWith('.d.cts')) {
    return 'skipped';
  }
  if (SKIPPED_EXTENSIONS.has(extension(lower))) {
    return 'skipped';
  }
  return null;
}

/**
 * What one local check may send. The CLI checks them before it uploads; the API
 * checks the declared sizes when it signs the upload, and the real ones while it reads.
 */
export const SECURITY_LOCAL_CHECK_LIMITS: Readonly<{
  maxFiles: number;
  maxBytes: number;
  maxArchiveBytes: number;
}> = {
  /** Files in the tree. */
  maxFiles: 10_000,
  /** Their bytes, uncompressed (what one scan input can hold). */
  maxBytes: 32 * 1024 * 1024,
  /** The gzip archive. */
  maxArchiveBytes: 32 * 1024 * 1024,
};

/** The archive's top folder; the reader cuts it off, as for a GitHub tarball. */
export const SECURITY_LOCAL_TREE_ROOT = 'tree';

/**
 * Whether `path` (relative to the project folder) can go in the archive: no empty,
 * `.` or `..` part, no leading `/`, no control character or backslash.
 */
export function isSecurityLocalTreePath(path: string): boolean {
  if (path.length === 0 || path.startsWith('/')) {
    return false;
  }
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      return false;
    }
  }
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x5c) {
      return false;
    }
  }
  return true;
}

const BLOCK = 512;
const encoder = new TextEncoder();

function writeString(block: Uint8Array, offset: number, length: number, text: string): void {
  block.set(encoder.encode(text).subarray(0, length), offset);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  writeString(block, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

function header(name: string, size: number, type: '0' | 'x'): Uint8Array {
  const block = new Uint8Array(BLOCK);
  writeString(block, 0, 100, name);
  writeOctal(block, 100, 8, 0o644);
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

/** `<length> path=<value>\n`, where length counts the whole record. */
function paxPathRecord(path: string): Uint8Array {
  const body = ` path=${path}\n`;
  const bodyLength = encoder.encode(body).length;
  let length = bodyLength + 1;
  while (String(length).length + bodyLength !== length) {
    length = String(length).length + bodyLength;
  }
  return encoder.encode(`${length}${body}`);
}

function isPlainAscii(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 0x7e) {
      return false;
    }
  }
  return true;
}

export type SecurityLocalTreeFile = Readonly<{ path: string; data: Uint8Array }>;

/**
 * The tree as one uncompressed ustar archive under `tree/`. A long or non-ASCII name
 * gets a pax `path` record. Throws on a path `isSecurityLocalTreePath` refuses.
 */
export function securityLocalTreeTar(files: ReadonlyArray<SecurityLocalTreeFile>): Uint8Array {
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  const push = (chunk: Uint8Array) => {
    chunks.push(chunk);
    total += chunk.length;
  };
  const pad = (size: number) => {
    const rest = size % BLOCK;
    if (rest !== 0) {
      push(new Uint8Array(BLOCK - rest));
    }
  };
  for (const file of files) {
    if (!isSecurityLocalTreePath(file.path)) {
      throw new Error(`security check: ${JSON.stringify(file.path)} is not a usable path`);
    }
    let name = `${SECURITY_LOCAL_TREE_ROOT}/${file.path}`;
    if (encoder.encode(name).length > 99 || !isPlainAscii(name)) {
      const record = paxPathRecord(name);
      push(header('PaxHeader', record.length, 'x'));
      push(record);
      pad(record.length);
      name = `${SECURITY_LOCAL_TREE_ROOT}/pax-entry`;
    }
    push(header(name, file.data.length, '0'));
    push(file.data);
    pad(file.data.length);
  }
  push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
