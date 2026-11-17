/** An unsatisfied marker for diagnostic fallbacks, never an accepted input. */
export type UrlTypeError<Message extends string> = { readonly __voidUrlError: Message };

/** Inspect every union member, including members with disjoint property names. */
export type InvalidValueKeys<Values, Allowed> = Values extends unknown
  ? { [K in keyof Values]-?: [Values[K]] extends [Allowed] ? never : K }[keyof Values]
  : never;

/** Preserve numeric and symbol keys when explaining an invalid property. */
export type DiagnosticKeyName<K> = K extends string | number
  ? `${K}`
  : K extends symbol
    ? 'symbol'
    : never;
