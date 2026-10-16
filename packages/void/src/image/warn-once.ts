/** Messages already logged by `warnOnce` in this module instance. */
const warnings = new Set<string>();

/** `console.warn` a message once per module instance (Next.js `warnOnce`). Callers gate it on `config.dev`. */
export function warnOnce(message: string): void {
  if (!warnings.has(message)) {
    console.warn(message);
  }
  warnings.add(message);
}
