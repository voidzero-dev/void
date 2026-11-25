import { PLATFORM_USAGE_PROTOCOL_VERSION } from '@void/platform';

export const USAGE_PROTOCOL_VERSION = PLATFORM_USAGE_PROTOCOL_VERSION;

export const USAGE_SIGNING_KEY_KV_KEY = '__void:usage-signing-key:v1';
/** Operational usage intervals and their replay receipts share one validity window. */
export const SANDBOX_USAGE_RETENTION_MS = 8 * 24 * 60 * 60_000;

export type UsageEventSource = 'dispatch' | 'sandbox-counter';

export type SignedUsageEnvelope<T = unknown> = Readonly<{
  version: 1 | typeof USAGE_PROTOCOL_VERSION;
  source: UsageEventSource;
  eventId: string;
  event: T;
  signature: string;
}>;

const encoder = new TextEncoder();
const DERIVATION_CONTEXT = 'void-platform:usage-events:v1';

function base64url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(data: string, secret: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', key, encoder.encode(data));
}

/**
 * Return the platform-only queue signing key, creating it on first use.
 *
 * Only the purpose-separated derivative is stored in ROUTING. Dispatch can
 * therefore sign request metering without receiving the API's JWT_SECRET.
 * Tenant Workers have neither ROUTING nor this derived value.
 */
export async function ensureUsageSigningKey(
  routing: KVNamespace,
  jwtSecret: string,
): Promise<string> {
  const existing = await routing.get(USAGE_SIGNING_KEY_KV_KEY);
  if (existing) {
    return existing;
  }
  const derived = base64url(await hmac(DERIVATION_CONTEXT, jwtSecret));
  await routing.put(USAGE_SIGNING_KEY_KV_KEY, derived);
  return derived;
}

export async function readUsageSigningKey(routing: KVNamespace): Promise<string | null> {
  return routing.get(USAGE_SIGNING_KEY_KV_KEY, { cacheTtl: 60 });
}

function signedPayload<T>(
  version: SignedUsageEnvelope['version'],
  source: UsageEventSource,
  eventId: string,
  event: T,
): string {
  return JSON.stringify([version, source, eventId, event]);
}

export async function signUsageEvent<T>(
  key: string,
  source: UsageEventSource,
  eventId: string,
  event: T,
): Promise<SignedUsageEnvelope<T>> {
  return {
    version: USAGE_PROTOCOL_VERSION,
    source,
    eventId,
    event,
    signature: base64url(
      await hmac(signedPayload(USAGE_PROTOCOL_VERSION, source, eventId, event), key),
    ),
  };
}

export async function verifyUsageEnvelope<T>(
  value: unknown,
  key: string,
): Promise<SignedUsageEnvelope<T> | null> {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const envelope = value as Record<string, unknown>;
  if (
    (envelope.version !== 1 && envelope.version !== USAGE_PROTOCOL_VERSION) ||
    (envelope.source !== 'dispatch' && envelope.source !== 'sandbox-counter') ||
    typeof envelope.eventId !== 'string' ||
    envelope.eventId.length === 0 ||
    envelope.eventId.length > 256 ||
    typeof envelope.signature !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(envelope.signature) ||
    typeof envelope.event !== 'object' ||
    envelope.event === null ||
    Array.isArray(envelope.event)
  ) {
    return null;
  }
  try {
    const signingKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(key),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const signature = decodeBase64url(envelope.signature);
    const valid = await crypto.subtle.verify(
      'HMAC',
      signingKey,
      signature.buffer as ArrayBuffer,
      encoder.encode(
        signedPayload(envelope.version, envelope.source, envelope.eventId, envelope.event),
      ),
    );
    return valid ? (envelope as SignedUsageEnvelope<T>) : null;
  } catch {
    return null;
  }
}
