import { isRecord } from '@void/deploy-core';
import { usageLimitResponse } from '@void/edge';
import { verifyEmailReceipt } from '@void/platform/email-protocol';
import { isProjectId } from '@voidcloud/api/id';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ai } from './ai.ts';
import { asString } from './body.ts';
import { proxyCapabilityEnabled } from './capabilities.ts';
import { d1 } from './d1.ts';
import { email } from './email.ts';
import { guardHumanStream } from './human-stream.ts';
import { kv } from './kv.ts';
import { PLATFORM_DISABLED_KEY, PLATFORM_DISABLED_VALUE } from './platform-lifecycle.ts';
import { verifyTenantProxyToken } from './proxy-token.ts';
import { r2 } from './r2.ts';
import { readRequestJson, requestBodyMaxBytes, RequestBodyError } from './request-body.ts';
import { verifyPrerenderAuthority, verifyProjectDeployAccess } from './resolve.ts';
import { revalidate } from './revalidate.ts';
import type { Env, JwtPayload, ProxyBody, ProxyEnv } from './types.ts';

const app = new Hono<ProxyEnv>();

app.use('/*', async (context, next) => {
  const healthProbeToken = context.env.PLATFORM_HEALTH_PROBE_TOKEN;
  const installerProbe =
    healthProbeToken !== undefined &&
    healthProbeToken !== '' &&
    context.req.path === '/health' &&
    context.req.header('X-Void-Platform-Probe') === healthProbeToken;
  if (
    !installerProbe &&
    (context.env.PLATFORM_TRAFFIC_STATE === 'staging' ||
      context.env.PLATFORM_TRAFFIC_STATE === 'sandbox-drain' ||
      (context.env.PLATFORM_INSTALLATION_ID &&
        (await context.env.ROUTING.get(PLATFORM_DISABLED_KEY)) === PLATFORM_DISABLED_VALUE))
  ) {
    return context.json({ error: 'Platform disabled' }, 503);
  }
  await next();
});

// CORS
app.use(
  '/*',
  cors({
    origin: '*',
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['content-type', 'authorization'],
  }),
);

// Health check
app.get('/health', (context) =>
  context.json({
    ok: true,
    bindings: {
      ai: !!context.env.AI,
      kv: !!context.env.ROUTING,
      jwt: !!context.env.JWT_SECRET,
      api: !!context.env.API,
      sendEmail: !!context.env.SEND_EMAIL,
      emailDomain: !!context.env.EMAIL_SENDER_DOMAIN,
    },
  }),
);

// Reject non-POST for all other routes
app.all('/*', async (context, next) => {
  if (context.req.method !== 'POST') {
    return context.json({ error: 'method not allowed' }, 405);
  }
  await next();
});

// The tenant calls this over its internal service binding. EMAIL_SIGNING_SECRET never
// enters the tenant, so a project token cannot mint a gateway receipt.
app.post('/email/verify-receipt', async (context) => {
  let body: unknown;
  try {
    body = await readRequestJson(context.req.raw, 2 * 1024);
  } catch {
    return context.json({ valid: false }, 400);
  }
  if (!body || typeof body !== 'object') {
    return context.json({ valid: false }, 400);
  }
  const input = body as Record<string, unknown>;
  if (
    typeof input.projectId !== 'string' ||
    input.projectId.length > 128 ||
    typeof input.deploymentId !== 'string' ||
    input.deploymentId.length > 128 ||
    typeof input.recipient !== 'string' ||
    input.recipient.length > 320 ||
    typeof input.receipt !== 'string' ||
    input.receipt.length > 1536
  ) {
    return context.json({ valid: false }, 400);
  }
  if (!isProjectId(input.projectId)) {
    return context.json({ valid: false }, 403);
  }
  const tokenCheck = await verifyTenantProxyToken(
    context.env,
    input.projectId,
    context.req.header('x-void-internal') ?? '',
  );
  if (tokenCheck !== 'ok') {
    return context.json({ valid: false }, tokenCheck === 'unavailable' ? 503 : 403);
  }
  if (!context.env.EMAIL_SIGNING_SECRET) {
    return context.json({ valid: false }, 503);
  }
  const claims = await verifyEmailReceipt(input.receipt, context.env.EMAIL_SIGNING_SECRET, {
    projectId: input.projectId,
    deploymentId: input.deploymentId,
    recipient: input.recipient,
  });
  return context.json({ valid: claims !== null, receiptId: claims?.receiptId });
});

