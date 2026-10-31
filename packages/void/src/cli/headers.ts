import { existsSync, readFileSync } from 'node:fs';
import { join } from 'pathslash';
import { isGeneratedAssetHeaders } from '../asset-worker-bypass.ts';
import {
  convertFallbacksConfig,
  convertHeadersConfig,
  convertRedirectsConfig,
  convertRewritesConfig,
  countSplats,
  isProtocolRelative,
  parseHostPrefixedSource,
  VALID_REDIRECT_STATUSES,
  type RoutingConfig,
} from '../config.ts';
import { voidWarn } from '../log.ts';
import type { DevRedirectRule, HeaderRule } from './types.ts';

/**
 * Result of parsing a `_redirects` file.
 *
 * `redundantForceOn3xx` counts entries that used a `!` force suffix on a 3xx
 * status (e.g. `301!`, `302!`, `307!`, `308!`). The `!` is a no-op on 3xx
 * (a redirect always "forces" by nature — it changes the URL), so we silently
 * strip it and let callers aggregate a single friendly warning at deploy time.
 */
export type ParsedRedirects = {
  rules: Array<DevRedirectRule>;
  redundantForceOn3xx: number;
};

/**
 * Parse a Cloudflare/Netlify `_headers` file into HeaderRule[].
 *
 * Format:
 *   - Non-indented lines = path pattern (starts a new block)
 *   - Indented lines = `Header-Name: value` (split on first `:`)
 *   - Lines starting with `#` are comments
 *   - `! Header-Name` unset directives are skipped (last-match-wins handles this)
 *
 * Output is sorted by pattern length ascending (shortest first) so that
 * more-specific patterns come last — matching dispatch's last-match-wins semantics.
 *
 * Returns `undefined` if the file doesn't exist or yields no valid rules.
 */
export function parseHeadersFile(dir: string): Array<HeaderRule> | undefined {
  const filePath = join(dir, '_headers');
  if (!existsSync(filePath)) {
    return undefined;
  }

  const content = readFileSync(filePath, 'utf-8');
  const rules: Array<HeaderRule> = [];
  let current: HeaderRule | null = null;

  for (const line of content.split('\n')) {
    // Skip blank lines and comments
    const trimmed = line.trimEnd();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    // Indented line = header within current block
    if (line[0] === ' ' || line[0] === '\t') {
      if (!current) {
        continue;
      }
      const stripped = trimmed.trimStart();
      // Skip unset directives (! Header-Name)
      if (stripped.startsWith('!')) {
        continue;
      }
      const colonIdx = stripped.indexOf(':');
      if (colonIdx === -1) {
        continue;
      }
      const name = stripped.slice(0, colonIdx).trim();
      const value = stripped.slice(colonIdx + 1).trim();
      if (name) {
        current.headers.push([name, value]);
      }
    } else {
      // Non-indented line = path pattern (new block)
      if (current && current.headers.length > 0) {
        rules.push(current);
      }
      current = { pattern: trimmed, headers: [] };
    }
  }

  // Flush last block
  if (current && current.headers.length > 0) {
    rules.push(current);
  }

  if (rules.length === 0) {
    return undefined;
  }

  // Sort by pattern length ascending: shorter (less specific) first,
  // longer (more specific) last — last-match-wins = most-specific-wins
  rules.sort((a, b) => a.pattern.length - b.pattern.length);

  return rules;
}

/** The `_headers` text in `dir` when Void generated it, otherwise undefined. */
export function readGeneratedAssetHeadersFile(dir: string): string | undefined {
  const filePath = join(dir, '_headers');
  if (!existsSync(filePath)) {
    return undefined;
  }
  const content = readFileSync(filePath, 'utf-8');
  return isGeneratedAssetHeaders(content) ? content : undefined;
}

/**
 * Parse a `_redirects` file: `source destination [status]` per line (status
 * defaults to 302, `#` starts a comment). Keeps 3xx redirects and 200 rewrites.
 *
 * A `!` suffix on 200 sets `force`, so the rewrite applies even when a static
 * asset matches. On a 3xx it is a no-op, stripped and counted in
 * `redundantForceOn3xx`.
 *
 * Returns `undefined` when the file doesn't exist or yields no valid rules.
 */
