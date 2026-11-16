// Internal: not part of the package exports. `defineHandler(middleware..., leaf)`
// records its middleware and leaf here so page loaders and actions can build the
// page response inside the middleware chain, as route handlers do.
import type { CloudContext } from './handler.ts';

type Middleware = (c: CloudContext, next: () => Promise<void>) => unknown;
type Leaf = (c: CloudContext) => unknown;

export type HandlerComposition = { middlewares: Array<Middleware>; leaf: Leaf };

const compositionKey = '__voidHandlerComposition';

export function getHandlerComposition(handler: unknown): HandlerComposition | undefined {
  return (handler as { [compositionKey]?: HandlerComposition } | undefined)?.[compositionKey];
}

/** Record the composition; a nested composed leaf is flattened into one chain. */
export function setHandlerComposition<T extends object>(
  handler: T,
  middlewares: Array<Middleware>,
  leaf: Leaf,
): T {
  const nested = getHandlerComposition(leaf);
  const composition = nested
    ? { middlewares: [...middlewares, ...nested.middlewares], leaf: nested.leaf }
    : { middlewares, leaf };
  Object.defineProperty(handler, compositionKey, { value: composition });
  return handler;
}

/**
 * Run middleware on the current context around `endpoint`, the way Hono's
 * compose does: a Response returned by a middleware replaces `c.res`, the
 * endpoint's Response becomes `c.res`, and middleware can edit `c.res` after
 * `next()`. Returns the final `c.res`.
 */
export async function executeComposedHandler(
  c: CloudContext,
  middlewares: Array<Middleware>,
  endpoint: () => Promise<Response>,
): Promise<Response> {
  let index = 0;
  const dispatch = async (): Promise<void> => {
    if (index < middlewares.length) {
      const response = await middlewares[index++](c, dispatch);
      if (response instanceof Response) {
        c.res = response;
      }
    } else {
      c.res = await endpoint();
    }
  };
  await dispatch();
  return c.res;
}
