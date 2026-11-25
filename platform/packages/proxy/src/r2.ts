import { Hono } from 'hono';
import { asString, isQueryValue } from './body.ts';
import { dispatchToWorker } from './dispatch.ts';
import { resolveResource } from './resolve.ts';
import type { ProxyEnv } from './types.ts';

const CF_API = 'https://api.cloudflare.com/client/v4';

const r2 = new Hono<ProxyEnv>();

function cfHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

r2.post('/get', async (context) => {
  const body = context.get('body');
  const projectId = context.get('projectId');
  const binding = asString(body.binding);
  const key = asString(body.key);

  if (!binding || !key) {
    return context.json({ error: 'binding and key required' }, 400);
  }

  // Try WfP dispatch first
  const dispatchRes = await dispatchToWorker(context.env, projectId, '/r2/get', body, {
    fallbackOnDispatchError: true,
  });
  if (dispatchRes) {
    return dispatchRes;
  }

  // Fallback: CF REST API
  let bucket: string;
  try {
    bucket = await resolveResource(
      context.env.API,
      context.env.JWT_SECRET,
      projectId,
      'r2',
      binding,
    );
  } catch {
    return context.json({ error: `unknown binding "${binding}"` }, 404);
  }

  const cfRes = await fetch(
    `${CF_API}/accounts/${context.env.CF_ACCOUNT_ID}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`,
    { headers: cfHeaders(context.env.CF_API_TOKEN) },
  );

  if (cfRes.status === 404) {
    return context.json(null);
  }

  if (!cfRes.ok) {
    return context.json({ error: 'R2 get failed', status: cfRes.status }, 502);
  }

  // Stream the object body back, preserve metadata in headers
  const headers = new Headers();
  headers.set('content-type', cfRes.headers.get('content-type') ?? 'application/octet-stream');
  for (const name of ['content-length', 'etag', 'last-modified']) {
    const value = cfRes.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }

  return new Response(cfRes.body, { headers });
});

r2.on('POST', ['/put', '/put-conditional'], async (context) => {
  const body = context.get('body');
  const projectId = context.get('projectId');
  const binding = asString(body.binding);
  const key = asString(body.key);
  const base64 = asString(body.base64);

  if (!binding || !key) {
    return context.json({ error: 'binding and key required' }, 400);
  }

  // Try WfP dispatch first
  const conditional = body.onlyIf !== undefined || context.req.path.endsWith('/put-conditional');
  const dispatchRes = await dispatchToWorker(
    context.env,
    projectId,
    conditional ? '/r2/put-conditional' : '/r2/put',
    body,
  );
  if (dispatchRes) {
    return dispatchRes;
  }

  if (conditional) {
    return context.json(
      {
        error:
          'R2 conditional writes require an active deployment with the current Void remote-binding handler. Update your Void platform and redeploy the project.',
      },
      501,
    );
  }

  // Fallback: CF REST API
  let bucket: string;
  try {
    bucket = await resolveResource(
      context.env.API,
      context.env.JWT_SECRET,
      projectId,
      'r2',
      binding,
    );
  } catch {
    return context.json({ error: `unknown binding "${binding}"` }, 404);
  }

  // Decode base64 value from JSON body, or use text value
  const data = base64
    ? Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))
    : new TextEncoder().encode(String(body.value ?? ''));

  const cfRes = await fetch(
    `${CF_API}/accounts/${context.env.CF_ACCOUNT_ID}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`,
    {
      method: 'PUT',
      headers: {
        ...cfHeaders(context.env.CF_API_TOKEN),
        'Content-Type': asString(body.contentType) ?? 'application/octet-stream',
      },
      body: data,
    },
  );

  if (!cfRes.ok) {
    return context.json({ error: 'R2 put failed', status: cfRes.status }, 502);
  }

  return context.json({ success: true });
});

