/** An unsatisfied marker for diagnostic fallbacks, never an accepted input. */
export type UrlTypeError<Message extends string> = [Message] extends [never]
  ? never
  : { readonly [K in Message]: never };

declare const invalid: unique symbol;
/** A private token prevents diagnostic path types from becoming valid inputs. */
export type UrlErrorToken = { readonly [invalid]: never };
