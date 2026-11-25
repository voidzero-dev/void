/**
 * Path-pattern matchers shared by routing, header, and revalidate rules.
 *
 * Each pattern is parsed once into tokens, and matching walks those tokens
 * over the pathname. No RegExp is built from pattern text, so a pattern cannot
 * hit engine size limits or backtrack: a match costs at most
 * (steps) x (path length - pattern minimum + 1).
 *
 * `compilePattern` syntax:
 *   `:name`   — single path segment, captured as `name`
 *   `:name*`  — zero or more path segments, captured as `name`
 *   `*`       — zero or more path segments, captured as `splat` (legacy)
 *
 * When a legacy pattern contains multiple anonymous `*`, the first captures
 * as `splat` and later wildcards are non-capturing.
 */

const MAX_CACHE = 256;

export type CompiledPattern = Readonly<{
  /**
   * @deprecated Built on first read for older callers; Void does not use it.
   * It can backtrack and fails past engine size limits. Use `matchPattern` or
   * `matchPatternCaptures`.
   */
  regex: RegExp;
  paramNames: ReadonlyArray<string>;
}>;

// `text` matches itself. The others match a run of UTF-16 code units:
//   seg  — 1 or more, none is '/'                          (regex `[^/]+`)
//   any  — 0 or more, none is \n \r U+2028 U+2029          (regex `.*`)
//   plus — 1 or more, same units as `any`                  (regex `.+`)
type Token = { kind: 'text'; text: string } | { kind: 'seg' | 'any' | 'plus'; name?: string };

type Prepared = Readonly<{ steps: ReadonlyArray<Token>; starts: Int32Array; minLength: number }>;

type Compiled = CompiledPattern &
  Prepared & {
    error: string | undefined;
    /** Index in `steps` of the last named step, or -1. */
    lastNamed: number;
  };

/** LRU read: re-inserting a hit moves it to the most-recently-used end of Map order. */
function lruGet<V>(cache: Map<string, V>, key: string): V | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

/** LRU write: evict the least-recently-used entry once the cache is full. */
function lruSet<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.size >= MAX_CACHE) {
    const first = cache.keys().next();
    if (!first.done) {
      cache.delete(first.value);
    }
  }
  cache.set(key, value);
}

/** `[A-Za-z0-9_]` */
function isNameChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

/** Whether a wildcard of this kind may take the code unit. */
function accepts(kind: Token['kind'], code: number): boolean {
  if (kind === 'seg') {
    return code !== 47; // '/'
  }
  return code !== 10 && code !== 13 && code !== 0x20_28 && code !== 0x20_29;
}

function pushText(tokens: Array<Token>, text: string): void {
  if (!text) {
    return;
  }
  const last = tokens.at(-1);
  if (last?.kind === 'text') {
    last.text += text;
  } else {
    tokens.push({ kind: 'text', text });
  }
}

/** `compilePattern` syntax, read left to right. */
function parseCapture(source: string) {
  const tokens: Array<Token> = [];
  const paramNames: Array<string> = [];
  let splatTaken = false;
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === ':') {
      let end = index + 1;
      while (end < source.length && isNameChar(source.charCodeAt(end))) {
        end++;
      }
      if (end === index + 1) {
        // No name follows, so the colon is literal.
        pushText(tokens, ':');
        index++;
        continue;
      }
      const name = source.slice(index + 1, end);
      paramNames.push(name);
      const rest = source[end] === '*';
      tokens.push({ kind: rest ? 'any' : 'seg', name });
      index = rest ? end + 1 : end;
    } else if (character === '*') {
      if (splatTaken) {
        tokens.push({ kind: 'any' });
      } else {
        paramNames.push('splat');
        tokens.push({ kind: 'any', name: 'splat' });
        splatTaken = true;
      }
      index++;
    } else {
      let end = index + 1;
      while (end < source.length && source[end] !== ':' && source[end] !== '*') {
        end++;
      }
      pushText(tokens, source.slice(index, end));
      index = end;
    }
  }
  return { tokens, paramNames };
}

/** Text in which only `*` is special. */
function parseStars(tokens: Array<Token>, text: string): void {
  const parts = text.split('*');
  pushText(tokens, parts[0]);
  for (let k = 1; k < parts.length; k++) {
    tokens.push({ kind: 'any' });
    pushText(tokens, parts[k]);
  }
}