export function parseRedirectsFile(dir: string): ParsedRedirects | undefined {
  const filePath = join(dir, '_redirects');
  if (!existsSync(filePath)) {
    return undefined;
  }

  const content = readFileSync(filePath, 'utf-8');
  const rules: Array<DevRedirectRule> = [];
  let redundantForceOn3xx = 0;

  const rawLines = content.split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    const lineNumber = i + 1;
    const trimmed = rawLines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) {
      continue;
    }

    const origin = `_redirects:${lineNumber}`;

    const [rawSource, destination, statusStr] = parts;

    // An optional `https://host` prefix becomes a Host filter on the rule.
    const parsedSource = parseHostPrefixedSource(rawSource);
    if ('error' in parsedSource) {
      voidWarn(
        `Skipping _redirects entry "${rawSource} ${destination}${statusStr ? ` ${statusStr}` : ''}" (line ${lineNumber}): source ${parsedSource.error}.`,
      );
      continue;
    }
    const { host, path: source } = parsedSource;

    // Each `*` compiles to a `(?<splat>...)` group, and a RegExp cannot repeat
    // a group name.
    if (countSplats(source) > 1) {
      voidWarn(
        `Skipping _redirects entry "${rawSource} ${destination}${statusStr ? ` ${statusStr}` : ''}" (line ${lineNumber}): source must contain at most one "*" wildcard (captured as :splat).`,
      );
      continue;
    }
    let status: number;
    let force = false;
    if (statusStr) {
      if (statusStr.endsWith('!')) {
        const numericPart = statusStr.slice(0, -1);
        status = parseInt(numericPart, 10);
        if (status === 200) {
          force = true;
        } else if (status >= 300 && status < 400) {
          redundantForceOn3xx++;
        }
      } else {
        status = parseInt(statusStr, 10);
      }
    } else {
      status = 302;
    }

    // Status 200 is an internal rewrite. External (proxy) destinations are not
    // supported, as with `routing.rewrites` in void.config.ts.
    if (status === 200) {
      if (!destination.startsWith('/')) {
        voidWarn(
          `Skipping _redirects rewrite "${rawSource} ${destination} ${force ? '200!' : '200'}": destination must start with "/" (only internal paths are supported).`,
        );
        continue;
      }
      if (isProtocolRelative(destination)) {
        voidWarn(
          `Skipping _redirects rewrite "${rawSource} ${destination} ${force ? '200!' : '200'}": destination must not start with "//" (protocol-relative URLs parse as cross-origin; only internal paths are supported).`,
        );
        continue;
      }
      if (destination.includes('?')) {
        voidWarn(
          `Skipping _redirects rewrite "${rawSource} ${destination} ${force ? '200!' : '200'}": destination must not contain "?" (query strings are not supported in rewrite destinations; the incoming request's query is preserved automatically).`,
        );
        continue;
      }
      rules.push({ source, destination, status, force, origin, ...(host && { host }) });
    } else if (status >= 300 && status < 400) {
      if (!VALID_REDIRECT_STATUSES.has(status)) {
        voidWarn(
          `Skipping _redirects entry "${rawSource} ${destination} ${statusStr}" (line ${lineNumber}): redirect status must be 301, 302, 303, 307, or 308.`,
        );
        continue;
      }
      rules.push({ source, destination, status, origin, ...(host && { host }) });
    }
  }

  if (rules.length === 0 && redundantForceOn3xx === 0) {
    return undefined;
  }

  return { rules, redundantForceOn3xx };
}

/**
 * Split `_redirects` rules into rules that always apply and fallbacks: unforced
 * 200 rewrites, which apply only when no static asset matches.
 */
export function splitRedirectRulesByForce(rules: Array<DevRedirectRule> | undefined): {
  always: Array<DevRedirectRule>;
  fallbacks: Array<DevRedirectRule>;
} {
  const always: Array<DevRedirectRule> = [];
  const fallbacks: Array<DevRedirectRule> = [];
  if (!rules) {
    return { always, fallbacks };
  }
  for (const rule of rules) {
    if (rule.status === 200 && rule.force !== true) {
      fallbacks.push(rule);
    } else {
      always.push(rule);
    }
  }
  return { always, fallbacks };
}

/**
 * Merge `_redirects` and `_headers` in `dir` with `routing` from void.config.ts.
 * Deploy and dev share it so both build the same rule tables; callers lint them.
 */
