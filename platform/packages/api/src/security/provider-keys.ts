/**
 * Installation provider keys for third-party scan models (design doc 0095 M33, BYOK).
 *
 *   operator ─ void platform security models --provider anthropic --key-stdin ─► byok.ts
 *                 1-token test call with the key ─► stored encrypted here
 *   model proxy (anthropic/*, openai/*) ─► key saved? ─┬─ no:  REST /ai/v1/* (Unified Billing)
 *                                                       └─ yes: AI binding gateway.run, the
 *                                                               provider's own route + key
 *
 * The key never reaches the scanner container: the proxy adds it to the upstream call.
 * Calls on a saved key are metered and counted toward the caps like any other (R14).
 *
 * The REST `/ai/v1/*` routes only read keys stored in AI Gateway itself, so a key held
 * here goes to the provider-native route instead, through the AI binding: the binding
 * authenticates to the gateway, so the runtime token needs no new permission. The model
 * is named the provider's way there (`claude-opus-5-5`, not `claude-opus-5.5`).
 * `cf-aig-no-wholesale` makes the gateway refuse instead of billing Unified Billing
 * credits if it ever does not read the key.
 */
import { isRecord } from '@void/deploy-core';
import type { SecurityModelId, SecurityThirdPartyHost } from '@void/platform/security-models';
import type { SecurityEntitlement } from '@void/platform/security-policy';
import type { DbOrTx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { generateId } from '../id.ts';
import { getPlatformSetting, setPlatformSetting } from '../platform-settings.ts';
import { decryptPlatformCredential, encryptPlatformCredential } from '../project-secrets.ts';
import type { EncryptedPlatformCredential } from '../project-secrets.ts';

/** `platform_settings` key; apart from the policy so a key never reaches a policy read. */
export const SECURITY_PROVIDER_KEYS_SETTINGS_KEY = 'securityAudits.providerKeys';
export const SECURITY_PROVIDER_KEY_HOSTS: ReadonlyArray<SecurityThirdPartyHost> = [
  'openai',
  'anthropic',
];
/** Longest key accepted; provider keys are far shorter. */
export const SECURITY_PROVIDER_KEY_MAX_LENGTH = 1024;
const SECURITY_PROVIDER_KEY_MIN_LENGTH = 8;
const ANTHROPIC_VERSION = '2023-06-01';
const TEST_PROMPT = 'Reply with ok.';
const TEST_TIMEOUT_MS = 30_000;

export type SecurityProviderKeyEnv = Pick<
  ApiEnv['Bindings'],
  'PROJECT_SECRET_KEYS_JSON' | 'PROJECT_SECRET_ACTIVE_KEY_VERSION' | 'PLATFORM_INSTALLATION_ID'
>;

type StoredKey = Readonly<{
  key: EncryptedPlatformCredential;
  /** New on every save; a probe result covers the key ids it ran with. */
  keyId: string;
  setAt: string;
  setByUserId: string;
}>;

/** A saved entry whose shape is wrong: present, so never read as "no key". */
const MALFORMED = 'malformed';

type StoredKeys = Partial<Record<SecurityThirdPartyHost, StoredKey | typeof MALFORMED>>;

/**
 * The key id of an entry that cannot be read. Saving or removing the key changes it, like
 * any other key id, so a probe result never covers a later save.
 */
export const SECURITY_PROVIDER_KEY_MALFORMED_ID = 'malformed';

/** What the CLI and status show: never the key. `unreadable`: save the key again. */
export type SecurityProviderKeysView = Readonly<
  Record<
    SecurityThirdPartyHost,
    Readonly<{ setAt: string }> | Readonly<{ setAt: null; unreadable: true }> | null
  >
>;

/** A decrypted key, for one upstream call. */
export type SecurityProviderKey = Readonly<{
  host: SecurityThirdPartyHost;
  key: string;
  keyId: string;
}>;

/** Per host: a key, none, or a saved key the keyring cannot open. */
export type SecurityProviderKeySlot =
  | SecurityProviderKey
  | Readonly<{ host: SecurityThirdPartyHost; keyId: string; unreadable: true }>
  | null;

export type SecurityProviderKeySlots = Readonly<
  Record<SecurityThirdPartyHost, SecurityProviderKeySlot>
>;

/** The key id per host (`null`: no key). */
export type SecurityProviderKeyIds = Readonly<Record<SecurityThirdPartyHost, string | null>>;

export const NO_SECURITY_PROVIDER_KEYS: SecurityProviderKeySlots = {
  openai: null,
  anthropic: null,
};

/** The model name on the provider-native route (spike S2/S3 recorded the catalog names). */
const PROVIDER_MODEL_NAMES: Readonly<Record<Exclude<SecurityModelId, `@cf/${string}`>, string>> = {
  'openai/gpt-6.1-terra': 'gpt-6.1-terra',
  'openai/gpt-6.1-sol': 'gpt-6.1-sol',
  'anthropic/claude-sonnet-5.5': 'claude-sonnet-5-5',
  'anthropic/claude-opus-5.5': 'claude-opus-5-5',
};

export function securityProviderModelName(model: SecurityModelId): string {
  if (model.startsWith('@cf/')) {
    return model;
  }
  return PROVIDER_MODEL_NAMES[model as keyof typeof PROVIDER_MODEL_NAMES];
}

export function isSecurityProviderKeyHost(value: unknown): value is SecurityThirdPartyHost {
  return value === 'openai' || value === 'anthropic';
}

function installation(env: Pick<ApiEnv['Bindings'], 'PLATFORM_INSTALLATION_ID'>): string {
  return env.PLATFORM_INSTALLATION_ID ?? 'installation';
}

/** The credential id binds the ciphertext to its host: one host's key never opens as another's. */
function credentialId(host: SecurityThirdPartyHost): string {
  return `security-provider-key:${host}`;
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function readStoredKey(
  host: SecurityThirdPartyHost,
  value: unknown,
): StoredKey | typeof MALFORMED | null {
  if (value === undefined || value === null) {
    return null;
  }
  const row = (typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<
    string,
    unknown
  >;
  const key = row.key as Record<string, unknown> | null | undefined;
  if (
    !text(row.keyId) ||
    !text(row.setAt) ||
    !text(row.setByUserId) ||
    typeof key !== 'object' ||
    key === null ||
    !text(key.ciphertext) ||
    !text(key.iv) ||
    !text(key.keyVersion)
  ) {
    console.error(
      `[security-provider-keys] ${SECURITY_PROVIDER_KEYS_SETTINGS_KEY}.${host} is malformed; save the key again`,
    );
    return MALFORMED;
  }
  return {
    key: { ciphertext: key.ciphertext, iv: key.iv, keyVersion: key.keyVersion },
    keyId: row.keyId,
    setAt: row.setAt,
    setByUserId: row.setByUserId,
  };
}

/**
 * The stored keys. A malformed entry stays marked: it is a saved key that cannot be used,
 * never "no key", so its scans do not quietly move to Unified Billing credits.
 */
async function readStoredKeys(db: DbOrTx): Promise<StoredKeys> {
  const value = await getPlatformSetting(db, SECURITY_PROVIDER_KEYS_SETTINGS_KEY);
  const row = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<
    string,
    unknown
  >;
  const stored: StoredKeys = {};
  for (const host of SECURITY_PROVIDER_KEY_HOSTS) {
    const key = readStoredKey(host, row[host]);
    if (key) {
      stored[host] = key;
    }
  }
  return stored;
}

const view = (entry: StoredKeys[SecurityThirdPartyHost]) =>
  entry === undefined
    ? null
    : entry === MALFORMED
      ? { setAt: null, unreadable: true as const }
      : { setAt: entry.setAt };

export async function securityProviderKeysView(db: DbOrTx): Promise<SecurityProviderKeysView> {
  const stored = await readStoredKeys(db);
  return { openai: view(stored.openai), anthropic: view(stored.anthropic) };
}

function storedKeyId(entry: StoredKeys[SecurityThirdPartyHost]): string | null {
  if (entry === undefined) {
    return null;
  }
  return entry === MALFORMED ? SECURITY_PROVIDER_KEY_MALFORMED_ID : entry.keyId;
}

export async function securityProviderKeyIds(db: DbOrTx): Promise<SecurityProviderKeyIds> {
  const stored = await readStoredKeys(db);
  return { openai: storedKeyId(stored.openai), anthropic: storedKeyId(stored.anthropic) };
}

/**
 * The saved key of one host, decrypted, or `null` when none is saved. Throws when a saved
 * key cannot be opened or its entry is malformed: a scan must not quietly move to Unified
 * Billing credits.
 */
export async function loadSecurityProviderKey(
  env: SecurityProviderKeyEnv,
  db: DbOrTx,
  host: SecurityThirdPartyHost,
): Promise<SecurityProviderKey | null> {
  const stored = (await readStoredKeys(db))[host];
  if (!stored) {
    return null;
  }
  if (stored === MALFORMED) {
    throw new Error(`the saved ${host} key entry is malformed`);
  }
  const key = await decryptPlatformCredential(
    env,
    installation(env),
    credentialId(host),
    stored.key,
  );
  return { host, key, keyId: stored.keyId };
}

/** Every host's key for the probe; a key that cannot be opened is reported, not thrown. */
export async function loadSecurityProviderKeySlots(
  env: SecurityProviderKeyEnv,
  db: DbOrTx,
): Promise<SecurityProviderKeySlots> {
  const stored = await readStoredKeys(db);
  const slot = async (host: SecurityThirdPartyHost): Promise<SecurityProviderKeySlot> => {
    const entry = stored[host];
    if (!entry) {
      return null;
    }
    if (entry === MALFORMED) {
      return { host, keyId: SECURITY_PROVIDER_KEY_MALFORMED_ID, unreadable: true };
    }
    try {
      const key = await decryptPlatformCredential(
        env,
        installation(env),
        credentialId(host),
        entry.key,
      );
      return { host, key, keyId: entry.keyId };
    } catch {
      return { host, keyId: entry.keyId, unreadable: true };
    }
  };
  const [openai, anthropic] = await Promise.all([slot('openai'), slot('anthropic')]);
  return { openai, anthropic };
}

export function securityProviderKeySlotIds(
  slots: SecurityProviderKeySlots,
): SecurityProviderKeyIds {
  return { openai: slots.openai?.keyId ?? null, anthropic: slots.anthropic?.keyId ?? null };
}

/**
 * A probe result covers the keys it ran with. A host whose key was set, replaced or
 * removed while the probe ran keeps the stored value instead: the key write set it under
 * the same lock (a save that passed its test call keeps it, a removal clears it).
 *
 *   used == saved ─► the probe's result
 *   used != saved ─► stored[host] === true (no stored result: false)
 *
 * Call under the policy lock, with `stored` and `saved` read in that transaction.
 */
export function entitlementForSavedKeys(
  entitlement: SecurityEntitlement,
  used: SecurityProviderKeyIds,
  saved: SecurityProviderKeyIds,
  stored: SecurityEntitlement['hosts'] | null | undefined,
): SecurityEntitlement {
  const host = (name: SecurityThirdPartyHost) =>
    used[name] === saved[name] ? entitlement.hosts[name] : stored?.[name] === true;
  return { ...entitlement, hosts: { openai: host('openai'), anthropic: host('anthropic') } };
}

/** Shape check only: printable ASCII with no spaces. The test call checks the rest. */
export function parseSecurityProviderKey(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('key must be a string.');
  }
  const key = value.trim();
  if (
    key.length < SECURITY_PROVIDER_KEY_MIN_LENGTH ||
    key.length > SECURITY_PROVIDER_KEY_MAX_LENGTH
  ) {
    throw new Error(
      `The key must be ${SECURITY_PROVIDER_KEY_MIN_LENGTH} to ${SECURITY_PROVIDER_KEY_MAX_LENGTH} characters.`,
    );
  }
  for (const char of key) {
    const code = char.charCodeAt(0);
    if (code < 0x21 || code > 0x7e) {
      throw new Error('The key must be one line of printable characters with no spaces.');
    }
  }
  return key;
}

type PlatformSettingValue = Awaited<ReturnType<typeof getPlatformSetting>>;

/** The saved provider keys setting, by host; entries this code does not know are kept. */
interface StoredKeysSetting {
  [host: string]: PlatformSettingValue | undefined;
}

/** Saves (or with `key: null` removes) one host's key. Call under the policy lock. */
export async function writeSecurityProviderKey(
  env: SecurityProviderKeyEnv,
  tx: DbOrTx,
  input: Readonly<{
    host: SecurityThirdPartyHost;
    key: string | null;
    userId: string;
    now: number;
  }>,
): Promise<Readonly<{ setAt: string } | null>> {
  const value = await getPlatformSetting(tx, SECURITY_PROVIDER_KEYS_SETTINGS_KEY);
  const row: StoredKeysSetting = {
    ...(isRecord(value) ? value : {}),
  };
  if (input.key === null) {
    delete row[input.host];
    await setPlatformSetting(tx, SECURITY_PROVIDER_KEYS_SETTINGS_KEY, row);
    return null;
  }
  const stored: StoredKey = {
    key: await encryptPlatformCredential(
      env,
      installation(env),
      credentialId(input.host),
      input.key,
    ),
    keyId: generateId('pk'),
    setAt: new Date(input.now).toISOString(),
    setByUserId: input.userId,
  };
  row[input.host] = stored;
  await setPlatformSetting(tx, SECURITY_PROVIDER_KEYS_SETTINGS_KEY, row);
  return { setAt: stored.setAt };
}

// ---------------------------------------------------------------------------
// Upstream
// ---------------------------------------------------------------------------

/** The provider-native endpoint each engine's route maps to. */
const ENDPOINTS: Readonly<Record<SecurityThirdPartyHost, string>> = {
  anthropic: 'v1/messages',
  openai: 'responses',
};

/** The provider's own key header. Anthropic Messages reads only `x-api-key`. */
function keyHeaders(key: SecurityProviderKey): Record<string, string> {
  return key.host === 'anthropic'
    ? { 'x-api-key': key.key }
    : { authorization: `Bearer ${key.key}` };
}

export type SecurityProviderKeyCall = Readonly<{
  key: SecurityProviderKey;
  body: Readonly<Record<string, unknown>>;
  /** Fixed gateway and provider headers; the key headers are added here. */
  headers: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}>;

/**
 * One call on a saved key: the AI binding's gateway `run` on the provider-native route.
 * Throws when the binding is missing or the call does not reach the gateway.
 */
export async function callWithSecurityProviderKey(
  ai: Ai | undefined,
  gatewayId: string,
  call: SecurityProviderKeyCall,
): Promise<Response> {
  if (!ai) {
    throw new Error('the API Worker has no AI binding');
  }
  return ai.gateway(gatewayId).run(
    {
      provider: call.key.host,
      endpoint: ENDPOINTS[call.key.host],
      headers: {
        'content-type': 'application/json',
        ...(call.key.host === 'anthropic' && call.headers['anthropic-version'] === undefined
          ? { 'anthropic-version': ANTHROPIC_VERSION }
          : {}),
        ...call.headers,
        'cf-aig-no-wholesale': 'true',
        ...keyHeaders(call.key),
      },
      query: call.body,
    },
    call.signal ? { signal: call.signal } : undefined,
  );
}

/**
 * The 1-token call the probe (check 5) and a key save make: the route and body its engine
 * uses, with the cyber access program for `openai/*` as the proxy always adds it.
 * Returns the HTTP status; throws when the gateway cannot be reached.
 */
export async function testSecurityProviderKey(
  ai: Ai | undefined,
  gatewayId: string,
  key: SecurityProviderKey,
  model: SecurityModelId,
): Promise<number> {
  const name = securityProviderModelName(model);
  const body =
    key.host === 'anthropic'
      ? { model: name, max_tokens: 1, messages: [{ role: 'user', content: TEST_PROMPT }] }
      : {
          model: name,
          input: TEST_PROMPT,
          max_output_tokens: 16,
          access_programs: { cyber: 'standard' },
        };
  const response = await callWithSecurityProviderKey(ai, gatewayId, {
    key,
    body,
    headers: {
      'cf-aig-collect-log': 'true',
      'cf-aig-collect-log-payload': 'false',
      'cf-aig-skip-cache': 'true',
      'cf-aig-metadata': JSON.stringify({ securityScan: 'probe' }),
    },
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
  });
  await response.body?.cancel().catch(() => {});
  return response.status;
}
