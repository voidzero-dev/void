/**
 * Input filters (spec §7.1, §7.4). The path filter is shared with the CLI's local
 * check (`@void/platform/security-local-check`), so both sides drop the same files:
 *
 * - `secret`: secret-like files, always dropped and listed in the coverage notes
 *   (`.env*`, `*.pem`, `*.key`, `id_*` key files, `*.p12`, `.npmrc`, `.git*`).
 * - `skipped`: lockfiles, `.void/` generated files, `.d.ts`, binaries, images,
 *   fonts and wasm. Out of scope, not counted as dropped code.
 *
 * Never drop first-party code because it looks minified.
 */

export { securityInputFilter, type SecurityInputFilter } from '@void/platform/security-local-check';

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
