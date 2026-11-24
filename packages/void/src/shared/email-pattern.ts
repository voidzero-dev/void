/**
 * Compile and order inbound email address patterns without filesystem access.
 * Match with the `i` flag so captures preserve the recipient's original case.
 * Order: static + tag, static, dynamic + tag, then dynamic.
 */

/** Token identifies a single segment of the local-part pattern (before/after the `+`). */
type Segment = { kind: 'literal'; value: string } | { kind: 'param'; name: string };

export type EmailPatternKind = 'static' | 'static-tag' | 'dynamic' | 'dynamic-tag';

export interface CompiledEmailPattern {
  kind: EmailPatternKind;
  /** Regex source (anchored). Apply with the `i` flag; see the file header. */
  regexSource: string;
  /** Capture-group names in order; empty for `static`. */
  paramNames: Array<string>;
}

const PARAM_RE = /^\[([a-z][a-z0-9]*)\]$/;
const LITERAL_RE = /^[a-z0-9._-]+$/;

function compileSegment(part: string): Segment | null {
  const param = PARAM_RE.exec(part);
  if (param) {
    return { kind: 'param', name: param[1] };
  }
  if (!LITERAL_RE.test(part)) {
    return null;
  }
  return { kind: 'literal', value: part };
}

function escapeLiteral(value: string): string {
  // Of the allowed literal chars `[a-z0-9._-]`, only `.` is regex-meaningful.
  return value.replaceAll('.', '\\.');
}

function segmentRegex(s: Segment): string {
  return s.kind === 'literal' ? escapeLiteral(s.value) : '([^+@]+)';
}

function patternKind(prefix: Segment, tag?: Segment): EmailPatternKind {
  const prefixDynamic = prefix.kind === 'param';
  if (tag) {
    return prefixDynamic ? 'dynamic-tag' : 'static-tag';
  }
  return prefixDynamic ? 'dynamic' : 'static';
}

/**
 * Compile a basename like `support`, `support+[ticket]`, `[user]`, or
 * `[user]+[tag]` into a match pattern, or return `null` if the basename
 * uses characters or shapes outside the supported grammar.
 */
export function compileEmailPattern(basename: string): CompiledEmailPattern | null {
  const lower = basename.toLowerCase();
  // We allow at most one `+` separator (subaddress tag). Anything else is invalid.
  const parts = lower.split('+');
  if (parts.length > 2) {
    return null;
  }
  const prefix = compileSegment(parts[0] ?? '');
  if (!prefix) {
    return null;
  }
  let tag: Segment | undefined;
  if (parts.length === 2) {
    const compiled = compileSegment(parts[1] ?? '');
    if (!compiled) {
      return null;
    }
    tag = compiled;
  }

  const paramNames: Array<string> = [];
  if (prefix.kind === 'param') {
    paramNames.push(prefix.name);
  }
  if (tag?.kind === 'param') {
    paramNames.push(tag.name);
  }
  if (new Set(paramNames).size !== paramNames.length) {
    const dupes = paramNames.filter((n, i) => paramNames.indexOf(n) !== i);
    throw new Error(
      `email handler "${basename}" has duplicate param names: ${dupes.join(', ')}. Each [name] segment must be unique within a single handler filename.`,
    );
  }

  const segments: Array<string> = [segmentRegex(prefix)];
  if (tag) {
    segments.push('\\+', segmentRegex(tag));
  }
  return {
    kind: patternKind(prefix, tag),
    regexSource: `^${segments.join('')}$`,
    paramNames,
  };
}

/**
 * Kind order: most specific first. static-tag beats static (more
 * constraints), dynamic-tag beats dynamic. Matches the precedence list in
 * the file header.
 */
const DISPATCH_ORDER: Record<EmailPatternKind, number> = {
  'static-tag': 0,
  static: 1,
  'dynamic-tag': 2,
  dynamic: 3,
};

/** The two fields the dispatch order is computed from. */
export interface EmailRouteOrderKey {
  /** Handler name as written, e.g. "support+[ticket]" (a basename or a harness route key). */
  address: string;
  pattern: CompiledEmailPattern;
}

/**
 * The ONE dispatch comparator. The generated `__emailHandler` and the
 * `createInboundTestHarness` route table both return on the first pattern
 * that matches, so whatever sorts first owns every address it matches.
 *
 *   1. kind, per `DISPATCH_ORDER`
 *   2. fewer captures first — `support+vip` and `support+[tag]` are both
 *      `static-tag` and both match `support+vip@`; the literal tag must be
 *      tried first or the exact handler is dead code. Same for
 *      `[user]+vip` over `[user]+[tag]`.
 *   3. alphabetical, so the table is deterministic across filesystems.
 *
 * Two patterns with the same regex source share a kind and a capture count,
 * so the scanner's collision check can still name the alphabetically-first one.
 */
export function compareEmailRoutes(a: EmailRouteOrderKey, b: EmailRouteOrderKey): number {
  const kind = DISPATCH_ORDER[a.pattern.kind] - DISPATCH_ORDER[b.pattern.kind];
  if (kind !== 0) {
    return kind;
  }
  const captures = a.pattern.paramNames.length - b.pattern.paramNames.length;
  if (captures !== 0) {
    return captures;
  }
  return a.address.localeCompare(b.address);
}
