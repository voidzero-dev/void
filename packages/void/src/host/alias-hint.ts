/**
 * Detects tsconfig path aliases in module-resolution errors from files that
 * Void loads outside Vite (`env.ts` through Node's `import()`, `void.config.ts`
 * through jiti), neither of which resolves tsconfig `paths`.
 *
 * Node-only (lives under `host/`). Must not be imported from anything
 * that ships in worker bundles.
 */

/** Returns the failed specifier from a Node or jiti module-resolution error, or `null`. */
export function extractFailedSpecifier(err: unknown): string | null {
  if (!(err instanceof Error)) {
    return null;
  }
  // `import()` reports `ERR_MODULE_NOT_FOUND`; jiti loads through `require`,
  // which reports `MODULE_NOT_FOUND`.
  const code = (err as NodeJS.ErrnoException).code;
  if (
    code !== 'ERR_MODULE_NOT_FOUND' &&
    code !== 'MODULE_NOT_FOUND' &&
    code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  ) {
    return null;
  }
  // Node's message shapes: `Cannot find package '@/foo' imported from ...`
  // or `Cannot find module '@/foo' imported from ...`.
  const match = /Cannot find (?:package|module) '([^']+)'/.exec(err.message);
  return match ? (match[1] ?? null) : null;
}

/** A specifier is alias-shaped if it isn't relative, absolute, a node: URL, or a valid bare package name. */
export function looksLikeAlias(specifier: string): boolean {
  if (
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/') ||
    specifier.startsWith('node:') ||
    specifier.startsWith('file:')
  ) {
    return false;
  }
  // Bare scoped package: `@scope/name[/subpath]` where scope and name are valid.
  // Alias forms like `@/foo` fail this because the scope is empty.
  if (specifier.startsWith('@')) {
    return !/^@[^/]+\/[^/]+/.test(specifier);
  }
  // Tilde and plain `#` prefixes are common alias conventions that aren't
  // valid bare packages.
  return specifier.startsWith('~') || specifier.startsWith('#');
}

/** The alias hint for a failed load of `file`, or `null` when the error isn't an alias import. */
export function aliasHint(err: unknown, file: string): string | null {
  const specifier = extractFailedSpecifier(err);
  if (!specifier || !looksLikeAlias(specifier)) {
    return null;
  }
  return (
    `Hint: '${specifier}' looks like a tsconfig path alias. ` +
    `${file} does not resolve tsconfig "paths" — ` +
    `use a relative import (e.g. "./shared/...") instead.`
  );
}
