import type { Context } from 'hono';

/**
 * Who renders a page loader's `c.notFound()`:
 * - `boundary`: the app defines a not-found boundary, so it renders.
 * - `fallback`: the app has none, so the root fallback renders.
 */
type LoaderNotFound = 'boundary' | 'fallback';

const loaderNotFound = new WeakMap<Context, LoaderNotFound>();

/** The loader already answered this URL with `c.notFound()`, so assets must not. */
export function handlesPageLoaderNotFound(c: Context): boolean {
  return loaderNotFound.has(c);
}

/** The app's own not-found boundary renders this response instead of the fallback. */
export function ownsLoaderNotFoundBoundary(c: Context): boolean {
  return loaderNotFound.get(c) === 'boundary';
}

/**
 * Record a loader's `c.notFound()` for the rest of the request.
 *
 * Hono resolves `c.notFound()` inside the loader call, so the marker has to be
 * set before the fallback runs. It also has to outlive the loader: the loader
 * returns the fallback's response, which must never be read as page props.
 */
export async function withLoaderNotFoundDecision(
  c: Context,
  ownBoundary: boolean,
  load: () => unknown,
): Promise<unknown> {
  const notFound = c.notFound;
  c.notFound = () => {
    // The outer page owns the decision when a fallback render re-enters a loader.
    if (!loaderNotFound.has(c)) {
      loaderNotFound.set(c, ownBoundary ? 'boundary' : 'fallback');
    }
    return notFound.call(c);
  };
  try {
    return await load();
  } finally {
    c.notFound = notFound;
  }
}
