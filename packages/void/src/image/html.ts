/**
 * Helpers for adapters that render `getImgProps` results as HTML attributes
 * (Vue, Svelte, Solid, islands) and for `<link rel="preload" as="image">`.
 */
import type { ImageMeta, ImagePreloadLink, ImageStyle, ImgProps } from './types.ts';

// React DOM's unitless CSS properties: numbers other than 0 get `px` otherwise.
const UNITLESS_NUMBERS = new Set(
  'animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp msAnimationIterationCount msFlex msZoom msFlexGrow msFlexNegative msFlexOrder msFlexPositive msFlexShrink msGridColumn msGridColumnSpan msGridRow msGridRowSpan WebkitAnimationIterationCount WebkitBoxFlex WebKitBoxFlexGroup WebkitBoxOrdinalGroup WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive WebkitFlexShrink WebkitLineClamp'.split(
    ' ',
  ),
);

/** React prop names `getImgProps` may return, mapped to HTML attribute names. */
const HTML_ATTRIBUTE_NAMES: Record<string, string> = {
  className: 'class',
  srcSet: 'srcset',
  fetchPriority: 'fetchpriority',
  crossOrigin: 'crossorigin',
  referrerPolicy: 'referrerpolicy',
  useMap: 'usemap',
  isMap: 'ismap',
  tabIndex: 'tabindex',
};

/**
 * Serialize a style object as React DOM does: kebab-case names (`ms` prefix
 * becomes `-ms-`), `px` for non-zero numbers of unit properties, trimmed
 * strings, `;`-separated, with `undefined`, `null`, booleans and `''` dropped.
 * The result is not HTML-escaped.
 */
export function styleToString(style: ImageStyle): string {
  const declarations: Array<string> = [];
  for (const name of Object.keys(style)) {
    const value: unknown = style[name];
    if (value == null || typeof value === 'boolean' || value === '') {
      continue;
    }
    if (name.startsWith('--')) {
      declarations.push(`${name}:${String(value).trim()}`);
      continue;
    }
    const cssName = name
      .replace(/([A-Z])/g, '-$1')
      .toLowerCase()
      .replace(/^ms-/, '-ms-');
    const cssValue =
      typeof value === 'number'
        ? value === 0 || UNITLESS_NUMBERS.has(name)
          ? String(value)
          : `${value}px`
        : String(value).trim();
    declarations.push(`${cssName}:${cssValue}`);
  }
  return declarations.join(';');
}

/**
 * `getImgProps` props as HTML attributes, in the same order: React names
 * become HTML names (`srcSet` → `srcset`, `className` → `class`,
 * `fetchPriority` → `fetchpriority`, `crossOrigin` → `crossorigin`,
 * `referrerPolicy` → `referrerpolicy`), `style` becomes a CSS string (omitted
 * when empty), and `undefined`, `null`, functions and other objects are dropped.
 */
export function toHtmlImgAttributes(
  props: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value == null) {
      continue;
    }
    if (key === 'style') {
      if (typeof value === 'string') {
        if (value) {
          attributes.style = value;
        }
        continue;
      }
      if (typeof value === 'object') {
        const css = styleToString(value as ImageStyle);
        if (css) {
          attributes.style = css;
        }
      }
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      continue;
    }
    attributes[HTML_ATTRIBUTE_NAMES[key] ?? key] = value;
  }
  return attributes;
}

function stringAttribute(
  props: Record<string, unknown>,
  ...names: Array<string>
): string | undefined {
  for (const name of names) {
    const value = props[name];
    if (typeof value === 'string' && value) {
      return value;
    }
  }
  return undefined;
}

/**
 * `crossorigin` as the `<img>` renders it: `''` (anonymous) and a bare
 * attribute (`true`) both become `''`, so the preload's request mode matches
 * the image's and the browser reuses the preloaded response.
 */
function crossOriginAttribute(props: Record<string, unknown>): string | undefined {
  for (const name of ['crossOrigin', 'crossorigin']) {
    const value = props[name];
    if (value === true) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

/**
 * The `<link rel="preload" as="image">` for a preloaded image (`preload` or
 * `priority`), or `undefined`. As in Next.js, `href` is omitted when the image
 * has a `srcset`, so browsers pick the same candidate as the `<img>`.
 */
export function getImagePreloadLink(
  props: ImgProps | Record<string, unknown>,
  meta: ImageMeta,
): ImagePreloadLink | undefined {
  if (!meta.preload) {
    return undefined;
  }
  const record = props as Record<string, unknown>;
  const imagesrcset = stringAttribute(record, 'srcSet', 'srcset');
  const imagesizes = stringAttribute(record, 'sizes');
  const href = imagesrcset ? undefined : stringAttribute(record, 'src');
  if (!imagesrcset && !href) {
    return undefined;
  }
  const link: ImagePreloadLink = {
    key: imagesrcset ? `${imagesrcset}\n${imagesizes ?? ''}` : (href as string),
  };
  if (href) {
    link.href = href;
  }
  if (imagesrcset) {
    link.imagesrcset = imagesrcset;
  }
  if (imagesizes) {
    link.imagesizes = imagesizes;
  }
  const crossorigin = crossOriginAttribute(record);
  if (crossorigin !== undefined) {
    link.crossorigin = crossorigin;
  }
  const referrerpolicy = stringAttribute(record, 'referrerPolicy', 'referrerpolicy');
  if (referrerpolicy) {
    link.referrerpolicy = referrerpolicy;
  }
  const fetchpriority = stringAttribute(record, 'fetchPriority', 'fetchpriority');
  if (fetchpriority) {
    link.fetchpriority = fetchpriority;
  }
  return link;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

const PRELOAD_ATTRIBUTES = [
  'href',
  'imagesrcset',
  'imagesizes',
  'crossorigin',
  'referrerpolicy',
  'fetchpriority',
] as const;

/** `<link rel="preload" as="image" ...>` tags for `links`, attribute values HTML-escaped. */
export function renderImagePreloadLinks(links: Iterable<ImagePreloadLink>): string {
  let html = '';
  for (const link of links) {
    html += '<link rel="preload" as="image"';
    for (const name of PRELOAD_ATTRIBUTES) {
      const value = link[name];
      if (value !== undefined) {
        html += ` ${name}="${escapeAttribute(value)}"`;
      }
    }
    html += '>';
  }
  return html;
}

/** Collects the preload links of one render, once per key. */
export type ImagePreloadCollector = {
  add(link: ImagePreloadLink): void;
  links(): Array<ImagePreloadLink>;
  render(): string;
};

/** A preload collector for one server render. */
export function createImagePreloadCollector(): ImagePreloadCollector {
  const byKey = new Map<string, ImagePreloadLink>();
  return {
    add(link) {
      if (!byKey.has(link.key)) {
        byKey.set(link.key, link);
      }
    },
    links() {
      return [...byKey.values()];
    },
    render() {
      return renderImagePreloadLinks(byKey.values());
    },
  };
}
