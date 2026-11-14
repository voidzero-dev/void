export type Binding = readonly [
  kind: 'child' | 'attr' | 'event' | 'spread',
  key: number,
  name: string,
  value: unknown,
];
export type Change = <T>(value: T) => T;
export type Initialize = (change: Change) => () => unknown;
export const voidTags = /* @__PURE__ */ new Set(
  'area base br col embed hr img input link meta param source track wbr'.split(' '),
);
export function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
}
export const booleanAttributes = new Set(
  'allowfullscreen async autofocus autoplay checked controls default defer disabled formnovalidate hidden inert ismap itemscope loop multiple muted nomodule novalidate open playsinline readonly required reversed selected'.split(
    ' ',
  ),
);
export function attribute(name: string, value: unknown): string {
  if (!/^[a-zA-Z_:][\w:.-]*$/.test(name) || /^on/i.test(name) || name.startsWith('data-vv-')) {
    throw new Error(`Unsafe view attribute: ${name}`);
  }
  if (value == null || (booleanAttributes.has(name) && !value)) {
    return '';
  }
  if (booleanAttributes.has(name)) {
    return ` ${name}`;
  }
  if (typeof value === 'function' || typeof value === 'object') {
    throw new Error(`View attribute ${name} must be a scalar`);
  }
  return ` ${name}="${escapeHtml(value)}"`;
}

export type Encoded =
  | ['html', string]
  | ['undefined']
  | ['array', Array<Encoded>]
  | ['object', Array<[string, Encoded]>]
  | ['scalar', string | number | boolean | null];
