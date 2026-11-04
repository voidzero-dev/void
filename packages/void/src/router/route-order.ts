/** How a pattern segment matches: as written, one URL segment, or the rest of the path. */
export type RouteSegmentKind = 'static' | 'param' | 'rest';

/**
 * Classify one segment of a route pattern. `*` and `:name{.+}` match the rest of the path,
 * `:name` matches one segment, and anything else matches as written. Pages match with the
 * same rules on the client (see `patternToRegex`), so ranking and matching agree.
 */
export function routeSegmentKind(segment: string): RouteSegmentKind {
  if (segment === '*') {
    return 'rest';
  }
  if (segment.length < 2 || segment[0] !== ':') {
    return 'static';
  }
  const name = segment.endsWith('{.+}') ? segment.slice(1, -4) : '';
  return name && !name.includes('{') && !name.includes('}') ? 'rest' : 'param';
}

const SEGMENT_RANK: Record<RouteSegmentKind, number> = { static: 0, param: 1, rest: 2 };

/**
 * Order routes so that, of any two that match the same URL, the more specific one comes first.
 * Hono and the Pages client matcher both use the first match.
 *
 * Catch-all routes come last and fully static routes first. Otherwise the first segment that
 * differs decides: static before `:param` before catch-all. Parameter names never decide, so
 * `/:lang/about` ranks ahead of `/:category/:item`. Two different static segments can't match
 * the same URL, so their text only keeps the order stable.
 */
export function compareRouteSpecificity(
  a: { pattern: string; catchAll: boolean },
  b: { pattern: string; catchAll: boolean },
): number {
  if (a.catchAll !== b.catchAll) {
    return a.catchAll ? 1 : -1;
  }
  const aSegments = a.pattern.split('/');
  const bSegments = b.pattern.split('/');
  const aKinds = aSegments.map(routeSegmentKind);
  const bKinds = bSegments.map(routeSegmentKind);
  // A static route never shares a URL with a more specific one, and Pages looks
  // up the leading run of static routes exactly.
  const aStatic = aKinds.every((kind) => kind === 'static');
  const bStatic = bKinds.every((kind) => kind === 'static');
  if (aStatic !== bStatic) {
    return aStatic ? -1 : 1;
  }
  const shared = Math.min(aSegments.length, bSegments.length);
  for (let i = 0; i < shared; i++) {
    const rank = SEGMENT_RANK[aKinds[i]] - SEGMENT_RANK[bKinds[i]];
    if (rank !== 0) {
      return rank;
    }
    if (aKinds[i] === 'static' && aSegments[i] !== bSegments[i]) {
      return compareText(aSegments[i], bSegments[i]);
    }
  }
  return aSegments.length - bSegments.length || compareText(a.pattern, b.pattern);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
