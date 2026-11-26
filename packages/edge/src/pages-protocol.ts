/** Current Pages wire version; a missing header identifies legacy clients. */
export const PAGES_PROTOCOL_VERSION = '2';

/**
 * The build a request or response belongs to. Unlike the protocol version it
 * changes with every deploy, so a tab that outlives a deployment can tell that
 * the chunks it still holds are gone.
 */
export const PAGES_BUILD_HEADER = 'X-VoidPages-Build';

/**
 * Whether a build id seen on the wire belongs to another deployment. A peer
 * that sends no id (an older Void, or a parse of a partial response) is not
 * evidence of a new build, so it never counts as a mismatch.
 */
export function isStaleBuild(buildId: string, seen: string | null | undefined): boolean {
  return buildId !== '' && typeof seen === 'string' && seen !== buildId;
}

/** Request and response headers that carry a build, empty when none is known. */
export function buildHeaders(buildId: string): Record<string, string> {
  return buildId === '' ? {} : { [PAGES_BUILD_HEADER]: buildId };
}

/**
 * Whether a cached Pages payload may answer a request. A client that names no
 * build cannot tell builds apart, so it keeps the cached payload. A client that
 * names one accepts only a payload from that same build, and an entry without an
 * id predates ids, so it is not trusted either.
 */
export function pagesPayloadFitsBuild(
  cachedBuild: string | null,
  requestBuild: string | null,
): boolean {
  return requestBuild === null || cachedBuild === requestBuild;
}