r2.post('/delete', async (context) => {
  const body = context.get('body');
  const projectId = context.get('projectId');
  const binding = asString(body.binding);

  if (!binding) {
    return context.json({ error: 'binding required' }, 400);
  }

  const keys =
    Array.isArray(body.keys) && body.keys.every((key): key is string => typeof key === 'string')
      ? body.keys
      : typeof body.key === 'string'
        ? [body.key]
        : [];

  if (keys.length === 0) {
    return context.json({ error: 'key or keys required' }, 400);
  }

  // Try WfP dispatch first
  const dispatchRes = await dispatchToWorker(context.env, projectId, '/r2/delete', body);
  if (dispatchRes) {
    return dispatchRes;
  }

  // Fallback: CF REST API
  let bucket: string;
  try {
    bucket = await resolveResource(
      context.env.API,
      context.env.JWT_SECRET,
      projectId,
      'r2',
      binding,
    );
  } catch {
    return context.json({ error: `unknown binding "${binding}"` }, 404);
  }

  for (const key of keys) {
    const cfRes = await fetch(
      `${CF_API}/accounts/${context.env.CF_ACCOUNT_ID}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`,
      {
        method: 'DELETE',
        headers: cfHeaders(context.env.CF_API_TOKEN),
      },
    );
    if (!cfRes.ok && cfRes.status !== 404) {
      return context.json({ error: 'R2 delete failed', status: cfRes.status }, 502);
    }
  }

  return context.json({ success: true });
});

r2.post('/list', async (context) => {
  const body = context.get('body');
  const projectId = context.get('projectId');
  const binding = asString(body.binding);

  if (!binding) {
    return context.json({ error: 'binding required' }, 400);
  }

  // Try WfP dispatch first
  const dispatchRes = await dispatchToWorker(context.env, projectId, '/r2/list', body, {
    fallbackOnDispatchError: true,
  });
  if (dispatchRes) {
    return dispatchRes;
  }

  // Fallback: CF REST API
  let bucket: string;
  try {
    bucket = await resolveResource(
      context.env.API,
      context.env.JWT_SECRET,
      projectId,
      'r2',
      binding,
    );
  } catch {
    return context.json({ error: `unknown binding "${binding}"` }, 404);
  }

  const params = new URLSearchParams();
  const prefix = asString(body.prefix);
  if (prefix) {
    params.set('prefix', prefix);
  }
  if (isQueryValue(body.limit)) {
    params.set('per_page', String(body.limit));
  }
  const cursor = asString(body.cursor);
  if (cursor) {
    params.set('cursor', cursor);
  }
  const delimiter = asString(body.delimiter);
  if (delimiter) {
    params.set('delimiter', delimiter);
  }
  const queryString = params.toString() ? `?${params.toString()}` : '';

  const cfRes = await fetch(
    `${CF_API}/accounts/${context.env.CF_ACCOUNT_ID}/r2/buckets/${bucket}/objects${queryString}`,
    { headers: cfHeaders(context.env.CF_API_TOKEN) },
  );

  if (!cfRes.ok) {
    return context.json({ error: 'R2 list failed', status: cfRes.status }, 502);
  }

  const data = await cfRes.json<{
    result?: ReadonlyArray<{ key: string; size: number; last_modified?: string }>;
    result_info?: { cursor?: string };
  }>();

  return context.json({
    objects: (data.result ?? []).map((object) => ({
      key: object.key,
      size: object.size,
      lastModified: object.last_modified ?? '',
    })),
    truncated: !!data.result_info?.cursor,
    cursor: data.result_info?.cursor ?? null,
  });
});

r2.post('/head', async (context) => {
  const body = context.get('body');
  const projectId = context.get('projectId');
  const binding = asString(body.binding);
  const key = asString(body.key);

  if (!binding || !key) {
    return context.json({ error: 'binding and key required' }, 400);
  }

  // Try WfP dispatch first
  const dispatchRes = await dispatchToWorker(context.env, projectId, '/r2/head', body, {
    fallbackOnDispatchError: true,
  });
  if (dispatchRes) {
    return dispatchRes;
  }

  // Fallback: CF REST API
  let bucket: string;
  try {
    bucket = await resolveResource(
      context.env.API,
      context.env.JWT_SECRET,
      projectId,
      'r2',
      binding,
    );
  } catch {
    return context.json({ error: `unknown binding "${binding}"` }, 404);
  }

  const cfRes = await fetch(
    `${CF_API}/accounts/${context.env.CF_ACCOUNT_ID}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`,
    {
      method: 'HEAD',
      headers: cfHeaders(context.env.CF_API_TOKEN),
    },
  );

  if (cfRes.status === 404) {
    return context.json(null);
  }

  if (!cfRes.ok) {
    return context.json({ error: 'R2 head failed', status: cfRes.status }, 502);
  }

  return context.json({
    key,
    size: Number.parseInt(cfRes.headers.get('content-length') ?? '0'),
    etag: cfRes.headers.get('etag') ?? '',
    lastModified: cfRes.headers.get('last-modified') ?? '',
    contentType: cfRes.headers.get('content-type') ?? 'application/octet-stream',
  });
});

export { r2 };
