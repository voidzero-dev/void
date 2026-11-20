/**
 * Saving and removing an installation provider key (design doc 0095 M33).
 *
 *   POST /operator/v1/security/provider-keys {host, key | null, dryRun?}
 *     dryRun ─► preview lines (no call, nothing stored)
 *     key    ─► 1-token test call on the key ─ fails ─► 422, nothing stored
 *                                            └ ok ──► stored encrypted (policy lock)
 *     null   ─► removed; the host's probe result is cleared (policy lock), because its
 *               scans go back to Unified Billing credits the probe has not checked
 *
 * A saved key that passed the test call keeps the host's probe result: the engine image
 * is the same, and the key itself was just checked. A host that never passed (no
 * credits, so no image copied) still needs `void platform security probe`.
 */
import {
  SECURITY_PROVIDER_NAMES,
  type SecurityThirdPartyHost,
} from '@void/platform/security-models';
import type { Db, DbOrTx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { SecurityApiError } from './errors.ts';
import { lockSecurityPolicy, readStoredSecurityPolicy, replaceSecurityPolicy } from './policy.ts';
import { securityProbeHostModel } from './probe.ts';
import {
  isSecurityProviderKeyHost,
  parseSecurityProviderKey,
  securityProviderKeyIds,
  securityProviderKeysView,
  testSecurityProviderKey,
  writeSecurityProviderKey,
  type SecurityProviderKey,
} from './provider-keys.ts';

const DEFAULT_GATEWAY_ID = 'void';
export const SECURITY_PROVIDER_KEY_REJECTED = 'security provider key rejected';

export type SecurityProviderKeyRequest = Readonly<{
  host: SecurityThirdPartyHost;
  /** `null` removes the saved key. */
  key: string | null;
}>;

export function parseSecurityProviderKeyRequest(
  body: Readonly<Record<string, unknown>>,
): SecurityProviderKeyRequest {
  for (const field of Object.keys(body)) {
    if (field !== 'host' && field !== 'key' && field !== 'dryRun') {
      throw SecurityApiError.invalid(`Unknown provider key field: ${field}.`);
    }
  }
  if (!isSecurityProviderKeyHost(body.host)) {
    throw SecurityApiError.invalid('host must be openai or anthropic.');
  }
  if (body.key === null) {
    return { host: body.host, key: null };
  }
  try {
    return { host: body.host, key: parseSecurityProviderKey(body.key) };
  } catch (error) {
    throw SecurityApiError.invalid(error instanceof Error ? error.message : 'Invalid key.');
  }
}

/** "(saved 2026-11-20)", or "(cannot be read)" for a malformed entry. */
function savedNote(saved: Readonly<{ setAt: string | null }>): string {
  return saved.setAt === null ? 'cannot be read' : `saved ${saved.setAt.slice(0, 10)}`;
}

/** Whether the last probe passed this host (its models can be picked now). */
async function hostPassed(db: DbOrTx, host: SecurityThirdPartyHost): Promise<boolean> {
  const { policy } = await readStoredSecurityPolicy(db);
  return policy.entitlement?.hosts[host] === true;
}

export async function previewSecurityProviderKey(db: DbOrTx, request: SecurityProviderKeyRequest) {
  const { host } = request;
  const provider = SECURITY_PROVIDER_NAMES[host];
  const saved = (await securityProviderKeysView(db))[host];
  const passed = await hostPassed(db, host);
  let lines: Array<string>;
  if (request.key === null) {
    lines = saved
      ? [
          `Remove: your own ${provider} key (${savedNote(saved)}).`,
          `  ${host}/* scans go back to Unified Billing credits on the platform's Cloudflare account.`,
          `  Projects cannot pick ${host}/* models until void platform security probe passes again.`,
        ]
      : [`No ${provider} key is saved. Nothing changes.`];
  } else {
    lines = [
      saved
        ? `Replace: your own ${provider} key (${savedNote(saved)}).`
        : `Save: your own ${provider} key for ${host}/* scans.`,
      `  ${host}/* scans are billed to this key by ${provider}, not to Unified Billing credits. The platform still meters them, and they count toward the monthly caps.`,
      '  A 1-token test call runs when you apply. A key that fails it is not saved.',
      ...(passed
        ? []
        : [`  Then run void platform security probe so projects can pick ${host}/* models.`]),
    ];
  }
  return {
    dryRun: true as const,
    action: 'security.provider-key' as const,
    target: host,
    providerKey: saved,
    preview: lines,
  };
}

export type SecurityProviderKeyChangeResult = Readonly<{
  ok: true;
  host: SecurityThirdPartyHost;
  providerKey: Readonly<{ setAt: string }> | null;
  /** Projects cannot pick this host's models until a probe passes. */
  probeNeeded: boolean;
  message: string;
}>;

type ChangeOptions = Readonly<{
  userId: string;
  now: number;
  /** The test call; tests replace it. Returns the HTTP status. */
  test?: (key: SecurityProviderKey) => Promise<number>;
}>;

function rejected(
  host: SecurityThirdPartyHost,
  detail: string,
  refused: boolean,
): SecurityApiError {
  const provider = SECURITY_PROVIDER_NAMES[host];
  return new SecurityApiError(
    422,
    SECURITY_PROVIDER_KEY_REJECTED,
    refused
      ? `${provider} refused the key (${detail}). Nothing was saved. Check the key and try again.`
      : `The test call with the key failed (${detail}). Nothing was saved. Check the key and its quota at ${provider}, then try again.`,
    { host },
  );
}

export async function changeSecurityProviderKey(
  env: ApiEnv['Bindings'],
  db: Db,
  request: SecurityProviderKeyRequest,
  options: ChangeOptions,
): Promise<SecurityProviderKeyChangeResult> {
  const { host } = request;
  if (request.key !== null) {
    const key: SecurityProviderKey = { host, key: request.key, keyId: 'test' };
    const test =
      options.test ??
      ((candidate: SecurityProviderKey) =>
        testSecurityProviderKey(
          env.AI,
          env.AI_GATEWAY_ID ?? DEFAULT_GATEWAY_ID,
          candidate,
          securityProbeHostModel(host),
        ));
    let status: number;
    try {
      status = await test(key);
    } catch (error) {
      // The message names the failure, never the key.
      throw rejected(host, error instanceof Error ? error.message : 'no answer', false);
    }
    if (status < 200 || status >= 300) {
      throw rejected(host, `HTTP ${status}`, status === 401 || status === 403);
    }
  }
  return db.transaction(async (tx) => {
    // The policy lock orders this write against a probe storing its result, which reads
    // the key ids under the same lock.
    await lockSecurityPolicy(tx);
    const hadKey = (await securityProviderKeyIds(tx))[host] !== null;
    const saved = await writeSecurityProviderKey(env, tx, {
      host,
      key: request.key,
      userId: options.userId,
      now: options.now,
    });
    const stored = await readStoredSecurityPolicy(tx);
    let passed = stored.policy.entitlement?.hosts[host] === true;
    // Removing no key changes no route, so the probe result stands.
    if (request.key === null && hadKey && passed && stored.unreadable === null) {
      const entitlement = stored.policy.entitlement!;
      await replaceSecurityPolicy(tx, stored.policy, {
        ...stored.policy,
        entitlement: { ...entitlement, hosts: { ...entitlement.hosts, [host]: false } },
      });
      passed = false;
    }
    const provider = SECURITY_PROVIDER_NAMES[host];
    const next = passed
      ? ''
      : ` Run void platform security probe so projects can pick ${host}/* models.`;
    return {
      ok: true as const,
      host,
      providerKey: saved,
      probeNeeded: !passed,
      message:
        request.key === null
          ? `Removed your own ${provider} key. ${host}/* scans use Unified Billing credits.${next}`
          : `Saved your own ${provider} key. ${host}/* scans use it from the next model call.${next}`,
    };
  });
}
