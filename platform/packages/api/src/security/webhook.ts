/**
 * The security webhook (design doc 0095 M26, spec §20): one installation-wide URL that
 * gets a signed JSON body (ids and counts only, never titles, paths or code) for each
 * event the outbox sends. Its secret is shown once and stored encrypted.
 */
import { isRecord } from '@void/deploy-core';
import { parseSecurityWebhookUrl } from '@void/platform/security-policy';
import type { DbOrTx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { getPlatformSetting, setPlatformSetting } from '../platform-settings.ts';
import { decryptPlatformCredential, encryptPlatformCredential } from '../project-secrets.ts';
import type { EncryptedPlatformCredential } from '../project-secrets.ts';
import { installation, readEncryptedCredential, text } from './provider-keys.ts';

/** `platform_settings` key; kept apart from the policy so the secret never reaches a policy read. */
export const SECURITY_WEBHOOK_SETTINGS_KEY = 'securityAudits.webhook';
const CREDENTIAL_ID = 'security-webhook';
/** A delivery that takes longer than this failed (the outbox retries it). */
export const SECURITY_WEBHOOK_TIMEOUT_MS = 10_000;
export const SECURITY_WEBHOOK_SIGNATURE_HEADER = 'X-Void-Signature';

export type SecurityWebhookEnv = Pick<
  ApiEnv['Bindings'],
  'PROJECT_SECRET_KEYS_JSON' | 'PROJECT_SECRET_ACTIVE_KEY_VERSION' | 'PLATFORM_INSTALLATION_ID'
>;

type StoredWebhook = Readonly<{
  url: string;
  secret: EncryptedPlatformCredential;
  setAt: string;
  setByUserId: string;
}>;

export type SecurityWebhookView = Readonly<{ url: string; setAt: string }>;

/** The stored webhook, or `null` (never set, turned off, or unreadable: then nothing is sent). */
async function readStoredWebhook(db: DbOrTx): Promise<StoredWebhook | null> {
  const value = await getPlatformSetting(db, SECURITY_WEBHOOK_SETTINGS_KEY);
  if (!isRecord(value)) {
    return null;
  }
  const row = value;
  const secret = readEncryptedCredential(row.secret);
  if (!text(row.url) || !text(row.setAt) || !text(row.setByUserId) || secret === null) {
    if (row.url !== null) {
      console.error(
        `[security-webhook] ${SECURITY_WEBHOOK_SETTINGS_KEY} is malformed; no webhook is sent`,
      );
    }
    return null;
  }
  try {
    parseSecurityWebhookUrl(row.url);
  } catch {
    return null;
  }
  return {
    url: row.url,
    secret,
    setAt: row.setAt,
    setByUserId: row.setByUserId,
  };
}

export async function securityWebhookView(db: DbOrTx): Promise<SecurityWebhookView | null> {
  const stored = await readStoredWebhook(db);
  return stored ? { url: stored.url, setAt: stored.setAt } : null;
}

/** Is a webhook set? Read when an event is queued, so no twin row is written without one. */
export async function securityWebhookOn(db: DbOrTx): Promise<boolean> {
  return (await readStoredWebhook(db)) !== null;
}

/**
 * Sets (or with `url: null` removes) the webhook. Every set makes a new secret, returned
 * here once; the old one stops working at once.
 */
export async function setSecurityWebhook(
  env: SecurityWebhookEnv,
  db: DbOrTx,
  input: Readonly<{ url: string | null; userId: string; now: number }>,
): Promise<Readonly<{ webhook: SecurityWebhookView | null; secret: string | null }>> {
  if (input.url === null) {
    await setPlatformSetting(db, SECURITY_WEBHOOK_SETTINGS_KEY, { url: null });
    return { webhook: null, secret: null };
  }
  const url = parseSecurityWebhookUrl(input.url);
  const secret = `vwhsec_${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
  const stored: StoredWebhook = {
    url,
    secret: await encryptPlatformCredential(env, installation(env), CREDENTIAL_ID, secret),
    setAt: new Date(input.now).toISOString(),
    setByUserId: input.userId,
  };
  await setPlatformSetting(db, SECURITY_WEBHOOK_SETTINGS_KEY, stored);
  return { webhook: { url, setAt: stored.setAt }, secret };
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export async function securityWebhookSignature(
  secret: string,
  timestampSeconds: number,
  body: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestampSeconds}.${body}`));
  return `t=${timestampSeconds},v1=${hex(mac)}`;
}

/** One webhook event: ids and counts only. */
export type SecurityWebhookEvent = Readonly<{
  /** The delivery id; the same on every retry, so a receiver can drop repeats. */
  id: string;
  type: string;
  createdAt: string;
  project: Readonly<{ id: string; slug: string | null }> | null;
  data: Readonly<Record<string, unknown>>;
}>;

export type SecurityWebhookResult = 'sent' | 'off';

/**
 * Posts one event (`off`: no webhook any more). Throws on a network error, timeout or
 * non-2xx answer so the outbox retries. Signed with the clock at send time.
 */
export async function postSecurityWebhook(
  env: SecurityWebhookEnv,
  db: DbOrTx,
  event: SecurityWebhookEvent,
  fetcher: typeof fetch = fetch,
): Promise<SecurityWebhookResult> {
  const stored = await readStoredWebhook(db);
  if (!stored) {
    return 'off';
  }
  const secret = await decryptPlatformCredential(
    env,
    installation(env),
    CREDENTIAL_ID,
    stored.secret,
  );
  const body = JSON.stringify({ ...event, installation: installation(env) });
  const signature = await securityWebhookSignature(secret, Math.floor(Date.now() / 1000), body);
  const response = await fetcher(stored.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Void-Security-Webhook/1',
      'X-Void-Event': event.type,
      'X-Void-Delivery': event.id,
      [SECURITY_WEBHOOK_SIGNATURE_HEADER]: signature,
    },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(SECURITY_WEBHOOK_TIMEOUT_MS),
  });
  await response.body?.cancel().catch(() => {});
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`The security webhook answered ${response.status}.`);
  }
  return 'sent';
}
