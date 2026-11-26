/** The define the pages plugin fills in once per build. */
export const PAGES_BUILD_ID_DEFINE = 'import.meta.env.__VOID_PAGES_BUILD_ID';

/**
 * The id of the build this code was bundled into. The pages plugin defines it
 * per build; it is empty in the dev server and in tests, which turns every
 * build check into a no-op.
 */
export function pagesBuildId(): string {
  // Spelled out so the build replaces this expression with the id literal.
  const value: unknown = import.meta.env.__VOID_PAGES_BUILD_ID;
  return typeof value === 'string' ? value : '';
}
