import { bytesToBase64 } from '../../shared/base64.ts';
import type { ProxyClient } from './client.ts';
import {
  R2_OBJECT_HEADER,
  serializeR2Conditional,
  serializeR2HttpMetadata,
} from './r2-conditions.ts';
import type { RemoteR2HttpMetadata } from './r2-conditions.ts';

/** Object fields from the binding handler or from the proxy's REST fallback. */
type RemoteR2Object = {
  key: string;
  size: number;
  etag?: string;
  lastModified: string;
  contentType?: string;
  version?: string;
  httpMetadata?: RemoteR2HttpMetadata;
  customMetadata?: Record<string, string>;
};

/**
 * HTTP metadata that the REST fallback and older deployments do not store.
 * Every path stores `contentType`.
 */
const EXTRA_HTTP_METADATA: Array<[keyof R2HTTPMetadata, string]> = [
  ['contentLanguage', 'content-language'],
  ['contentDisposition', 'content-disposition'],
  ['contentEncoding', 'content-encoding'],
  ['cacheControl', 'cache-control'],
  ['cacheExpiry', 'expires'],
];

/**
 * R2Bucket implementation backed by the remote proxy.
 * Used during local development when `remote: true` is set in void.config.ts.
 */
export class ProxyR2Bucket {
  constructor(
    private client: ProxyClient,
    private binding: string,
  ) {}

  async head(key: string): Promise<R2Object | null> {
    const res = await this.client.fetch('/r2/head', {
      binding: this.binding,
      key,
    });
    const data = await res.json<RemoteR2Object | null>();
    if (!data) {
      return null;
    }
    return makeR2Object(data);
  }

  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    if (requestsRange(options?.range) || requestsCondition(options?.onlyIf)) {
      throw new Error('remote: R2 get() with range or onlyIf is not supported in remote mode.');
    }
    const res = await this.client.fetch('/r2/get', { binding: this.binding, key });

    // Check if the proxy returned null (JSON response for 404).
    // Clone first so we don't consume the body if the object exists.
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const clone = res.clone();
      const data = await clone.json();
      if (data === null) {
        return null;
      }
    }

    return makeR2ObjectBody(key, res);
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    let base64: string | undefined;
    let textValue: string | undefined;

    if (typeof value === 'string') {
      textValue = value;
    } else if (value === null) {
      textValue = '';
    } else if (value instanceof ArrayBuffer) {
      base64 = bytesToBase64(new Uint8Array(value));
    } else if (ArrayBuffer.isView(value)) {
      base64 = bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    } else {
      // Blob or ReadableStream
      base64 = bytesToBase64(new Uint8Array(await new Response(value).arrayBuffer()));
    }

    type PutRequest = {
      binding: string;
      key: string;
      base64?: string;
      value?: string;
      httpMetadata?: ReturnType<typeof serializeR2HttpMetadata>;
      contentType?: string;
      customMetadata?: R2PutOptions['customMetadata'];
      onlyIf?: ReturnType<typeof serializeR2Conditional>;
    };
    const body: PutRequest = {
      binding: this.binding,
      key,
    };
    if (base64 !== undefined) {
      body.base64 = base64;
    } else {
      body.value = textValue;
    }
    if (options?.httpMetadata) {
      const meta = options.httpMetadata;
      body.httpMetadata = serializeR2HttpMetadata(meta);
      // Older handlers and the REST fallback read only the content type.
      if (meta instanceof Headers) {
        body.contentType = meta.get('content-type') ?? undefined;
      } else {
        body.contentType = meta.contentType;
      }
    }
    if (options?.customMetadata) {
      body.customMetadata = options.customMetadata;
    }

    const onlyIf = options?.onlyIf;
    const conditional = onlyIf !== undefined;
    if (conditional) {
      body.onlyIf = serializeR2Conditional(onlyIf);
    }
    // A separate endpoint prevents older proxies/workers from silently ignoring onlyIf.
    const res = await this.client.fetch(conditional ? '/r2/put-conditional' : '/r2/put', body);
    const result = await res.json<RemoteR2Object | null | { success: true }>();
    if (result === null) {
      return null;
    }
    // `{ success: true }` comes from the REST fallback or an older handler.
    const stored = 'key' in result ? result : undefined;
    if (!stored && conditional) {
      throw new Error(
        'remote: R2 conditional put requires a compatible Void platform and deployment.',
      );
    }
    const missing = missingMetadata(options, stored);
    if (missing.length > 0) {
      throw new Error(
        `remote: R2 put() stored "${key}" without ${missing.join(', ')}. Remote R2 metadata needs a project deployment with the current Void version. Deploy the project, then put the object again.`,
      );
    }
    if (stored) {
      return makeR2Object(stored);
    }

    // Return a minimal R2Object
    return makeR2Object({
      key,
      size: 0,
      etag: '',
      lastModified: new Date().toISOString(),
      contentType: 'application/octet-stream',
    });
  }

  async delete(keys: string | Array<string>): Promise<void> {
    const body: Record<'binding', string> &
      Partial<Record<'key' | 'keys', string | Array<string>>> = { binding: this.binding };
    if (Array.isArray(keys)) {
      body.keys = keys;
    } else {
      body.key = keys;
    }
    await this.client.fetch('/r2/delete', body);
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const res = await this.client.fetch('/r2/list', {
      binding: this.binding,
      prefix: options?.prefix,
      limit: options?.limit,
      cursor: options?.cursor,
      delimiter: options?.delimiter,
      startAfter: options?.startAfter,
      include: options?.include,
    });
    const data = await res.json<{
      objects: Array<RemoteR2Object>;
      truncated: boolean;
      cursor: string | null;
      delimitedPrefixes?: Array<string>;
    }>();
    // Older handlers and the REST fallback ignore these options and return no prefixes.
    // The proxy also uses the REST fallback when it cannot reach a current deployment for a moment.
    if (
      !Array.isArray(data.delimitedPrefixes) &&
      (options?.delimiter || options?.startAfter || options?.include)
    ) {
      throw new Error(
        'remote: R2 list() with delimiter, startAfter or include got no answer from a current project deployment. The deployment uses an older Void version, or the platform could not reach it. Retry. If the error continues, deploy the project with the current Void version.',
      );
    }

    return {
      objects: data.objects.map((o) =>
        makeR2Object({ contentType: 'application/octet-stream', ...o }),
      ),
      truncated: data.truncated,
      cursor: data.cursor ?? undefined,
      delimitedPrefixes: data.delimitedPrefixes ?? [],
    } as R2Objects;
  }

  createMultipartUpload(): never {
    throw new Error('createMultipartUpload() is not supported with remote bindings');
  }

  resumeMultipartUpload(): never {
    throw new Error('resumeMultipartUpload() is not supported with remote bindings');
  }
}

