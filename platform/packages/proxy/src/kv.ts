import { Hono } from 'hono';
import { asString, isQueryValue } from './body.ts';
import { dispatchToWorker } from './dispatch.ts';
import { resolveResource } from './resolve.ts';
import type { ProxyEnv } from './types.ts';

const CF_API = 'https://api.cloudflare.com/client/v4';

const kv = new Hono<ProxyEnv>();

kv.post('/get', async (context) => {
  const body = context.get('body');
  const projectId = context.get('projectId');
  const binding = asString(body.binding);
  const key = asString(body.key);

  if (!binding || !key) {
    return context.json({ error: 'binding and key required' }, 400);
  }

  // Try WfP dispatch first
  const dispatchRes = await dispatchToWorker(context.env, projectId, '/kv/get', body, {
    fallbackOnDispatchError: true,
  });
  if (dispatchRes) {
    return dispatchRes;
  }

  // Fallback: CF REST API
  let nsId: string;
  try {
    nsId = await resolveResource(context.env.API, context.env.JWT_SECRET, projectId, 'kv', binding);
  } catch {
    return context.json({ error: `unknown binding "${binding}"` }, 404);
  }

  const cfRes = await fetch(
    `${CF_API}/accounts/${context.env.CF_ACCOUNT_ID}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${context.env.CF_API_TOKEN}` } },
  );

  if (cfRes.status === 404) {
    return context.json(null);
  }

  if (!cfRes.ok) {
    return context.json({ error: 'KV get failed', status: cfRes.status }, 502);
  }

  const type = asString(body.type) ?? 'text';
  if (type === 'json') {
    return context.json(await cfRes.json());
  }
  if (type === 'arrayBuffer') {
    return new Response(await cfRes.arrayBuffer(), {
      headers: { 'content-type': 'application/octet-stream' },
    });
  }
  if (type === 'stream') {
    return new Response(cfRes.body, {
      headers: { 'content-type': 'application/octet-stream' },
    });
  }
  return context.json(await cfRes.text());
});

kv.post('/put', async (context) => {
  const body = context.get('body');
  const projectId = context.get('projectId');
  const binding = asString(body.binding);
  const key = asString(body.key);

  if (!binding || !key) {
    return context.json({ error: 'binding and key required' }, 400);
  }

  // Try WfP dispatch first
  const dispatchRes = await dispatchToWorker(context.env, projectId, '/kv/put', body);
  if (dispatchRes) {
    return dispatchRes;
  }

  // Fallback: CF REST API
  let nsId: string;
  try {
    nsId = await resolveResource(context.env.API, context.env.JWT_SECRET, projectId, 'kv', binding);
  } catch {
    return context.json({ error: `unknown binding "${binding}"` }, 404);
  }

  const params = new URLSearchParams();
  if (isQueryValue(body.expiration)) {
    params.set('expiration', String(body.expiration));
  }
  if (isQueryValue(body.expiration_ttl)) {
    params.set('expiration_ttl', String(body.expiration_ttl));
  }
  const queryString = params.toString() ? `?${params.toString()}` : '';

  let value: string | ArrayBuffer;
  let contentType = 'text/plain';
  if (body.base64 === true && typeof body.value === 'string') {
    // Decode base64-encoded binary data from the client
    const binary = atob(body.value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    value = bytes.buffer;
    contentType = 'application/octet-stream';
  } else {
    value = typeof body.value === 'string' ? body.value : JSON.stringify(body.value);
  }

  const cfRes = await fetch(
    `${CF_API}/accounts/${context.env.CF_ACCOUNT_ID}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(key)}${queryString}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${context.env.CF_API_TOKEN}`,
        'Content-Type': contentType,
      },
      body: value,
    },
  );

  if (!cfRes.ok) {
    return context.json({ error: 'KV put failed', status: cfRes.status }, 502);
  }

  return context.json({ success: true });
});

kv.post('/delete', async (context) => {
  const body = context.get('body');
  const projectId = context.get('projectId');
  const binding = asString(body.binding);
  const key = asString(body.key);

  if (!binding || !key) {
    return context.json({ error: 'binding and key required' }, 400);
  }

  // Try WfP dispatch first
  const dispatchRes = await dispatchToWorker(context.env, projectId, '/kv/delete', body);
  if (dispatchRes) {
    return dispatchRes;
  }

  // Fallback: CF REST API
  let nsId: string;
  try {
    nsId = await resolveResource(context.env.API, context.env.JWT_SECRET, projectId, 'kv', binding);
  } catch {
    return context.json({ error: `unknown binding "${binding}"` }, 404);
  }

  const cfRes = await fetch(
    `${CF_API}/accounts/${context.env.CF_ACCOUNT_ID}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(key)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${context.env.CF_API_TOKEN}` },
    },
  );

  // 404 is fine — delete is idempotent
  if (!cfRes.ok && cfRes.status !== 404) {
    return context.json({ error: 'KV delete failed', status: cfRes.status }, 502);
  }

  return context.json({ success: true });
});

kv.post('/list', async (context) => {
  const body = context.get('body');
  const projectId = context.get('projectId');
  const binding = asString(body.binding);

  if (!binding) {
    return context.json({ error: 'binding required' }, 400);
  }

  // Try WfP dispatch first
  const dispatchRes = await dispatchToWorker(context.env, projectId, '/kv/list', body, {
    fallbackOnDispatchError: true,
  });
  if (dispatchRes) {
    return dispatchRes;
  }

  // Fallback: CF REST API
  let nsId: string;
  try {
    nsId = await resolveResource(context.env.API, context.env.JWT_SECRET, projectId, 'kv', binding);
  } catch {
    return context.json({ error: `unknown binding "${binding}"` }, 404);
  }

  const params = new URLSearchParams();
  const prefix = asString(body.prefix);
  if (prefix) {
    params.set('prefix', prefix);
  }
  if (isQueryValue(body.limit)) {
    params.set('limit', String(body.limit));
  }
  const cursor = asString(body.cursor);
  if (cursor) {
    params.set('cursor', cursor);
  }
  const queryString = params.toString() ? `?${params.toString()}` : '';

  const cfRes = await fetch(
    `${CF_API}/accounts/${context.env.CF_ACCOUNT_ID}/storage/kv/namespaces/${nsId}/keys${queryString}`,
    { headers: { Authorization: `Bearer ${context.env.CF_API_TOKEN}` } },
  );

  if (!cfRes.ok) {
    return context.json({ error: 'KV list failed', status: cfRes.status }, 502);
  }

  const data = await cfRes.json<{
    result?: ReadonlyArray<{ name: string }>;
    result_info?: { cursor?: string };
  }>();
  return context.json({
    keys: data.result ?? [],
    list_complete: !data.result_info?.cursor,
    cursor: data.result_info?.cursor ?? null,
  });
});

export { kv };
