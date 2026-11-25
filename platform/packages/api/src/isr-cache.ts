/**
 * API-side ISR helpers that touch `KVNamespace`. Pure key/URL helpers live in
 * `@void/isr` — import from there directly.
 */

export type IsrRoutingTarget = Readonly<{
  /** Hostname users visit (e.g., `myproject.void.app` or `example.com`). */
  hostname: string;
  /** KV routing key (e.g., project slug or `domain:<hostname>`). */
  routingKey: string;
}>;

export type IsrDeploymentResolution = Readonly<{
  /** Deployment ids dispatch may be serving from, per hostname. */
  perHostname: Map<string, Set<string>>;
  /** Union of every deployment id across every hostname (for KV scans). */
  union: Set<string>;
}>;

/**
 * Resolve the set of deployment ids that dispatch may be serving ISR content
 * from, per hostname, plus a union of every id.
 *
 * Dispatch keys ISR KV under `<projectId>/isr/v3/<deploymentId>/<host>/<path>` where
 * `deploymentId = routing.version ?? 'legacy'` for the routing entry of the
 * hostname being served. Slug routing and `domain:*` routing entries can
 * drift apart (e.g., when the domain-routing loop in deploy fails after the
 * slug write succeeded), so revalidation must resolve ids per hostname.
 *
 * For each target:
 *   - If `version` is missing or null → fall back to `'legacy'`. Any
 *     non-nullish value is coerced to a string — matches dispatch's
 *     `routing.version ?? 'legacy'`.
 *   - If the routing entry does not exist → skip (only the `activeDeploymentId`
 *     hedge below applies).
 *   - Always hedge with `activeDeploymentId ?? 'legacy'` to cover the narrow
 *     KV-vs-DB skew during a deploy.
 */
export async function resolveCurrentIsrDeployments(
  routing: KVNamespace,
  targets: ReadonlyArray<IsrRoutingTarget>,
  activeDeploymentId: string | null,
): Promise<IsrDeploymentResolution> {
  const perHostname = new Map<string, Set<string>>();
  const union = new Set<string>();
  const hedge = activeDeploymentId ?? 'legacy';

  for (const target of targets) {
    const ids = new Set<string>();
    const routingRaw = await routing.get(target.routingKey);
    if (routingRaw) {
      try {
        const routingConfig = JSON.parse(routingRaw) as { version?: unknown };
        if (routingConfig.version === null || routingConfig.version === undefined) {
          // `version` is missing or null — match dispatch's `routing.version ?? 'legacy'`.
          ids.add('legacy');
        } else {
          // Any non-nullish value mirrors dispatch, which coerces it to string
          // when building the ISR KV key. Use String(...) for the same coercion.
          ids.add(String(routingConfig.version));
        }
      } catch {
        // Malformed JSON — only the hedge below applies.
      }
    }
    ids.add(hedge);
    perHostname.set(target.hostname, ids);
    for (const id of ids) {
      union.add(id);
    }
  }

  return { perHostname, union };
}
