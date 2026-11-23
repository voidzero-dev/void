/** Keys already logged by `warnOnce` in this module instance. */
const warnings = new Set<string>();

/**
 * `console.warn` a message once per module instance (Next.js `warnOnce`),
 * keyed by `key` (default: the message) so messages with varying details
 * collapse. Development callers gate it on `config.dev`.
 */
export function warnOnce(message: string, key: string = message): void {
  if (!warnings.has(key)) {
    console.warn(message);
  }
  warnings.add(key);
}