/** `routing.revalidate` / page syntax: params are whole segments. */
function parseSegments(source: string): Array<Token> {
  const tokens: Array<Token> = [];
  const segments = source.split('/');
  for (let k = 0; k < segments.length; k++) {
    const segment = segments[k];
    if (k > 0) {
      pushText(tokens, '/');
    }
    const name = segment.slice(1, -4);
    if (segment[0] !== ':' || segment.length < 2) {
      parseStars(tokens, segment);
    } else if (segment.length > 5 && segment.endsWith('{.+}') && !/[{}]/.test(name)) {
      tokens.push({ kind: 'plus' });
    } else {
      // Whatever follows the ':' only names the param.
      tokens.push({ kind: 'seg' });
    }
  }
  return tokens;
}

/**
 * Drop an `any` that directly follows another `any`: the first takes every
 * unit the pair could take, so the second always matches ''. Every other step
 * needs at least one unit, so a path of length m faces at most 2m + 1 steps.
 */
function prepare(tokens: ReadonlyArray<Token>): Prepared {
  const steps: Array<Token> = [];
  for (const token of tokens) {
    if (!(token.kind === 'any' && steps.at(-1)?.kind === 'any')) {
      steps.push(token);
    }
  }
  // starts[i]: the fewest units the steps before i consume, i.e. the earliest
  // position where step i can begin.
  const starts = new Int32Array(steps.length + 1);
  steps.forEach((step, i) => {
    const shortest = step.kind === 'text' ? step.text.length : step.kind === 'any' ? 0 : 1;
    starts[i + 1] = starts[i] + shortest;
  });
  return { steps, starts, minLength: starts[steps.length] };
}

/*
 * Rows. Step i can only begin at a position p in [starts[i], starts[i] + slack],
 * where slack = path.length - minLength: earlier and the steps before it could
 * not fit, later and the steps after it could not. So every row has
 * slack + 1 entries and row[d] is about position starts[i] + d.
 *
 * row[d] is 1 when steps i..n-1 can match path from that position to the end.
 * A text step of length L moves both the position and starts[] by L, and a
 * one-unit wildcard moves both by 1, so the index d lines up between a row and
 * the next one:
 *
 *   text      row[d] = next[d] && path has the text at p
 *   seg/plus  row[d] = path[p] allowed && (next[d] || row[d + 1])
 *   any       row[d] = next[d] || (path[p] allowed && row[d + 1])
 *
 * (row[slack + 1] counts as 0.) Returns whether any entry is 1.
 */
function stepBack(
  step: Token,
  path: string,
  start: number,
  next: Uint8Array,
  row: Uint8Array,
): boolean {
  let found = 0;
  if (step.kind === 'text') {
    for (let d = row.length - 1; d >= 0; d--) {
      const value = next[d] === 1 && path.startsWith(step.text, start + d) ? 1 : 0;
      row[d] = value;
      found |= value;
    }
    return found === 1;
  }
  const kind = step.kind;
  let after = 0; // row[d + 1]; 0 past the window
  for (let d = row.length - 1; d >= 0; d--) {
    // Path reads stay inside the path: seg/plus need a unit at every p in the
    // window, and `any` reads only when after === 1, i.e. p is not the last slot.
    const value =
      kind === 'any'
        ? next[d] === 1 || (after === 1 && accepts(kind, path.charCodeAt(start + d)))
        : (next[d] === 1 || after === 1) && accepts(kind, path.charCodeAt(start + d));
    after = value ? 1 : 0;
    row[d] = after;
    found |= after;
  }
  return found === 1;
}

/** The row after the last step: only the end of the path (d = slack) finishes. */
function endRow(width: number): Uint8Array {
  const row = new Uint8Array(width);
  row[width - 1] = 1;
  return row;
}

/** Checks that reject most paths before any row is built. */
function quickReject({ steps, minLength }: Prepared, path: string): boolean {
  const first = steps[0];
  const last = steps.at(-1);
  return (
    path.length < minLength ||
    (first?.kind === 'text' && !path.startsWith(first.text)) ||
    (last?.kind === 'text' && !path.endsWith(last.text))
  );
}

/** Whether the steps match the whole path. Keeps two rows. */
function matches(prepared: Prepared, path: string): boolean {
  if (quickReject(prepared, path)) {
    return false;
  }
  const { steps, starts, minLength } = prepared;
  let next: Uint8Array = endRow(path.length - minLength + 1);
  let row: Uint8Array = new Uint8Array(next.length);
  // quickReject proved a leading text step, and only position 0 matters for it.
  const first = steps[0]?.kind === 'text' ? 1 : 0;
  for (let i = steps.length - 1; i >= first; i--) {
    if (!stepBack(steps[i], path, starts[i], next, row)) {
      return false;
    }
    const done = next;
    next = row;
    row = done;
  }
  return next[0] === 1;
}

