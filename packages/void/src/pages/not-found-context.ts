import type { Context } from 'hono';

const loaderNotFound = new WeakSet<Context>();
const loaderBoundaries = new WeakSet<Context>();

/** The loader already answered this URL with `c.notFound()`, so assets must not. */
export function handlesPageLoaderNotFound(c: Context): boolean {
  return loaderNotFound.has(c);
}

/** The active loader's not-found boundary renders instead of the fallback. */
export function ownsLoaderNotFoundBoundary(c: Context): boolean {
  return loaderBoundaries.has(c);
}

/**
 * Record a loader's `c.notFound()` for the rest of the request.
 *
 * Hono resolves `c.notFound()` inside the loader call, so the marker has to be
 * set before the fallback runs. It also has to outlive the loader: the loader
 * returns the fallback's response, which must never be read as page props.
 * Boundary ownership ends with the loader so outer middleware can render the
 * root not-found page after `await next()`.
 */
export async function withLoaderNotFoundDecision(
  c: Context,
  ownBoundary: boolean,
  load: () => unknown,
): Promise<unknown> {
  const notFound = c.notFound;
  const alreadyOwned = loaderBoundaries.has(c);
  c.notFound = () => {
    // The outer page owns the decision when a fallback render re-enters a loader.
    if (!loaderNotFound.has(c)) {
      loaderNotFound.add(c);
      if (ownBoundary) {
        loaderBoundaries.add(c);
      }
    }
    return notFound.call(c);
  };
  try {
    return await load();
  } finally {
    c.notFound = notFound;
    if (!alreadyOwned) {
      loaderBoundaries.delete(c);
    }
  }
}