/**
 * Remote mode ignores a `Headers` value, such as `request.headers`, and returns the whole
 * object, so a reload with If-None-Match or a Range request for media still gets a body.
 * Native R2 ignores fields that are undefined.
 */
function requestsRange(range: R2GetOptions['range']): boolean {
  if (range instanceof Headers) {
    return false;
  }
  return Object.values(range ?? {}).some((value) => value !== undefined);
}

/** Same rules as `requestsRange`. `secondsGranularity` alone asks for no condition. */
function requestsCondition(onlyIf: R2GetOptions['onlyIf']): boolean {
  if (onlyIf instanceof Headers) {
    return false;
  }
  return Object.entries(onlyIf ?? {}).some(
    ([name, value]) => name !== 'secondsGranularity' && value !== undefined,
  );
}

/** Metadata in `options` that the stored object in the put response does not have. */
function missingMetadata(
  options: R2PutOptions | undefined,
  stored: RemoteR2Object | undefined,
): Array<string> {
  const meta = options?.httpMetadata;
  const missing: Array<string> = EXTRA_HTTP_METADATA.flatMap(([field, header]) =>
    (meta instanceof Headers ? meta.has(header) : meta?.[field] !== undefined) &&
    stored?.httpMetadata?.[field] === undefined
      ? [field]
      : [],
  );
  if (
    Object.keys(options?.customMetadata ?? {}).some(
      (name) => stored?.customMetadata?.[name] === undefined,
    )
  ) {
    missing.push('customMetadata');
  }
  return missing;
}

/** R2 `etag` is unquoted. HTTP headers and older handlers send the quoted form. */
function normalizeEtag(etag: string): string {
  const value = etag.startsWith('W/') ? etag.slice(2) : etag;
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function readHttpMetadata(data: RemoteR2Object): R2HTTPMetadata {
  if (!data.httpMetadata) {
    return { contentType: data.contentType };
  }
  const { cacheExpiry, ...metadata } = data.httpMetadata;
  return cacheExpiry ? { ...metadata, cacheExpiry: new Date(cacheExpiry) } : metadata;
}

function makeR2Object(data: RemoteR2Object) {
  const etag = normalizeEtag(data.etag ?? '');
  const httpMetadata = readHttpMetadata(data);
  return {
    key: data.key,
    version: data.version ?? '',
    size: data.size,
    etag,
    httpEtag: etag ? `"${etag}"` : '',
    checksums: { toJSON: () => ({}) } as R2Checksums,
    uploaded: new Date(data.lastModified || Date.now()),
    httpMetadata,
    customMetadata: data.customMetadata ?? {},
    storageClass: 'Standard',
    range: undefined,
    writeHttpMetadata(headers: Headers) {
      // Same headers as native R2.
      const fields: Array<[string, string | undefined]> = [
        ['content-type', httpMetadata.contentType],
        ['content-language', httpMetadata.contentLanguage],
        ['content-disposition', httpMetadata.contentDisposition],
        ['content-encoding', httpMetadata.contentEncoding],
        ['cache-control', httpMetadata.cacheControl],
        ['expires', httpMetadata.cacheExpiry?.toUTCString()],
      ];
      for (const [name, value] of fields) {
        if (value !== undefined) {
          headers.set(name, value);
        }
      }
    },
  } satisfies R2Object;
}

function makeR2ObjectBody(key: string, res: Response): R2ObjectBody {
  // Older handlers and the REST fallback send only standard headers.
  const meta = res.headers.get(R2_OBJECT_HEADER);
  const obj = makeR2Object(
    meta
      ? (JSON.parse(decodeURIComponent(meta)) as RemoteR2Object)
      : {
          key,
          size: Number.parseInt(res.headers.get('content-length') ?? '0'),
          etag: res.headers.get('etag') ?? '',
          lastModified: res.headers.get('last-modified') ?? '',
          contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        },
  );

  return {
    ...obj,
    // oxlint-disable-next-line typescript/no-non-null-assertion -- The remote GET returns an object body for a successful lookup, including zero-length objects.
    body: res.body!,
    get bodyUsed() {
      return res.bodyUsed;
    },
    arrayBuffer: () => res.arrayBuffer(),
    bytes: async () => new Uint8Array(await res.arrayBuffer()),
    text: () => res.text(),
    json: <T>() => res.json<T>(),
    blob: () => res.blob(),
  };
}
