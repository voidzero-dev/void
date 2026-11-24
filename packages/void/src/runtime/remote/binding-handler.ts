import { Hono } from 'hono';
import type { Context } from 'hono';
import { base64ToBytes } from '../../shared/base64.ts';
import { R2_OBJECT_HEADER, parseR2Conditional, parseR2HttpMetadata } from './r2-conditions.ts';

type BindingRequest = { binding: string };

/** Parse the body, answer 400 when `invalid` names a problem, and 404 for an unknown binding. */
async function readBindingRequest<T, B extends BindingRequest>(
  c: Context,
  env: Record<string, unknown>,
  invalid: (body: B) => string | undefined,
): Promise<{ body: B; binding: T } | Response> {
  const body = await c.req.json<B>();
  const error = invalid(body);
  if (error) {
    return c.json({ error }, 400);
  }
  const binding = env[body.binding] as T | undefined;
  if (!binding) {
    return c.json({ error: `unknown binding "${body.binding}"` }, 404);
  }
  return { body, binding };
}

function requireBinding(body: BindingRequest): string | undefined {
  return body.binding ? undefined : 'binding required';
}

function requireKey(body: BindingRequest & { key: string }): string | undefined {
  return body.binding && body.key ? undefined : 'binding and key required';
}

/** Object fields that ProxyR2Bucket reads. `contentType` serves older clients. */
function r2ObjectJson(obj: R2Object) {
  return {
    key: obj.key,
    size: obj.size,
    etag: obj.etag,
    version: obj.version,
    lastModified: obj.uploaded.toISOString(),
    contentType: obj.httpMetadata?.contentType ?? 'application/octet-stream',
    httpMetadata: obj.httpMetadata,
    customMetadata: obj.customMetadata,
  };
}

function r2DeleteKeys(body: { key?: string; keys?: Array<string> }): Array<string> {
  return body.keys ? body.keys : body.key ? [body.key] : [];
}

/**
 * Creates a Hono app that handles `/__void/*` routes for native binding access.
 * Deployed user workers expose this so the proxy can dispatch D1/KV/R2 operations
 * via Workers for Platforms instead of the Cloudflare REST API (~1-5ms vs ~50-200ms).
 *
 * Authenticated via `x-void-internal` header against `env.__VOID_PROXY_TOKEN`.
 * Response formats match the proxy's REST API responses, so ProxyClient
 * handles both paths.
 */
