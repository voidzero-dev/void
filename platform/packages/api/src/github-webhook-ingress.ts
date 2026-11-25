import {
  createGitHubWebhookIngressProof,
  GITHUB_DELIVERY_HEADER,
  GITHUB_EVENT_HEADER,
  GITHUB_SIGNATURE_HEADER,
  GitHubWebhookRequestError,
  INGRESS_PROOF_HEADER,
  INGRESS_TIMESTAMP_HEADER,
  readBoundedGitHubWebhookBody,
  readGitHubWebhookHeaders,
  validGitHubWebhookIngressSecret,
} from './github/webhook-ingress-auth.ts';
import { verifyGithubWebhookSignature } from './github/webhook-verify.ts';

export type GitHubWebhookIngressEnv = {
  API: Fetcher;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_WEBHOOK_INGRESS_SECRET?: string;
};

function json(body: Record<string, unknown>, status: number, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  if (!headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'no-store');
  }
  return Response.json(body, { status, headers });
}

export async function githubWebhookIngressFetch(
  request: Request,
  env: GitHubWebhookIngressEnv,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== '/github' || url.search !== '') {
    return json({ error: 'not found' }, 404);
  }
  if (request.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405, { Allow: 'POST' });
  }

  const webhookSecret = env.GITHUB_WEBHOOK_SECRET;
  const ingressSecret = env.GITHUB_WEBHOOK_INGRESS_SECRET;
  if (
    !webhookSecret ||
    !validGitHubWebhookIngressSecret(ingressSecret) ||
    webhookSecret === ingressSecret
  ) {
    return json({ error: 'github webhook ingress not configured' }, 503);
  }

  let raw: Uint8Array;
  let event: string;
  let deliveryId: string;
  let signature: string;
  try {
    const headers = readGitHubWebhookHeaders(request.headers, { requireDelivery: true });
    event = headers.event;
    deliveryId = headers.deliveryId;
    signature = headers.signature;
    raw = await readBoundedGitHubWebhookBody(request);
  } catch (error) {
    if (error instanceof GitHubWebhookRequestError) {
      return json({ error: error.code }, error.status);
    }
    throw error;
  }

  // Drop unauthenticated traffic before invoking the protected API Worker.
  if (!(await verifyGithubWebhookSignature(raw, signature, webhookSecret))) {
    return json({ error: 'invalid signature' }, 401);
  }

  const timestampSeconds = Math.floor(Date.now() / 1000);
  const proof = await createGitHubWebhookIngressProof({
    secret: ingressSecret,
    timestampSeconds,
    deliveryId,
    event,
    body: raw,
  });

  // Construct a new request from an explicit allow-list. In particular, caller
  // Authorization, Cookie, and Cloudflare Access headers never cross the binding.
  const headers = new Headers({
    'Content-Type': 'application/json',
    [GITHUB_EVENT_HEADER]: event,
    [GITHUB_DELIVERY_HEADER]: deliveryId,
    [GITHUB_SIGNATURE_HEADER]: signature,
    [INGRESS_TIMESTAMP_HEADER]: String(timestampSeconds),
    [INGRESS_PROOF_HEADER]: proof,
  });
  let response: Response;
  try {
    response = await env.API.fetch(
      new Request('https://void-api.internal/internal/github-webhook', {
        method: 'POST',
        headers,
        body: raw.slice().buffer,
      }),
    );
  } catch (error) {
    console.error('[github-webhook-ingress] API service binding failed:', error);
    return json({ error: 'upstream unavailable' }, 502);
  }

  // Do not reflect arbitrary internal response headers onto the public ingress.
  return new Response(response.body, {
    status: response.status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': response.headers.get('Content-Type') ?? 'application/json',
    },
  });
}

export default {
  fetch: githubWebhookIngressFetch,
} satisfies ExportedHandler<GitHubWebhookIngressEnv>;
