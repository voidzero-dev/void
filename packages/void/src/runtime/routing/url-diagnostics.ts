/** An unsatisfied marker for diagnostic fallbacks, never an accepted input. */
export type UrlTypeError<Message extends string> = [Message] extends [never]
  ? never
  : { readonly [K in Message]: never };

// Require a property ordinary argument lists cannot supply. A well-known symbol
// can be named in declarations emitted for functions that wrap routeUrl.
export type UrlErrorToken = { readonly [Symbol.toPrimitive]: never };