/**
 * Where a step that begins at p (row index d) ends: the longest choice after
 * which the rest still matches. `next` is the row of the following step.
 */
function greedyEnd(step: Token, path: string, p: number, d: number, next: Uint8Array): number {
  if (step.kind === 'text') {
    return p + step.text.length;
  }
  const shortest = step.kind === 'any' ? 0 : 1;
  const longest = next.length - 1 - d + shortest; // keeps d + k - shortest inside `next`
  let k = 0;
  while (k < longest && accepts(step.kind, path.charCodeAt(p + k))) {
    k++;
  }
  while (k > shortest && next[d + k - shortest] !== 1) {
    k--;
  }
  return p + k;
}

/**
 * End positions of steps 0..upTo in the match that JS backtracking returns
 * (each wildcard, left to right, takes the longest run that still lets the
 * rest match), or null. The backward pass keeps a copy of every `size`-th
 * row; the forward pass rebuilds one block of rows at a time into a fixed
 * pool. About 2 * sqrt(n) rows are alive at once, and each row is computed at
 * most twice.
 */
function greedyEnds(prepared: Prepared, path: string, upTo: number): Int32Array | null {
  if (quickReject(prepared, path)) {
    return null;
  }
  const { steps, starts, minLength } = prepared;
  const n = steps.length;
  const width = path.length - minLength + 1;
  // Small tables keep every row (size 1), so the forward pass rebuilds nothing.
  const size = n * width <= 1 << 16 ? 1 : Math.ceil(Math.sqrt(n));
  const saved = new Map<number, Uint8Array>([[n, endRow(width)]]);
  let next: Uint8Array = endRow(width);
  let row: Uint8Array = new Uint8Array(width);
  const first = steps[0]?.kind === 'text' ? 1 : 0;
  for (let i = n - 1; i >= first; i--) {
    if (!stepBack(steps[i], path, starts[i], next, row)) {
      return null;
    }
    if (i % size === 0) {
      saved.set(i, row.slice());
    }
    const done = next;
    next = row;
    row = done;
  }
  if (next[0] !== 1) {
    return null;
  }
  const pool = Array.from({ length: size }, () => new Uint8Array(width));
  let top = 0;
  // oxlint-disable-next-line typescript/no-non-null-assertion -- The checkpoint pass saves every block boundary, including the current top row.
  const rowAt = (r: number) => (r === top ? saved.get(r)! : pool[r % size]);
  const ends = new Int32Array(upTo + 1);
  let p = 0;
  for (let i = 0; i <= upTo; i++) {
    if (i + 1 > top) {
      // Blocks are entered in order at their first row, so each is rebuilt once.
      top = Math.min(n, Math.ceil((i + 1) / size) * size);
      for (let r = top - 1; r > i; r--) {
        stepBack(steps[r], path, starts[r], rowAt(r + 1), pool[r % size]);
      }
    }
    p = greedyEnd(steps[i], path, p, p - starts[i], rowAt(i + 1));
    ends[i] = p;
  }
  return ends;
}

/** The regex the earlier string-building compiler produced, for the deprecated `regex` view. */
function toRegExp(tokens: ReadonlyArray<Token>): RegExp {
  let body = '';
  for (const token of tokens) {
    if (token.kind === 'text') {
      body += token.text.replaceAll(/[.+?^${}()|[\]\\:]/g, String.raw`\$&`);
    } else if (token.kind === 'seg') {
      body += `(?<${token.name}>[^/]+)`;
    } else {
      body += token.name ? `(?<${token.name}>.*)` : '.*';
    }
  }
  return new RegExp(`^${body}$`);
}

const compileCache = new Map<string, Compiled>();

function compile(source: string): Compiled {
  const cached = lruGet(compileCache, source);
  if (cached) {
    return cached;
  }
  const { tokens, paramNames } = parseCapture(source);
  let error: string | undefined;
  const seen = new Set<string>();
  for (const name of paramNames) {
    if (seen.has(name)) {
      error ??= `Duplicate capture group name "${name}"`;
    } else if (name.charCodeAt(0) >= 48 && name.charCodeAt(0) <= 57) {
      // A JS group name cannot start with a digit; keep rejecting those.
      error ??= `Invalid capture group name "${name}"`;
    }
    seen.add(name);
  }
  const prepared = prepare(tokens);
  let lastNamed = -1;
  prepared.steps.forEach((step, i) => {
    if (step.kind !== 'text' && step.name) {
      lastNamed = i;
    }
  });
  let regex: RegExp | undefined;
  const compiled: Compiled = {
    ...prepared,
    paramNames,
    error,
    lastNamed,
    get regex() {
      return (regex ??= toRegExp(parseCapture(source).tokens));
    },
  };
  lruSet(compileCache, source, compiled);
  return compiled;
}

