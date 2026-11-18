// Local model-proxy stand-in for spikes S2/S3 (`--local-gateway` mode). It runs in its own
// container on two Docker networks: the scan network (no route out, alias
// `model.scan.internal`) and an egress network. The engine container reaches only this
// proxy. The proxy adds the Cloudflare token (read from a read-only mounted file the engine
// never sees) and forwards to the AI Gateway REST route:
//   Messages  -> POST https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1/messages
//   Responses -> POST https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1/responses
// with `cf-aig-gateway-id`, payload logging off, cache skipped and a `securityScan`
// metadata tag. Caller `cf-aig-*` headers are dropped. PROXY_MODE:
//   gateway   forward with the token
//   no-token  forward without any credential (shows the gateway refuses the container alone)
//   stub-402  answer the gateway's own credits refusal without calling upstream
// Env: ENGINE (claude|codex), GATEWAY_ID, SCAN_ID, CREDENTIALS_DIR (files `account`, `token`),
// PROVIDER_RETRY_GUARD=1 (after one 402, answer later calls locally with the same 402).
// Every request is printed as one JSON line `{ "proxyRequest": ... }` (shapes, no values).
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { summarizeRequest } from './fake-model.mjs';

const mode = process.env.PROXY_MODE ?? 'gateway';
const engine = process.env.ENGINE ?? 'claude';
const gatewayId = process.env.GATEWAY_ID ?? 'void-spike-sa-gw';
const scanId = process.env.SCAN_ID ?? 'spike';
const dir = process.env.CREDENTIALS_DIR ?? '/run/void-spike';
const account = readFileSync(`${dir}/account`, 'utf8').trim();
const token = mode === 'gateway' ? readFileSync(`${dir}/token`, 'utf8').trim() : '';
const retryGuard = process.env.PROVIDER_RETRY_GUARD === '1';
// The gateway's credits refusal, recorded on 2026-11-18 (S2/S3 live preflight).
const CREDITS_MESSAGE =
  'Insufficient unified billing credits. Please add additional credits on the AI Gateway Cloudflare dashboard to continue using provider models.';
const STUB_402 =
  engine === 'codex'
    ? { error: { code: 'invalid_prompt', message: CREDITS_MESSAGE } }
    : { type: 'error', error: { type: 'invalid_request_error', message: CREDITS_MESSAGE } };
let creditsStop = false;

/** Token counts from a JSON body or an SSE stream (Messages or Responses). */
function usageOf(text) {
  const found = {};
  const visit = (value) => {
    if (!value || typeof value !== 'object') {
      return;
    }
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'usage' && inner && typeof inner === 'object') {
        for (const [name, count] of Object.entries(inner)) {
          if (typeof count === 'number') {
            found[name] = Math.max(found[name] ?? 0, count);
          }
        }
      } else {
        visit(inner);
      }
    }
  };
  for (const line of text.split('\n')) {
    const json = line.startsWith('data: ') ? line.slice(6) : line;
    if (json.startsWith('{')) {
      try {
        visit(JSON.parse(json));
      } catch {
        // partial line
      }
    }
  }
  return Object.keys(found).length ? found : undefined;
}

async function forward(path, bodyText, headers) {
  const body = JSON.parse(bodyText);
  const prefix = engine === 'codex' ? 'openai/' : 'anthropic/';
  if (typeof body.model === 'string' && !body.model.includes('/')) {
    body.model = prefix + body.model;
  }
  if (engine === 'codex') {
    body.access_programs = { cyber: 'standard' };
  }
  const route = path.includes('/responses') ? 'responses' : 'messages';
  return {
    routedModel: body.model,
    route,
    response: await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/${route}`,
      {
        method: 'POST',
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'content-type': 'application/json',
          accept: headers.accept || 'application/json',
          'anthropic-version': headers['anthropic-version'] || '2023-06-01',
          ...(headers['anthropic-beta'] ? { 'anthropic-beta': headers['anthropic-beta'] } : {}),
          'cf-aig-gateway-id': gatewayId,
          'cf-aig-collect-log-payload': 'false',
          'cf-aig-skip-cache': 'true',
          'cf-aig-metadata': JSON.stringify({ securityScan: scanId }),
        },
        body: JSON.stringify(body),
      },
    ),
  };
}

createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', async () => {
    const started = Date.now();
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const path = request.url ?? '/';
    const summary = summarizeRequest({
      method: request.method,
      path,
      headers: request.headers,
      bodyText,
    });
    const record = { host: request.headers.host ?? '', mode, ...summary };
    const isModelCall =
      request.method === 'POST' &&
      (path.includes('/messages') || path.includes('/responses')) &&
      !path.includes('count_tokens');
    try {
      if (!isModelCall) {
        record.status = 404;
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{"error":"model proxy: unknown route"}');
      } else if (mode === 'stub-402' || (retryGuard && creditsStop)) {
        record.status = 402;
        record.answeredLocally = true;
        response.writeHead(402, {
          'content-type': 'application/json',
          'x-void-scan-stop': 'credits',
        });
        response.end(JSON.stringify(STUB_402));
      } else {
        const {
          routedModel,
          route,
          response: upstream,
        } = await forward(path, bodyText, request.headers);
        record.status = upstream.status;
        record.routedModel = routedModel;
        record.route = route;
        record.cfAig = Object.fromEntries(
          [...upstream.headers].filter(([name]) =>
            ['cf-aig-cache-status', 'cf-aig-log-id', 'cf-aig-step'].includes(name),
          ),
        );
        const contentType = upstream.headers.get('content-type') || 'application/json';
        const text = await upstream.text();
        record.usage = upstream.ok ? usageOf(text) : undefined;
        if (!upstream.ok) {
          record.upstreamError = text.slice(0, 400);
          if (upstream.status === 402) {
            creditsStop = true;
          }
        }
        response.writeHead(upstream.status, {
          'content-type': contentType,
          ...(upstream.status === 402 ? { 'x-void-scan-stop': 'credits' } : {}),
        });
        response.end(text);
      }
    } catch (error) {
      record.status = 502;
      record.proxyError = String(error?.message ?? error).slice(0, 300);
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end('{"error":"model proxy: upstream failed"}');
    }
    record.ms = Date.now() - started;
    console.log(JSON.stringify({ proxyRequest: record }));
  });
}).listen(80, () => console.log(JSON.stringify({ proxyListening: 80, mode, engine })));
