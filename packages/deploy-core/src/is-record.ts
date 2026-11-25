/** Narrow object-shaped input without accepting null or arrays. */
// oxlint-disable-next-line quality/no-unsafe-dictionary-type -- Callers validate individual values after checking the object shape.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