// The former relay endpoint is gone. Reject it before the generic JSON auth
// middleware so an untrusted MIME stream is never parsed or buffered here.
app.post('/email/relay', (context) => context.json({ error: 'not found' }, 404));

// Auth middleware — parses body, authenticates, sets projectId
app.post('/*', async (context, next) => {
  const url = new URL(context.req.url);
  const path = url.pathname;

  // Check credentials before buffering up to 8 MiB of JSON. Header tokens are
  // verified here. Body tokens (projectId + aiToken) come only from deployed
  // Workers over the __VOID_PROXY service binding, which calls bare hosts
  // (https://ai-proxy, https://proxy, https://email-proxy). Public hostnames
  // always contain a dot, so a public request without a header is refused unread.
  const authHeader = context.req.header('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const payload = token ? await verifyJwt(token, context.env.JWT_SECRET) : null;
  if (authHeader !== undefined && !payload) {
    return context.json(
      {
        error: 'invalid or expired token',
        message:
          'This proxy credential is invalid or expired. Sign in to the connected platform again for remote development, or restart the build to obtain a fresh prerender token.',
      },
      401,
    );
  }
  if (authHeader === undefined && url.hostname.includes('.')) {
    return context.json(
      {
        error: 'authorization required',
        message: 'Send a Void platform token in the Authorization header.',
      },
      401,
    );
  }

  let body: ProxyBody;
  try {
    // Five MiB of MIME expands to about seven MiB of base64, plus JSON metadata.
    const maxBytes =
      path === '/email' || path.startsWith('/email/') ? 8 * 1024 * 1024 : requestBodyMaxBytes(path);
    const json = await readRequestJson(context.req.raw, maxBytes);
    if (!isRecord(json)) {
      return context.json({ error: 'invalid JSON body' }, 400);
    }
    body = json;
  } catch (error) {
    if (path !== '/email' && !path.startsWith('/email/') && error instanceof RequestBodyError) {
      return context.json({ error: error.message }, error.status);
    }
    return context.json({ error: 'invalid JSON body' }, 400);
  }
  context.set('body', body);

  let revalidateHuman: (() => Promise<boolean>) | undefined;
  if (payload) {
    // HTTPS path (local dev) — JWT verified above
    const projectId = asString(body.projectId);
    if (!projectId) {
      return context.json({ error: 'projectId required' }, 400);
    }
    if (payload.aud === 'prerender') {
      // Prerender credentials are short-lived and already pinned to one
      // project by the API that minted them. Never turn one into a general
      // owner token by accepting a caller-selected projectId.
      if (!payload.project || payload.project !== projectId) {
        return context.json(
          {
            error: 'forbidden',
            message:
              'This prerender token does not match the requested project. Restart the build with a prerender token issued for the selected project.',
          },
          403,
        );
      }
      const active = await verifyPrerenderAuthority(
        context.env.API,
        context.env.JWT_SECRET,
        projectId,
        payload.sub,
        {
          ...(payload.build ? { buildId: payload.build } : {}),
          ...(payload.credential ? { credentialId: payload.credential } : {}),
        },
      );
      if (!active) {
        return context.json(
          {
            error: payload.credential
              ? 'prerender token credential is no longer active'
              : payload.build
                ? 'prerender token build is no longer active'
                : 'prerender token authority is no longer active',
            message: payload.credential
              ? 'The deploy credential used for prerendering is no longer authorized. Ask the project owner for an active deploy credential, then restart the build.'
              : payload.build
                ? 'This build is no longer authorized to prerender. Start a new build to obtain a fresh prerender token.'
                : 'This prerender token is no longer authorized. Confirm your project access with a project admin or owner, then restart the build to obtain a fresh token.',
          },
          403,
        );
      }
    } else {
      // Full API tokens retain the local-development ownership lookup.
      const checkOwner = () =>
        verifyProjectDeployAccess(
          context.env.API,
          context.env.JWT_SECRET,
          projectId,
          payload.sub,
          token,
          context.req.header('Cf-Access-Jwt-Assertion'),
          new URL(context.req.url).origin,
        );
      revalidateHuman = async () => payload.exp > Date.now() / 1000 && (await checkOwner());
      if (!(await revalidateHuman())) {
        return context.json(
          {
            error: 'forbidden',
            message:
              'Remote access could not be authorized. Check the selected platform and project, then ask a project admin or owner to confirm your access. If your access is correct, retry shortly.',
          },
          403,
        );
      }
    }
    context.set('projectId', projectId);
  } else {
    // Service binding path (production) — verify the project token
    const projectId = asString(body.projectId);
    const aiToken = asString(body.aiToken);
    if (!projectId || !aiToken) {
      return context.json({ error: 'projectId and aiToken required' }, 400);
    }
    if (!isProjectId(projectId)) {
      return context.json({ error: 'invalid project token' }, 403);
    }
    const tokenCheck = await verifyTenantProxyToken(context.env, projectId, aiToken);
    if (tokenCheck === 'unavailable') {
      return context.json({ error: 'project token state unavailable' }, 503);
    }
    if (tokenCheck === 'invalid') {
      return context.json({ error: 'invalid project token' }, 403);
    }
    context.set('projectId', projectId);
  }

  await next();
  if (
    revalidateHuman &&
    context.res.body &&
    (context.res.headers.get('content-type')?.includes('text/event-stream') ||
      path.startsWith('/ai/') ||
      path === '/r2/get')
  ) {
    context.res = new Response(
      guardHumanStream(context.res.body, revalidateHuman, context.req.raw.signal),
      context.res,
    );
  }
});

// Check the installation capability before spending quota or calling AI.
app.post('/ai/*', async (context, next) => {
  if (!proxyCapabilityEnabled(context.env.PLATFORM_CAPABILITIES, 'ai')) {
    return context.json(
      {
        error: 'platform capability unavailable',
        capability: 'ai',
        message: 'This Void platform does not enable AI.',
      },
      501,
    );
  }
  if (await context.env.ROUTING.get(`ai-block:${context.get('projectId')}`, { cacheTtl: 60 })) {
    return usageLimitResponse({
      code: 'usage_limit',
      resource: 'ai',
      reason: 'monthly_quota',
      message: 'AI usage limit exceeded',
    });
  }
  await next();
});

// Same gate for the email group. A deployed worker on a platform without
// the email module still holds `__VOID_PROXY` and a valid project token, so
// an explicit-`from` `sendEmail()` reaches `/email/send` and would otherwise
// answer with the sender-domain / send-binding configuration failures — or
// send, if the operator left the bindings in place.
app.post('/email/*', async (context, next) => {
  if (!proxyCapabilityEnabled(context.env.PLATFORM_CAPABILITIES, 'email')) {
    return context.json(
      {
        error: 'platform capability unavailable',
        capability: 'email',
        message: 'This Void platform does not enable email.',
      },
      501,
    );
  }
  await next();
});

// Route groups
app.route('/ai', ai);
app.route('/d1', d1);
app.route('/kv', kv);
app.route('/r2', r2);
app.route('/revalidate', revalidate);
app.route('/email', email);

export default { fetch: app.fetch };

// --- JWT verification ---

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let cachedVerifyKey: CryptoKey | undefined;
let cachedKeySecret: string | undefined;

async function getVerifyKey(secret: string): Promise<CryptoKey> {
  if (cachedVerifyKey && cachedKeySecret === secret) {
    return cachedVerifyKey;
  }
  cachedVerifyKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  cachedKeySecret = secret;
  return cachedVerifyKey;
}

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  return Uint8Array.from(binary, (context) => context.charCodeAt(0));
}

async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const [header, body, signature] = parts;

  try {
    const key = await getVerifyKey(secret);
    const sigBytes = base64urlDecode(signature);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes.buffer as ArrayBuffer,
      encoder.encode(`${header}.${body}`),
    );
    if (!valid) {
      return null;
    }

    const payload = JSON.parse(decoder.decode(base64urlDecode(body))) as JwtPayload;

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) {
      return null;
    }

    if (payload.aud !== 'api' && payload.aud !== 'prerender') {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
