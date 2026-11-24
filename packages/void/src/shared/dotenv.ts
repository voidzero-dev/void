/**
 * Shared dotenv parser + variable expander used by local `.env` consumers.
 *
 * Grammar: lines and values follow Vite's parser (`node:util` `parseEnv`).
 * Wrangler's dotenv (the dev Worker) agrees with it on inline `#` comments,
 * single, double and backtick quotes, `\n` in double quotes, multi-line
 * quoted values and the `export ` prefix. Keys that are not plain
 * identifiers (`A.B`, `A-B`, `export\tA`) are skipped, and `KEY: value`
 * is not read: Wrangler accepts it but Vite does not.
 *
 * Expansion supports `${VAR}` and `$VAR`, a `\$VAR` literal-escape, and
 * transitive references across earlier entries in the same record. Cycles
 * are detected and fall through to the raw literal rather than looping.
 *
 * Security note: expansion is deliberately scoped to the in-file record.
 * We do NOT consult `process.env` the way `dotenv-expand` does — a shell
 * env leaking into a parsed dotenv file would silently change its meaning
 * across machines.
 *
 * This module is a leaf — it must not import from `../log` or any non-leaf
 * module so that the prerender subprocess's worker bundle doesn't pick up
 * unwanted transitive dependencies. Warnings are surfaced through the
 * `onWarn` callback and left for the caller to route.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/** Valid dotenv key — ASCII letter/underscore followed by letters/digits/underscore. */
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ParseDotenvOptions = {
  /** Callback for expansion warnings (cycles). Caller routes to `voidWarn`. */
  onWarn?: (message: string) => void;
};

/**
 * Parse the raw contents of a dotenv file into a record, skipping invalid
 * keys and expanding `${VAR}` / `$VAR` references against earlier entries.
 */
export function parseDotenv(
  content: string,
  options: ParseDotenvOptions = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parseEnv(content))) {
    if (value !== undefined && VALID_KEY.test(key)) {
      env[key] = value;
    }
  }
  return expandDotenv(env, options);
}

/**
 * Read and parse a dotenv file. Returns `{}` when the file is missing so
 * callers can treat "no file" and "empty file" identically.
 */
export function parseDotenvFile(
  filePath: string,
  options: ParseDotenvOptions = {},
): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }
  return parseDotenv(readFileSync(filePath, 'utf8'), options);
}

/**
 * Expand `${VAR}` / `$VAR` references in every value of a record against
 * the other entries in that same record. Matches the surface of
 * `dotenv-expand` minus the `process.env` fallback.
 *
 * Semantics:
 *   - `${VAR}` and `$VAR` both resolve (bare form stops at the first
 *     non-identifier character).
 *   - `\$VAR` stays literal; the backslash is consumed.
 *   - Nested refs resolve transitively — `A=${B}`, `B=${C}`, `C=v` → `A=v`.
 *   - Cycles are detected; the offending value keeps its raw literal and
 *     `onWarn` fires once per cycle seen.
 *   - Missing refs expand to the empty string, matching dotenv-expand.
 *
 * The input record is not mutated; a fresh object is returned.
 */
export function expandDotenv(
  input: Record<string, string>,
  options: { onWarn?: (message: string) => void } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  const resolving = new Set<string>();
  const warned = new Set<string>();

  function resolveKey(key: string): string {
    if (!(key in input)) {
      return '';
    }
    if (key in out) {
      return out[key];
    }
    if (resolving.has(key)) {
      if (!warned.has(key) && options.onWarn) {
        warned.add(key);
        options.onWarn(`dotenv expansion cycle detected at "${key}" — leaving raw value in place`);
      }
      // Return the raw literal so the cycle short-circuits instead of
      // looping; callers see the un-expanded `${...}` text.
      return input[key];
    }
    resolving.add(key);
    const expanded = expandValue(input[key], resolveKey);
    resolving.delete(key);
    out[key] = expanded;
    return expanded;
  }

  for (const key of Object.keys(input)) {
    resolveKey(key);
  }
  return out;
}

/**
 * Expand a single value string. `resolve` returns the fully-expanded value
 * for a referenced key (or `''` when missing). Backslash-escapes (`\$VAR`,
 * `\${VAR}`) keep the `$...` literal and consume the backslash.
 */
function expandValue(value: string, resolve: (key: string) => string): string {
  let result = '';
  let cursor = 0;
  while (cursor < value.length) {
    const character = value[cursor];
    if (character === '\\' && cursor + 1 < value.length && value[cursor + 1] === '$') {
      // Literal `$`: consume the backslash and emit `$`.
      result += '$';
      cursor += 2;
      continue;
    }
    if (character !== '$') {
      result += character;
      cursor++;
      continue;
    }
    // `$` — peek at the next char.
    const next = value[cursor + 1];
    if (next === '{') {
      const endIndex = value.indexOf('}', cursor + 2);
      if (endIndex === -1) {
        // Unterminated `${...` — treat as literal.
        result += character;
        cursor++;
        continue;
      }
      const key = value.slice(cursor + 2, endIndex);
      if (VALID_KEY.test(key)) {
        result += resolve(key);
      } else {
        // Non-identifier inside braces → literal.
        result += value.slice(cursor, endIndex + 1);
      }
      cursor = endIndex + 1;
      continue;
    }
    if (next && /[A-Za-z_]/.test(next)) {
      let keyEndIndex = cursor + 1;
      while (keyEndIndex < value.length && /[A-Za-z0-9_]/.test(value[keyEndIndex])) {
        keyEndIndex++;
      }
      const key = value.slice(cursor + 1, keyEndIndex);
      result += resolve(key);
      cursor = keyEndIndex;
      continue;
    }
    // `$` followed by nothing consumable → literal.
    result += character;
    cursor++;
  }
  return result;
}

/**
 * Wrangler's bundled `dotenv` LINE regex (verbatim; checked against wrangler 4.147), used
 * ONLY to detect the declared KEYS wrangler would load — including the OPTIONAL `export `
 * prefix, the `KEY: val` form, and single/double/backtick quoting — so a transport-redirect /
 * config-override fence and the reserved `__VOID_` name check see exactly what wrangler's
 * dotenv load would. We read keys, never values.
 */
const WRANGLER_DOTENV_LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

/**
 * The set of declared dotenv KEYS in `filePath`, parsed the way wrangler does.
 */
export function scanWranglerDotenvKeys(filePath: string): Set<string> {
  const keys = new Set<string>();
  if (!existsSync(filePath)) {
    return keys;
  }
  const content = readFileSync(filePath, 'utf8');
  WRANGLER_DOTENV_LINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WRANGLER_DOTENV_LINE.exec(content)) !== null) {
    if (match[1]) {
      keys.add(match[1]);
    }
    // Guard against a zero-width match wedging the loop.
    if (match.index === WRANGLER_DOTENV_LINE.lastIndex) {
      WRANGLER_DOTENV_LINE.lastIndex++;
    }
  }
  return keys;
}
