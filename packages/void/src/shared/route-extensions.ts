// Page server companions use the first matching extension.
export const ROUTE_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'mts'] as const;

// Includes the leading dot returned by extname().
export const ROUTE_EXTENSIONS_SET: ReadonlySet<string> = new Set(
  ROUTE_EXTENSIONS.map((ext) => `.${ext}`),
);
