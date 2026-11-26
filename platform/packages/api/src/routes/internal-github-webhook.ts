import { Hono } from 'hono';
import type { ApiEnv } from '../env.ts';
import {
  GitHubWebhookRequestError,
  INGRESS_PROOF_HEADER,
  INGRESS_TIMESTAMP_HEADER,
  readBoundedGitHubWebhookBody,
  readGitHubWebhookHeaders,
  validGitHubWebhookIngressSecret,
  verifyGitHubWebhookIngressProof,
} from '../github/webhook-ingress-auth.ts';
import { verifyGithubWebhookSignature } from '../github/webhook-verify.ts';
import { handleVerifiedGitHubWebhook } from './webhooks.ts';

const app = new Hono<ApiEnv>();

/** Fixed service-binding operation used only by the optional GitHub ingress Worker. */
app.post('/', async (context) => {
  const ingressSecret = context.env.GITHUB_WEBHOOK_INGRESS_SECRET;
  const webhookSecret = context.env.GITHUB_WEBHOOK_SECRET;
  if (
    !validGitHubWebhookIngressSecret(ingressSecret) ||
    !webhookSecret ||
    ingressSecret === webhookSecret
  ) {
    return context.json({ error: 'github webhook ingress not configured' }, 503);
  }

  let raw: Uint8Array;
  let event: string;
  let deliveryId: string;
  let signature: string;
  try {
    const headers = readGitHubWebhookHeaders(context.req.raw.headers, { requireDelivery: true });
    event = headers.event;
    deliveryId = headers.deliveryId;
    signature = headers.signature;
    raw = await readBoundedGitHubWebhookBody(context.req.raw);
  } catch (error) {
    if (error instanceof GitHubWebhookRequestError) {
      return context.json({ error: error.code }, error.status);
    }
    throw error;
  }

  const proofIsValid = await verifyGitHubWebhookIngressProof({
    secret: ingressSecret,
    timestampHeader: context.req.header(INGRESS_TIMESTAMP_HEADER) ?? null,
    proofHeader: context.req.header(INGRESS_PROOF_HEADER) ?? null,
    deliveryId,
    event,
    body: raw,
  });
  if (!proofIsValid) {
    return context.json({ error: 'invalid ingress proof' }, 401);
  }

  // Verify GitHub independently at the API boundary. The ingress also performs
  // this check before spending a service-binding call, but its assertion is not
  // substituted for the API's own trust decision.
  if (!(await verifyGithubWebhookSignature(raw, signature, webhookSecret))) {
    return context.json({ error: 'invalid signature' }, 401);
  }

  // The processing handler receives the already-verified raw bytes; no body is
  // parsed or reserialized between GitHub's HMAC check and event dispatch.
  return handleVerifiedGitHubWebhook(context, raw, event);
});

export default app;
