/** JSON representation of the native R2 put precondition options. */
export type RemoteR2Conditional =
  | Array<[string, string]>
  | (Omit<R2Conditional, 'uploadedBefore' | 'uploadedAfter'> & {
      uploadedBefore?: string;
      uploadedAfter?: string;
    });

/** JSON representation of native R2 HTTP metadata. */
export type RemoteR2HttpMetadata = Omit<R2HTTPMetadata, 'cacheExpiry'> & { cacheExpiry?: string };

/** URI-encoded JSON object metadata that the binding handler sends with a streamed `/r2/get` body. */
export const R2_OBJECT_HEADER = 'x-void-r2-object';

const HTTP_METADATA_FIELDS = new Set([
  'contentType',
  'contentLanguage',
  'contentDisposition',
  'contentEncoding',
  'cacheControl',
]);

export function serializeR2Conditional(value: R2Conditional | Headers): RemoteR2Conditional {
  if (value instanceof Headers) {
    return Array.from(value.entries());
  }
  return {
    ...value,
    uploadedBefore: value.uploadedBefore?.toISOString(),
    uploadedAfter: value.uploadedAfter?.toISOString(),
  };
}

export function serializeR2HttpMetadata(
  value: R2HTTPMetadata | Headers,
): Array<[string, string]> | RemoteR2HttpMetadata {
  if (value instanceof Headers) {
    return Array.from(value.entries());
  }
  return { ...value, cacheExpiry: value.cacheExpiry?.toISOString() };
}

function parseHeaderEntries(value: Array<unknown>, message: string): Headers {
  if (
    !value.every(
      (pair) =>
        Array.isArray(pair) && pair.length === 2 && pair.every((item) => typeof item === 'string'),
    )
  ) {
    throw new Error(message);
  }
  return new Headers(value as Array<[string, string]>);
}

export function parseR2Conditional(value: unknown): R2Conditional | Headers {
  if (Array.isArray(value)) {
    return parseHeaderEntries(value, 'Invalid R2 conditional headers');
  }
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid R2 conditional options');
  }
  const result: R2Conditional = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'etagMatches' || key === 'etagDoesNotMatch') {
      if (typeof entry !== 'string') {
        throw new Error(`Invalid R2 condition: ${key}`);
      }
      result[key] = entry;
    } else if (key === 'uploadedBefore' || key === 'uploadedAfter') {
      if (typeof entry !== 'string' || !Number.isFinite(Date.parse(entry))) {
        throw new Error(`Invalid R2 condition: ${key}`);
      }
      result[key] = new Date(entry);
    } else if (key === 'secondsGranularity') {
      if (typeof entry !== 'boolean') {
        throw new Error(`Invalid R2 condition: ${key}`);
      }
      result[key] = entry;
    } else {
      throw new Error(`Unsupported R2 condition: ${key}`);
    }
  }
  return result;
}

/** Like native R2, unknown metadata fields are ignored. */
export function parseR2HttpMetadata(value: unknown): R2HTTPMetadata | Headers {
  if (Array.isArray(value)) {
    return parseHeaderEntries(value, 'Invalid R2 HTTP metadata headers');
  }
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid R2 HTTP metadata');
  }
  const result: Record<string, string | Date> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'cacheExpiry') {
      if (typeof entry !== 'string' || !Number.isFinite(Date.parse(entry))) {
        throw new Error(`Invalid R2 HTTP metadata: ${key}`);
      }
      result[key] = new Date(entry);
    } else if (HTTP_METADATA_FIELDS.has(key)) {
      if (typeof entry !== 'string') {
        throw new Error(`Invalid R2 HTTP metadata: ${key}`);
      }
      result[key] = entry;
    }
  }
  return result;
}
