/**
 * Emit the queue-name resolver used by generated native workers and framework
 * wrappers. Hosted relays send the exact logical name. Native Queue events may
 * expose a project-prefixed physical name, so fallback matching selects the
 * unique longest known `-name` suffix. Unknown or ambiguous inputs fail closed.
 *
 * `cloudflareNames` (aligned with `queueNames`) comes from
 * `void deploy --platform cloudflare`, which knows each queue's exact name.
 * Its events then match exactly: a suffix could pick the wrong queue, as
 * `app-jobs` would for queues `jobs` and `app-jobs` in Worker `app`. Logical
 * names still match, for the trigger endpoint.
 */
export function generateQueueResolverSource(
  queueNames: ReadonlyArray<string>,
  cloudflareNames?: ReadonlyArray<string>,
): string {
  if (cloudflareNames) {
    const indexByName: Record<string, number> = {};
    cloudflareNames.forEach((name, index) => {
      indexByName[name] = index;
    });
    queueNames.forEach((name, index) => {
      if (!Object.hasOwn(indexByName, name)) {
        indexByName[name] = index;
      }
    });
    return `const __queueIndexByName = ${JSON.stringify(indexByName)};
function __resolveQueueIndex(queueName) {
  if (typeof queueName !== "string" || !Object.hasOwn(__queueIndexByName, queueName)) return -1;
  return __queueIndexByName[queueName];
}`;
  }
  return `const __queueNames = ${JSON.stringify(queueNames)};
function __resolveQueueIndex(queueName) {
  if (typeof queueName !== "string") return -1;
  const exact = __queueNames.indexOf(queueName);
  if (exact !== -1) return exact;
  let match = -1;
  let matchLength = -1;
  for (let i = 0; i < __queueNames.length; i++) {
    const name = __queueNames[i];
    if (!queueName.endsWith("-" + name)) continue;
    if (name.length > matchLength) {
      match = i;
      matchLength = name.length;
    } else if (name.length === matchLength) {
      match = -1;
    }
  }
  return match;
}`;
}
