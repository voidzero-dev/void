/**
 * Input filters (spec §7.1, §7.4). Plain string checks on the path, no regex.
 *
 * - `secret`: secret-like files, always dropped and listed in the coverage notes
 *   (`.env*`, `*.pem`, `*.key`, `id_*` key files, `*.p12`, `.npmrc`, `.git*`).
 * - `skipped`: lockfiles, `.void/` generated files, `.d.ts`, binaries, images,
 *   fonts and wasm. Out of scope, not counted as dropped code.
 *
 * Never drop first-party code because it looks minified.
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

/** Binary content: a NUL byte in the first 8 KiB, or text that is not UTF-8. */
export function looksBinary(text: string): boolean {
  const end = Math.min(text.length, 8192);
  for (let index = 0; index < end; index++) {
    const code = text.charCodeAt(index);
    if (code === 0 || code === 0xfffd) {
      return true;
    }
  }
  return false;
}
