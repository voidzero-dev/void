import { bytesToBase64 } from '../../shared/base64.ts';
import type { ProxyClient } from './client.ts';

/**
 * KVNamespace implementation backed by the remote proxy.
 * Used during local development when `remote: true` is set in void.config.ts.
 */
export class ProxyKVNamespace {
  constructor(
    private client: ProxyClient,
    private binding: string,
  ) {}

  async get(key: string): Promise<string | null>;
  async get<T = unknown>(key: string, type: 'json'): Promise<T | null>;
  async get(key: string, type: 'text'): Promise<string | null>;
  async get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  async get(key: string, type: 'stream'): Promise<ReadableStream | null>;
  async get<T = unknown>(key: string, options: { type: 'json' }): Promise<T | null>;
  async get(key: string, options: { type: 'text' }): Promise<string | null>;
  async get(key: string, options: { type: 'arrayBuffer' }): Promise<ArrayBuffer | null>;
  async get(key: string, options: { type: 'stream' }): Promise<ReadableStream | null>;
  async get(
    key: string,
    options?: { type?: string } | string,
  ): Promise<string | ArrayBuffer | ReadableStream | unknown | null> {
    const type = typeof options === 'string' ? options : (options?.type ?? 'text');
    const res = await this.client.fetch('/kv/get', {
      binding: this.binding,
      key,
      type,
    });

    // A missing key is JSON `null` for every type; binary values arrive as octet-stream.
    if (
      (type !== 'arrayBuffer' && type !== 'stream') ||
      res.headers.get('content-type')?.includes('application/json')
    ) {
      return res.json();
    }
    return type === 'arrayBuffer' ? res.arrayBuffer() : res.body;
  }

  async getWithMetadata<T = string, M = unknown>(
    key: string,
    options?: { type?: string } | string,
  ): Promise<{ value: T | null; metadata: M | null; cacheStatus: null }> {
    const requested = typeof options === 'string' ? options : options?.type;
    const type =
      requested === 'json' || requested === 'arrayBuffer' || requested === 'stream'
        ? requested
        : 'text';
    const value = (await this.get(key, type as never)) as T | null;
    return { value, metadata: null, cacheStatus: null };
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: KVNamespacePutOptions,
  ): Promise<void> {
    let serializedValue: unknown;
    let isBase64 = false;
    if (typeof value === 'string') {
      serializedValue = value;
    } else {
      const buffer = value instanceof ArrayBuffer ? value : await new Response(value).arrayBuffer();
      serializedValue = bytesToBase64(new Uint8Array(buffer));
      isBase64 = true;
    }

    const body: Record<string, unknown> = {
      binding: this.binding,
      key,
      value: serializedValue,
      ...(isBase64 && { base64: true }),
    };
    if (options?.expiration) {
      body.expiration = options.expiration;
    }
    if (options?.expirationTtl) {
      body.expiration_ttl = options.expirationTtl;
    }
    if (options?.metadata) {
      body.metadata = options.metadata;
    }
    await this.client.fetch('/kv/put', body);
  }

  async delete(key: string): Promise<void> {
    await this.client.fetch('/kv/delete', { binding: this.binding, key });
  }

  async list<M = unknown>(
    options?: KVNamespaceListOptions,
  ): Promise<KVNamespaceListResult<M, string>> {
    const res = await this.client.fetch('/kv/list', {
      binding: this.binding,
      prefix: options?.prefix,
      limit: options?.limit,
      cursor: options?.cursor,
    });
    return (await res.json()) as KVNamespaceListResult<M, string>;
  }
}