/**
 * Parse a capture pattern. Throws a SyntaxError for a malformed one: a repeated
 * name (`/:id/:id`, `/:splat/*`) or a name that starts with a digit (`/:1`).
 */
export function compilePattern(source: string): CompiledPattern {
  const compiled = compile(source);
  if (compiled.error) {
    throw new SyntaxError(compiled.error);
  }
  return compiled;
}

/**
 * Match a pattern against a pathname. Returns captured params, or null.
 * A malformed pattern (e.g. a repeated name like `/:splat/*`) also returns
 * null, so one bad rule cannot fail unrelated requests.
 */
export function matchPatternCaptures(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const compiled = compile(pattern);
  if (compiled.error) {
    return null;
  }
  const { steps, lastNamed } = compiled;
  const ends = lastNamed === -1 ? undefined : greedyEnds(compiled, pathname, lastNamed);
  if (ends === null || (ends === undefined && !matches(compiled, pathname))) {
    return null;
  }
  // Every name gets a value, in source order; one dropped by `prepare` matched ''.
  const params: Record<string, string> = {};
  Object.setPrototypeOf(params, null);
  for (const name of compiled.paramNames) {
    params[name] = '';
  }
  for (let i = 0; ends && i <= lastNamed; i++) {
    const step = steps[i];
    if (step.kind !== 'text' && step.name) {
      params[step.name] = pathname.slice(i === 0 ? 0 : ends[i - 1], ends[i]);
    }
  }
  return params;
}

/**
 * Match a pattern against a pathname (boolean form). Malformed patterns yield
 * `false` rather than throwing (see `matchPatternCaptures`).
 */
export function matchPattern(pattern: string, pathname: string): boolean {
  const compiled = compile(pattern);
  return compiled.error === undefined && matches(compiled, pathname);
}

const literalCache = new Map<string, Prepared>();

/**
 * Match a pattern against a pathname using LITERAL semantics — no named
 * captures. Only `*` is special (matches any characters including `/`); every
 * other character (including `:`) is treated as a literal.
 *
 * Used for header rules and `routing.revalidateQueryAllowlist` keys, which
 * never had `:name` capture syntax; existing tenant configs may include literal
 * `:` (e.g. `/api/v1:health`, `:batchGet`-style URLs). Routing rules
 * (`redirects`/`rewrites`/`fallbacks`) use the capture-aware `compilePattern`.
 */
export function matchLiteralPattern(pattern: string, pathname: string): boolean {
  let prepared = lruGet(literalCache, pattern);
  if (!prepared) {
    const tokens: Array<Token> = [];
    parseStars(tokens, pattern);
    prepared = prepare(tokens);
    lruSet(literalCache, pattern, prepared);
  }
  return matches(prepared, pathname);
}

const segmentCache = new Map<string, Prepared>();

/**
 * Match a `routing.revalidate` key or page pattern against a pathname. Like
 * `matchLiteralPattern`, except for whole-segment params:
 *   `:name`      — exactly one non-empty path segment (any non-`/` name)
 *   `:name{.+}`  — one or more characters that may cross `/`
 * A mid-segment `:` (`/api/v1:health`) stays literal, and any other `{...}`
 * constraint keeps the single-segment meaning. Has its own cache because the
 * same source parses differently here.
 */
export function matchSegmentPattern(pattern: string, pathname: string): boolean {
  let prepared = lruGet(segmentCache, pattern);
  if (!prepared) {
    prepared = prepare(parseSegments(pattern));
    lruSet(segmentCache, pattern, prepared);
  }
  return matches(prepared, pathname);
}

/**
 * Substitute `:name` and `:name*` tokens in a destination string with the
 * matching named captures from `params`. `:splat` works for legacy `*` patterns
 * because `compilePattern` captures anonymous `*` as `splat`.
 */
export function substituteParams(destination: string, params: Record<string, string>): string {
  const result = destination.replaceAll(/:([A-Za-z0-9_]+)\*?/g, (whole, name: string) => {
    return params[name] ?? whole;
  });
  // A capture can start with '/', so a path destination must stay on this site.
  if (/^[/\\]{2}/.test(result) && !/^[/\\]{2}/.test(destination)) {
    return '/' + result.replace(/^[/\\]+/, '');
  }
  return result;
}
