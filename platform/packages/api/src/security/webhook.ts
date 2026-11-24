/**
 * The security webhook (design doc 0095 M26, spec §20): one installation-wide URL that
 * gets a signed JSON body for each security event the outbox sends.
 *
 *   operator ─ void platform security webhook <url|off> ─► setSecurityWebhook
 *                 new random secret, shown once, stored encrypted
 *   outbox row queued ─► `webhook` twin row (notifications.ts) ─► postSecurityWebhook
 *                 body: ids and counts only; X-Void-Signature: t=<s>,v1=<hmac>
 *
 * The body never holds a title, file path, code or model text: only ids and counts,
 * so a leaked endpoint learns nothing a project member could not see in `status`.
 */
import { parseSecurityWebhookUrl } from '@void/platform/security-policy';
import type { DbOrTx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { getPlatformSetting, setPlatformSetting } from '../platform-settings.ts';
import { decryptPlatformCredential, encryptPlatformCredential } from '../project-secrets.ts';
import type { EncryptedPlatformCredential } from '../project-secrets.ts';

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

function installation(env: Pick<ApiEnv['Bindings'], 'PLATFORM_INSTALLATION_ID'>): string {
  return env.PLATFORM_INSTALLATION_ID ?? 'installation';
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** The stored webhook, or `null` (never set, turned off, or unreadable: then nothing is sent). */
async function readStoredWebhook(db: DbOrTx): Promise<StoredWebhook | null> {
  const value = await getPlatformSetting(db, SECURITY_WEBHOOK_SETTINGS_KEY);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const secret = row.secret as Record<string, unknown> | null | undefined;
  if (
    !text(row.url) ||
    !text(row.setAt) ||
    !text(row.setByUserId) ||
    typeof secret !== 'object' ||
    secret === null ||
    !text(secret.ciphertext) ||
    !text(secret.iv) ||
    !text(secret.keyVersion)
  ) {
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
    secret: { ciphertext: secret.ciphertext, iv: secret.iv, keyVersion: secret.keyVersion },
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

/** 32 random bytes as hex, with a prefix that says what it is. */
function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `vwhsec_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Sets (or with `url: null` removes) the webhook. Setting it, even to the same URL,
 * makes a new secret: the old one stops working at once. The secret is returned here
 * once and never again.
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
  const secret = newSecret();
  const stored: StoredWebhook = {
    url,
    secret: await encryptPlatformCredential(env, installation(env), CREDENTIAL_ID, secret),
    setAt: new Date(input.now).toISOString(),
    setByUserId: input.userId,
  };
  await setPlatformSetting(db, SECURITY_WEBHOOK_SETTINGS_KEY, stored);
  return { webhook: { url, setAt: stored.setAt }, secret };
}

function hex(bytes: ArrayBuffer): string {
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
 * Posts one event. `off` when no webhook is set any more. Throws on a network error,
 * a timeout or a non-2xx answer (redirects are not followed), so the outbox retries.
 * The signature time is the clock at send time, not the outbox run's start: a receiver
 * that checks it against a short window takes a late row of a batch, and a retry.
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