export function createBindingHandler(env: Record<string, unknown>): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const token = c.req.header('x-void-internal');
    const expected = env.__VOID_PROXY_TOKEN as string | undefined;
    if (!token || !expected || token !== expected) {
      return c.json({ error: 'unauthorized' }, 403);
    }
    await next();
  });

  // --- D1 ---

  app.post('/d1/query', async (c) => {
    const request = await readBindingRequest<
      D1Database,
      { binding: string; sql: string; params?: Array<unknown>; method?: string }
    >(c, env, (body) => (body.binding && body.sql ? undefined : 'binding and sql required'));
    if (request instanceof Response) {
      return request;
    }
    const { body, binding: db } = request;
    const stmt = db.prepare(body.sql).bind(...(body.params ?? []));

    switch (body.method) {
      case 'first': {
        const row = await stmt.first();
        return c.json(row);
      }
      case 'raw': {
        const raw = await stmt.raw({ columnNames: true });
        const columns = raw.length > 0 ? (raw[0] as Array<string>) : [];
        const results = raw.slice(1) as Array<Array<unknown>>;
        return c.json({ columns, results, meta: {} });
      }
      case 'run': {
        const result = await stmt.run();
        return c.json({ success: true, meta: result.meta });
      }
      case 'all':
      default: {
        const result = await stmt.all();
        return c.json({
          results: result.results,
          success: true,
          meta: result.meta,
        });
      }
    }
  });

  app.post('/d1/batch', async (c) => {
    const request = await readBindingRequest<
      D1Database,
      { binding: string; statements: Array<{ sql: string; params?: Array<unknown> }> }
    >(c, env, (body) =>
      body.binding && Array.isArray(body.statements)
        ? undefined
        : 'binding and statements required',
    );
    if (request instanceof Response) {
      return request;
    }
    const { body, binding: db } = request;
    const stmts = body.statements.map((s) => db.prepare(s.sql).bind(...(s.params ?? [])));
    const results = await db.batch(stmts);
    return c.json(
      results.map((r) => ({
        results: r.results,
        success: true,
        meta: r.meta,
      })),
    );
  });

  // --- KV ---

  app.post('/kv/get', async (c) => {
    const request = await readBindingRequest<
      KVNamespace,
      { binding: string; key: string; type?: string }
    >(c, env, requireKey);
    if (request instanceof Response) {
      return request;
    }
    const { body, binding: kv } = request;
    const type = body.type ?? 'text';
    if (type === 'json') {
      const val = await kv.get(body.key, 'json');
      return c.json(val);
    }
    if (type === 'arrayBuffer') {
      const val = await kv.get(body.key, 'arrayBuffer');
      if (val === null) {
        return c.json(null);
      }
      return new Response(val, {
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    if (type === 'stream') {
      const val = await kv.get(body.key, 'stream');
      if (val === null) {
        return c.json(null);
      }
      return new Response(val, {
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    return c.json(await kv.get(body.key, 'text'));
  });

  app.post('/kv/put', async (c) => {
    const request = await readBindingRequest<
      KVNamespace,
      {
        binding: string;
        key: string;
        value: unknown;
        base64?: boolean;
        expiration?: number;
        expiration_ttl?: number;
      }
    >(c, env, requireKey);
    if (request instanceof Response) {
      return request;
    }
    const { body, binding: kv } = request;
    const opts: KVNamespacePutOptions = {};
    if (body.expiration) {
      opts.expiration = body.expiration;
    }
    if (body.expiration_ttl) {
      opts.expirationTtl = body.expiration_ttl;
    }

    let value: string | ArrayBuffer;
    if (body.base64 && typeof body.value === 'string') {
      value = base64ToBytes(body.value).buffer as ArrayBuffer;
    } else {
      value = typeof body.value === 'string' ? body.value : JSON.stringify(body.value);
    }

    await kv.put(body.key, value, opts);
    return c.json({ success: true });
  });

  app.post('/kv/delete', async (c) => {
    const request = await readBindingRequest<KVNamespace, { binding: string; key: string }>(
      c,
      env,
      requireKey,
    );
    if (request instanceof Response) {
      return request;
    }
    await request.binding.delete(request.body.key);
    return c.json({ success: true });
  });

  app.post('/kv/list', async (c) => {
    const request = await readBindingRequest<
      KVNamespace,
      { binding: string; prefix?: string; limit?: number; cursor?: string }
    >(c, env, requireBinding);
    if (request instanceof Response) {
      return request;
    }
    const { body, binding: kv } = request;
    const opts: KVNamespaceListOptions = {};
    if (body.prefix) {
      opts.prefix = body.prefix;
    }
    if (body.limit) {
      opts.limit = body.limit;
    }
    if (body.cursor) {
      opts.cursor = body.cursor;
    }

    const result = await kv.list(opts);
    return c.json({
      keys: result.keys,
      list_complete: result.list_complete,
      cursor: result.list_complete ? null : result.cursor,
    });
  });

  // --- R2 ---

  app.post('/r2/get', async (c) => {
    const request = await readBindingRequest<R2Bucket, { binding: string; key: string }>(
      c,
      env,
      requireKey,
    );
    if (request instanceof Response) {
      return request;
    }
    const obj = await request.binding.get(request.body.key);
    if (!obj) {
      return c.json(null);
    }

    const headers = new Headers();
    headers.set('content-type', obj.httpMetadata?.contentType ?? 'application/octet-stream');
    headers.set('content-length', String(obj.size));
    if (obj.httpEtag) {
      headers.set('etag', obj.httpEtag);
    }
    // Header values must be ASCII, and custom metadata can hold any text.
    headers.set(R2_OBJECT_HEADER, encodeURIComponent(JSON.stringify(r2ObjectJson(obj))));

    return new Response(obj.body, { headers });
  });

  app.on('POST', ['/r2/put', '/r2/put-conditional'], async (c) => {
    const request = await readBindingRequest<
      R2Bucket,
      {
        binding: string;
        key: string;
        base64?: string;
        value?: string;
        contentType?: string;
        httpMetadata?: unknown;
        customMetadata?: Record<string, string>;
        onlyIf?: unknown;
      }
    >(c, env, requireKey);
    if (request instanceof Response) {
      return request;
    }
    const { body, binding: bucket } = request;
    const data = body.base64
      ? base64ToBytes(body.base64)
      : new TextEncoder().encode(body.value ?? '');

    let httpMetadata: R2HTTPMetadata | Headers;
    let onlyIf: R2Conditional | Headers | undefined;
    try {
      // Older clients send only `contentType`.
      httpMetadata =
        body.httpMetadata === undefined
          ? { contentType: body.contentType ?? 'application/octet-stream' }
          : parseR2HttpMetadata(body.httpMetadata);
      if (body.onlyIf !== undefined || c.req.path.endsWith('/put-conditional')) {
        onlyIf = parseR2Conditional(body.onlyIf);
      }
    } catch (error) {
      return c.json({ error: String(error) }, 400);
    }
    const obj = await bucket.put(body.key, data, {
      httpMetadata,
      customMetadata: body.customMetadata,
      onlyIf,
    });

    if (!obj) {
      return c.json(null);
    }
    return c.json(r2ObjectJson(obj));
  });

  app.post('/r2/delete', async (c) => {
    const request = await readBindingRequest<
      R2Bucket,
      { binding: string; key?: string; keys?: Array<string> }
    >(
      c,
      env,
      (body) =>
        requireBinding(body) ??
        (r2DeleteKeys(body).length === 0 ? 'key or keys required' : undefined),
    );
    if (request instanceof Response) {
      return request;
    }
    await request.binding.delete(r2DeleteKeys(request.body));
    return c.json({ success: true });
  });

  app.post('/r2/list', async (c) => {
    const request = await readBindingRequest<
      R2Bucket,
      {
        binding: string;
        prefix?: string;
        limit?: number;
        cursor?: string;
        delimiter?: string;
        startAfter?: string;
        include?: R2ListOptions['include'];
      }
    >(c, env, requireBinding);
    if (request instanceof Response) {
      return request;
    }
    const { body, binding: bucket } = request;
    const opts: R2ListOptions = {};
    if (body.prefix) {
      opts.prefix = body.prefix;
    }
    if (body.limit) {
      opts.limit = body.limit;
    }
    if (body.cursor) {
      opts.cursor = body.cursor;
    }
    if (body.delimiter) {
      opts.delimiter = body.delimiter;
    }
    if (body.startAfter) {
      opts.startAfter = body.startAfter;
    }
    if (Array.isArray(body.include)) {
      opts.include = body.include;
    }

    const result = await bucket.list(opts);
    return c.json({
      objects: result.objects.map(r2ObjectJson),
      truncated: result.truncated,
      cursor: result.truncated ? result.cursor : null,
      delimitedPrefixes: result.delimitedPrefixes,
    });
  });

  app.post('/r2/head', async (c) => {
    const request = await readBindingRequest<R2Bucket, { binding: string; key: string }>(
      c,
      env,
      requireKey,
    );
    if (request instanceof Response) {
      return request;
    }
    const obj = await request.binding.head(request.body.key);
    if (!obj) {
      return c.json(null);
    }

    return c.json(r2ObjectJson(obj));
  });

  return app;
}
