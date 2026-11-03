/**
 * Collapses identical rows in the tail Worker's logs dataset.
 *
 * A request routed through the dispatch Worker reaches the tail Worker twice:
 * once through the dispatch Worker's tail consumer and once through the user
 * Worker's own consumer. Cloudflare delivers each copy in its own tail
 * invocation, so the tail Worker cannot drop one, and both copies are stored as
 * identical rows. Grouping by every stored column returns one row per
 * invocation. Minimal runtime logs store no URL, so `blob8` keeps the Ray ID
 * that tells requests apart. A grouped query must select `min(timestamp)` (aliased, since an
 * alias named `timestamp` would shadow the `WHERE` filter) and order by
 * selected aliases only.
 */
export const LOG_ROW_GROUP_BY =
  'GROUP BY blob1, blob2, blob3, blob4, blob5, blob6, blob7, blob8, double1';

/** Log reader body field that tells clients messages and URLs are not recorded. */
export function runtimeLogsField(env: { PLATFORM_RUNTIME_LOGS?: string }): {
  runtimeLogs?: 'minimal';
} {
  return env.PLATFORM_RUNTIME_LOGS === 'minimal' ? { runtimeLogs: 'minimal' } : {};
}
