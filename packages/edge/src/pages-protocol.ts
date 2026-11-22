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
  return buildId !== '' && seen != null && seen !== buildId;
}

/** Request and response headers that carry a build, empty when none is known. */
export function buildHeaders(buildId: string): Record<string, string> {
  return buildId === '' ? {} : { [PAGES_BUILD_HEADER]: buildId };
}
