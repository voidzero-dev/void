/** Shape of a single page's head metadata. */
export type HeadDescriptor = {
  title?: string;
  meta?: Array<{ name?: string; property?: string; content?: string; charset?: string }>;
  link?: Array<{ rel: string; href: string; [key: string]: string | undefined }>;
  script?: Array<{ src?: string; innerHTML?: string; [key: string]: string | undefined }>;
  htmlAttrs?: Record<string, string>;
  bodyAttrs?: Record<string, string>;
};

/** Project-level head config with template support. */
export type HeadConfig = HeadDescriptor & {
  /** Title template — `%s` is replaced with the page title. */
  titleTemplate?: string;
};

/**
 * Merge head descriptors with precedence: page > middleware > config.
 *
 * - `title`: page wins; `titleTemplate` from middleware, else config, wraps it (`%s` replaced)
 * - `meta`: page overrides entries with same `name`/`property`; others appended
 * - `link`/`script`: concatenated (config first, then middleware, then page)
 * - `htmlAttrs`/`bodyAttrs`: shallow merge, page wins conflicts
 */
export function resolveHead(
  configHead: HeadConfig | undefined,
  middlewareHead: HeadConfig | undefined,
  pageHead: HeadDescriptor | undefined,
): HeadDescriptor | undefined {
  if (!configHead && !middlewareHead && !pageHead) {
    return undefined;
  }

  const layers = [configHead, middlewareHead, pageHead];
  const result: HeadDescriptor = {};

  const title = pageHead?.title ?? middlewareHead?.title ?? configHead?.title;
  if (title !== undefined) {
    const template = middlewareHead?.titleTemplate ?? configHead?.titleTemplate;
    result.title = template ? template.replace('%s', title) : title;
  }

  // Meta entries dedupe by charset/property/name; later layers win but keep
  // the first position (Map.set on an existing key preserves insertion order).
  const metaMap = new Map<string, NonNullable<HeadDescriptor['meta']>[number]>();
  for (const layer of layers) {
    if (!layer?.meta) {
      continue;
    }
    for (const entry of layer.meta) {
      const key = entry.charset
        ? 'charset'
        : entry.property
          ? `property:${entry.property}`
          : `name:${entry.name ?? ''}`;
      metaMap.set(key, entry);
    }
  }
  if (metaMap.size > 0) {
    result.meta = [...metaMap.values()];
  }

  const links = layers.flatMap((layer) => layer?.link ?? []);
  if (links.length > 0) {
    result.link = links;
  }

  const scripts = layers.flatMap((layer) => layer?.script ?? []);
  if (scripts.length > 0) {
    result.script = scripts;
  }

  const htmlAttrs = mergeAttrs(layers, 'htmlAttrs');
  if (htmlAttrs) {
    result.htmlAttrs = htmlAttrs;
  }

  const bodyAttrs = mergeAttrs(layers, 'bodyAttrs');
  if (bodyAttrs) {
    result.bodyAttrs = bodyAttrs;
  }

  if (
    result.title === undefined &&
    !result.meta &&
    !result.link &&
    !result.script &&
    !result.htmlAttrs &&
    !result.bodyAttrs
  ) {
    return undefined;
  }

  return result;
}

/** Shallow-merge an attribute map across layers; undefined when no layer sets it. */
function mergeAttrs(
  layers: ReadonlyArray<HeadDescriptor | undefined>,
  key: 'htmlAttrs' | 'bodyAttrs',
): Record<string, string> | undefined {
  let merged: Record<string, string> | undefined;
  for (const layer of layers) {
    const attrs = layer?.[key];
    if (attrs) {
      merged = Object.assign(merged ?? {}, attrs);
    }
  }
  return merged;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function serializeAttrs(attrs: Record<string, string | undefined>): string {
  return Object.entries(attrs)
    .filter(([, value]) => value != null)
    .map(([key, value]) => `${key}="${escapeHtml(value!)}"`)
    .join(' ');
}

/** Serialize a HeadDescriptor to HTML tags for injection into `<head>`. */
export function renderHeadToString(head: HeadDescriptor): string {
  const parts: Array<string> = [];

  if (head.title !== undefined) {
    parts.push(`<title>${escapeHtml(head.title)}</title>`);
  }

  if (head.meta) {
    for (const entry of head.meta) {
      const attrs: Array<string> = [];
      if (entry.charset) {
        attrs.push(`charset="${escapeHtml(entry.charset)}"`);
      }
      if (entry.name) {
        attrs.push(`name="${escapeHtml(entry.name)}"`);
      }
      if (entry.property) {
        attrs.push(`property="${escapeHtml(entry.property)}"`);
      }
      if (entry.content !== undefined) {
        attrs.push(`content="${escapeHtml(entry.content)}"`);
      }
      parts.push(`<meta ${attrs.join(' ')}>`);
    }
  }

  if (head.link) {
    for (const entry of head.link) {
      parts.push(`<link ${serializeAttrs(entry)}>`);
    }
  }

  if (head.script) {
    for (const entry of head.script) {
      const { innerHTML, ...rest } = entry;
      const attrs = serializeAttrs(rest);
      if (innerHTML) {
        parts.push(`<script${attrs ? ' ' + attrs : ''}>${innerHTML}</script>`);
      } else if (attrs) {
        parts.push(`<script ${attrs}></script>`);
      }
    }
  }

  return parts.join('\n');
}

/** Serialize htmlAttrs to an attribute string (includes leading space). */
export function renderHtmlAttrs(head: HeadDescriptor): string {
  const attrs = head.htmlAttrs ? serializeAttrs(head.htmlAttrs) : '';
  return attrs ? ' ' + attrs : '';
}

/** Serialize bodyAttrs to an attribute string (includes leading space). */
export function renderBodyAttrs(head: HeadDescriptor): string {
  const attrs = head.bodyAttrs ? serializeAttrs(head.bodyAttrs) : '';
  return attrs ? ' ' + attrs : '';
}
