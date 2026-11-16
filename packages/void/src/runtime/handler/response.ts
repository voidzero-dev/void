/**
 * Tracks responses created by convertReturnValue (as opposed to responses
 * explicitly constructed by user code). Used by handlePageGet to decide
 * whether a Response should be passed through or unwrapped as page props.
 */
const convertedResponses = new WeakSet<Response>();

/** Returns true if the value is a Response that was created by convertReturnValue. */
export function isConvertedResponse(value: unknown): boolean {
  return value instanceof Response && convertedResponses.has(value);
}

/**
 * Convert a handler's return value to a Web Response.
 *
 * - Response → passthrough
 * - null/undefined → 204 No Content
 * - string → text/html
 * - object/array → JSON
 */
export function convertReturnValue(value: unknown): Response {
  if (value instanceof Response) {
    return value;
  }

  let response: Response;
  if (value === null || value === undefined) {
    response = new Response(null, { status: 204 });
  } else if (typeof value === 'string') {
    response = new Response(value, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } else {
    // object, array, number, boolean → JSON
    response = Response.json(value);
  }
  convertedResponses.add(response);
  return response;
}
