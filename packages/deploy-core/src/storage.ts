export const R2_LOCATION_HINTS = ['apac', 'eeur', 'enam', 'weur', 'wnam', 'oc'] as const;

export type R2LocationHint = (typeof R2_LOCATION_HINTS)[number];
export type StorageConfig = { locationHint?: R2LocationHint };

export function isR2LocationHint(value: unknown): value is R2LocationHint {
  return typeof value === 'string' && R2_LOCATION_HINTS.some((hint) => hint === value);
}