export function mergeRoutingRules(opts: {
  dir: string | null;
  routing: RoutingConfig | undefined;
}): {
  headerRules: Array<HeaderRule>;
  redirectRules: Array<DevRedirectRule>;
  fallbackRules: Array<DevRedirectRule> | undefined;
  redundantForceOn3xx: number;
} {
  const { dir, routing } = opts;
  // `dir === null` when the user set `publicDir: false` in Vite config. Skip
  // file-based rule reads but still merge config-based rules below.
  const fileDir = dir !== null && existsSync(dir) ? dir : null;

  const fileHeaders = fileDir !== null ? parseHeadersFile(fileDir) : undefined;
  const fileParsed = fileDir !== null ? parseRedirectsFile(fileDir) : undefined;
  const { always: fileAlways, fallbacks: fileFallbacks } = splitRedirectRulesByForce(
    fileParsed?.rules,
  );

  const cfgHeaders = convertHeadersConfig(routing?.headers);
  const cfgRedirects = convertRedirectsConfig(routing?.redirects);
  const cfgRewrites = convertRewritesConfig(routing?.rewrites);
  const cfgFallbacks = convertFallbacksConfig(routing?.fallbacks);

  // Header rules are last-match-wins, so config rules go last to override `_headers`.
  const headerRules: Array<HeaderRule> = [...(fileHeaders ?? []), ...(cfgHeaders ?? [])];
  // Routing rules are first-match-wins, so config rules go first to override
  // `_redirects`.
  const redirectRules: Array<DevRedirectRule> = [
    ...(cfgRedirects ?? []),
    ...(cfgRewrites ?? []),
    ...fileAlways,
  ];
  const mergedFallbacks = [...(cfgFallbacks ?? []), ...fileFallbacks];
  const fallbackRules = mergedFallbacks.length > 0 ? mergedFallbacks : undefined;

  return {
    headerRules,
    redirectRules,
    fallbackRules,
    redundantForceOn3xx: fileParsed?.redundantForceOn3xx ?? 0,
  };
}

/**
 * Lint each phase on its own: only duplicates within a phase shadow each other,
 * so a redirect and a fallback with the same source are fine.
 */
export function lintRoutingPhases(rules: {
  redirectRules: Array<DevRedirectRule>;
  fallbackRules: Array<DevRedirectRule> | undefined;
}): void {
  lintDuplicateSources(rules.redirectRules, 'redirects/rewrites (pre-asset)');
  lintDuplicateSources(rules.fallbackRules, 'fallbacks (post-asset)');
  lintDestinationSplats(rules.redirectRules, 'redirects/rewrites (pre-asset)');
  lintDestinationSplats(rules.fallbackRules, 'fallbacks (post-asset)');
}

/**
 * Warn about a literal `*` in a destination. Destinations substitute only
 * `:name` params such as `:splat`, so a `*` passes through unchanged.
 */
export function lintDestinationSplats(
  rules: Array<DevRedirectRule> | undefined,
  phaseName: string,
): void {
  if (!rules || rules.length === 0) {
    return;
  }

  const affected = rules.filter((r) => r.destination.includes('*'));
  if (affected.length === 0) {
    return;
  }

  const lines = affected.map(
    (r) => `  ${r.source} → ${r.destination}  (${r.origin ?? '<unknown>'})`,
  );
  voidWarn(
    `destinations in ${phaseName} contain a literal "*" — splat tokens are not substituted in destinations; use ":splat" (or other named params) or rewrite the destination:\n${lines.join('\n')}`,
  );
}

/**
 * Warn when one phase repeats an exact `source`: first match wins, so the later
 * rule never applies. Phases run separately, so callers lint each one.
 */
export function lintDuplicateSources(
  rules: Array<DevRedirectRule> | undefined,
  phaseName: string,
): void {
  if (!rules || rules.length < 2) {
    return;
  }

  const bySource = new Map<string, Array<DevRedirectRule>>();
  for (const rule of rules) {
    const existing = bySource.get(rule.source);
    if (existing) {
      existing.push(rule);
    } else {
      bySource.set(rule.source, [rule]);
    }
  }

  const lines: Array<string> = [];
  for (const [source, occurrences] of bySource) {
    if (occurrences.length < 2) {
      continue;
    }
    const origins = occurrences.map((r) => r.origin ?? '<unknown>').join(', ');
    lines.push(`  ${source}  — ${origins}`);
  }

  if (lines.length === 0) {
    return;
  }

  voidWarn(
    `duplicate rule sources detected in ${phaseName} (first match wins — the earlier entry takes effect):\n${lines.join('\n')}`,
  );
}
