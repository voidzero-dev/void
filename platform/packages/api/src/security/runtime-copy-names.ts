/**
 * Names shared by the API and the scanner controller for the runtime copy (design doc
 * 0095, M30). No imports: the controller bundle includes this file.
 *
 *   container ──http://copy.void.internal/…──► controller CopyOutbound (props: scan, attempt)
 *     └─► dispatch namespace `void-security-copies-<h>` / script `void-sec-copy-<h>-<scan>-a<n>`
 *           outbound Worker = the copy sandbox (every fetch of the copy ends there, 403)
 */

/** The second host a scan container may call (the first is the model host). */
export const COPY_HOST = 'copy.void.internal';
/** The controller's dispatch namespace binding (outbound: the copy sandbox). */
export const COPY_NAMESPACE_BINDING = '__VOID_SECURITY_COPIES';
/** The controller's name prefix of this installation's copies. */
export const COPY_PREFIX_BINDING = '__VOID_SECURITY_COPY_PREFIX';
/** Set by the controller on every answer: `dispatched` (from the copy) or `unavailable`. */
export const COPY_HEADER = 'x-void-copy';
/** Routes the copy's entry answers itself, before the app (ready check, test data). */
export const COPY_CONTROL_PREFIX = '/__void_copy/';
export const COPY_READY_PATH = '/__void_copy/ready';

/** Lowercase letters and digits only: a copy name is also a D1, KV and R2 name. */
function nameKey(value: string): string {
  let out = '';
  for (const char of value.toLowerCase()) {
    if ((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9')) {
      out += char;
    }
  }
  return out;
}

/** `void-sec-copy-<12 hex>-`: every copy resource of one installation starts with it. */
export function runtimeCopyPrefix(installationSuffix: string): string {
  return `void-sec-copy-${nameKey(installationSuffix)}-`;
}

/** One copy per scan attempt; a retry gets a new, empty copy. */
export function runtimeCopyScriptName(prefix: string, scanId: string, attempt: number): string {
  return `${prefix}${nameKey(scanId)}-a${attempt}`;
}

/** Store names: `<script>-d0`, `<script>-k0`, `<script>-r0`, … */
export function runtimeCopyStoreName(script: string, kind: 'd' | 'k' | 'r', index: number): string {
  return `${script}-${kind}${index}`;
}

/** The copy script a store belongs to (its name without the `-<kind><n>` end). */
export function runtimeCopyStoreOwner(storeName: string): string {
  const cut = storeName.lastIndexOf('-');
  return cut === -1 ? storeName : storeName.slice(0, cut);
}
