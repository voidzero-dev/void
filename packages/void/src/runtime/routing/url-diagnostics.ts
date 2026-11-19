// Require a property ordinary argument lists cannot supply. A well-known symbol
// can be named in declarations emitted for functions that wrap routeUrl.
export type UrlErrorToken = { readonly [Symbol.toPrimitive]: never };
