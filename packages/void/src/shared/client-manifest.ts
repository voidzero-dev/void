import { isRecord } from '@void/deploy-core';

export type ClientManifest = Record<
  string,
  {
    file?: string;
    imports?: Array<string>;
    css?: Array<string>;
    /** Build-proven fingerprinted outputs; absent in older/third-party manifests. */
    immutableFiles?: Array<string>;
  }
>;

function isOptionalStringArray(value: unknown): boolean {
  return (
    value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  );
}

export function isClientManifest(value: unknown): value is ClientManifest {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) =>
        isRecord(entry) &&
        (entry.file === undefined || typeof entry.file === 'string') &&
        isOptionalStringArray(entry.imports) &&
        isOptionalStringArray(entry.css) &&
        isOptionalStringArray(entry.immutableFiles),
    )
  );
}
