/** An unsatisfied marker for diagnostic fallbacks, never an accepted input. */
export type UrlTypeError<Message extends string> = [Message] extends [never]
  ? never
  : { readonly [K in Message]: never };

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
