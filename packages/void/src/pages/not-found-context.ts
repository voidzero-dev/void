import type { Context } from 'hono';

const loaderBoundaries = new WeakSet<Context>();

export function handlesPageLoaderNotFound(c: Context): boolean {
  return loaderBoundaries.has(c);
}

/** Defer only Void's app fallback while a loader can select its own boundary. */
export async function withLoaderNotFoundBoundary(
  c: Context,
  load: () => unknown,
): Promise<unknown> {
  const alreadyHandled = loaderBoundaries.has(c);
  loaderBoundaries.add(c);
  try {
    return await load();
  } finally {
    if (!alreadyHandled) {
      loaderBoundaries.delete(c);
    }
  }
}
