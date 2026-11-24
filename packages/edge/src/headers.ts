import type { HeaderRule } from '@void/deploy-core';
import { matchLiteralPattern } from './pattern.ts';

export type { HeaderRule } from '@void/deploy-core';

export type HeaderRulePolicy = Readonly<{
  /**
   * Protect unrelated tenants that share one registrable domain. Direct
   * deployments own their hostname and may safely use cookie header rules.
   */
  cookieIsolation?: 'shared-domain' | 'origin';
}>;

/**
 * Headers that rules may never set on a shared domain. void.app is not on the
 * Public Suffix List, so a `Set-Cookie` with `Domain=.void.app` reaches every
 * tenant. `Clear-Site-Data` is filtered per directive by
 * {@link sanitizeClearSiteData}; per-host headers such as HSTS stay allowed.
 */
const BLOCKED_HEADERS = new Set(['set-cookie']);

/** A single member of a `Clear-Site-Data` list. */
export type ClearSiteDataMember = Readonly<{
  /** The member text, trimmed of surrounding whitespace; kept for re-serialization. */
  raw: string;
  /**
   * The quoted-string content (original case) when the member is a well-formed
   * quoted-string, else `null`. A browser ignores members that are not
   * well-formed quoted-strings.
   */
  directive: string | null;
}>;

/**
 * Parse one list member into its quoted-string content, or `null` when it is not
 * a well-formed quoted-string. Implements RFC 7230's
 * `quoted-string = DQUOTE *( qdtext / quoted-pair ) DQUOTE`: it must be wrapped
 * in double quotes, a backslash escapes the next character, and an unescaped
 * inner quote (or a dangling escape) is malformed.
 */
function parseQuotedString(member: string): string | null {
  if (member.length < 2 || member[0] !== '"' || member.at(-1) !== '"') {
    return null;
  }
  let content = '';
  for (let i = 1; i < member.length - 1; i += 1) {
    const char = member[i];
    if (char === '\\') {
      // quoted-pair: take the next character literally.
      i += 1;
      if (i >= member.length - 1) {
        return null; // trailing backslash before the closing quote
      }
      content += member[i];
    } else if (char === '"') {
      return null; // unescaped quote before the end
    } else {
      content += char;
    }
  }
  return content;
}

/**
 * Parse a `Clear-Site-Data` header value into its list members. The value is a
 * comma-separated list of quoted-strings (W3C Clear-Site-Data); a comma inside a
 * quoted-string does not split a member. Empty members are dropped.
 */
export function parseClearSiteData(value: string): Array<ClearSiteDataMember> {
  const members: Array<ClearSiteDataMember> = [];
  const pushMember = (slice: string): void => {
    const raw = slice.trim();
    if (raw.length > 0) {
      members.push({ raw, directive: parseQuotedString(raw) });
    }
  };

  let start = 0;
  let inQuotes = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (inQuotes) {
      if (char === '\\') {
        i += 1; // skip the escaped character so an escaped quote stays in-string
      } else if (char === '"') {
        inQuotes = false;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      pushMember(value.slice(start, i));
      start = i + 1;
    }
  }
  pushMember(value.slice(start));
  return members;
}

/**
 * Sanitize a `Clear-Site-Data` value so a tenant rule can't clear cookies across
 * the shared *.void.app boundary, while still allowing the safe directives.
 *
 * Only `"cookies"` and `"*"` clear cookies for the registrable domain (and thus
 * every tenant's subdomain). `"cache"`, `"storage"`, `"executionContexts"`, and
 * any future quoted directive are origin-scoped — each subdomain is its own
 * origin — so they are kept verbatim. Malformed members are dropped (a browser
 * ignores them, and dropping forecloses a lenient parser honoring them).
 *
 * Returns the filtered value, or `null` when nothing safe remains: a `"*"`
 * includes cookies and can't be expressed without them, and a value that is only
 * `"cookies"` collapses to empty.
 */
export function sanitizeClearSiteData(value: string): string | null {
  const kept: Array<string> = [];
  for (const { raw, directive } of parseClearSiteData(value)) {
    const normalized = directive?.toLowerCase();
    if (normalized === '*') {
      return null;
    }
    if (directive === null || normalized === 'cookies') {
      continue;
    }
    kept.push(raw);
  }
  return kept.length > 0 ? kept.join(', ') : null;
}

/**
 * Apply matching header rules to a response.
 * All matching rules merge; last match wins for same header name.
 * Returns the original response unchanged when no rules or no matches.
 */
export function applyHeaderRules(
  response: Response,
  pathname: string,
  rules?: ReadonlyArray<HeaderRule>,
  policy?: HeaderRulePolicy,
): Response {
  if (!rules || rules.length === 0) {
    return response;
  }

  const matched: Array<[string, string]> = [];
  for (const rule of rules) {
    if (matchLiteralPattern(rule.pattern, pathname)) {
      matched.push(...rule.headers);
    }
  }

  if (matched.length === 0) {
    return response;
  }

  const newResponse = new Response(response.body, response);
  // A Clear-Site-Data rule that sanitizes to nothing falls back to the origin's
  // own value (also sanitized) instead of keeping an earlier rule's value.
  const isolateSharedDomainCookies = policy?.cookieIsolation !== 'origin';
  const rawOriginClearSiteData = isolateSharedDomainCookies
    ? response.headers.get('clear-site-data')
    : null;
  const originClearSiteData =
    rawOriginClearSiteData === null ? null : sanitizeClearSiteData(rawOriginClearSiteData);
  for (const [name, value] of matched) {
    const lowerName = name.toLowerCase();
    if (isolateSharedDomainCookies && BLOCKED_HEADERS.has(lowerName)) {
      continue;
    }
    if (isolateSharedDomainCookies && lowerName === 'clear-site-data') {
      const safe = sanitizeClearSiteData(value);
      if (safe !== null) {
        newResponse.headers.set(name, safe);
      } else if (originClearSiteData !== null) {
        newResponse.headers.set(name, originClearSiteData);
      } else {
        newResponse.headers.delete(name);
      }
      continue;
    }
    newResponse.headers.set(name, value);
  }

  return newResponse;
}
