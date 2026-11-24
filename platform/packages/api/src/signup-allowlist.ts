import { isPlatformSignupAllowed, parsePlatformSignupAllowlistEntry } from '@void/platform';
import type { PlatformSignupAllowlistEntry } from '@void/platform';

export type AllowlistEntry = PlatformSignupAllowlistEntry;

const KV_KEY = 'signup:allowlist';

export async function getAllowlist(kv: KVNamespace): Promise<Array<AllowlistEntry>> {
  const raw = await kv.get(KV_KEY);
  if (!raw) {
    return [];
  }
  const entries: unknown = JSON.parse(raw);
  if (!Array.isArray(entries)) {
    throw new Error('The signup allowlist must be an array.');
  }
  return entries.map(parsePlatformSignupAllowlistEntry);
}

export async function putAllowlist(
  kv: KVNamespace,
  entries: ReadonlyArray<AllowlistEntry>,
): Promise<void> {
  await kv.put(KV_KEY, JSON.stringify(entries));
}

/**
 * Check if a signup should be allowed based on the allowlist.
 * If entries is empty, no one is allowed (restrictions are on but nobody is listed).
 */
export function isSignupAllowed(
  provider: string,
  login: string,
  email: string | null,
  entries: ReadonlyArray<AllowlistEntry>,
  connectionId = provider,
  subject = login,
): boolean {
  return isPlatformSignupAllowed({ provider, login, email, connectionId, subject }, entries);
}
