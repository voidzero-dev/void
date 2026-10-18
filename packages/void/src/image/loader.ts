/**
 * Built-in image loaders and `findClosestQuality`, ported from Next.js 16
 * (`image-loader.js`, `find-closest-quality.js`). Development checks are gated
 * by `config.dev` instead of `NODE_ENV`; Next.js's deployment-id (`dpl`) query
 * is not used.
 */
import type { ClientImageConfig } from './config.ts';
import { hasLocalMatch, hasRemoteMatch } from './patterns.ts';
import type { ImageLoaderPropsWithConfig, ImageLoaderWithConfig } from './types.ts';

/** Linked from error messages in place of the Next.js documentation. */
export const IMAGE_DOCS_URL = 'https://void.cloud/guide/images';

/**
 * A loader built into Void. It receives `config`; `getImgProps` passes any
 * other loader only `{ src, width, quality }`.
 */
export type BuiltinImageLoader = ImageLoaderWithConfig & { readonly __void_img_default: true };

/**
 * The configured quality closest to `quality` (default 75). Ties keep the
 * lower value. Without `qualities` the requested quality is returned.
 */
export function findClosestQuality(
  quality: number | undefined,
  config: { qualities?: ReadonlyArray<number> | undefined } | undefined,
): number {
  const q = quality || 75;
  if (!config?.qualities?.length) {
    return q;
  }
  return config.qualities.reduce(
    (prev, cur) => (Math.abs(cur - q) < Math.abs(prev - q) ? cur : prev),
    config.qualities[0],
  );
}

function isDefaultLocalPatterns(config: Readonly<ClientImageConfig>): boolean {
  const patterns = config.localPatterns;
  return patterns?.length === 1 && patterns[0].pathname === '**' && patterns[0].search === '';
}

function defaultLoaderImpl({ config, src, width, quality }: ImageLoaderPropsWithConfig): string {
  if (config.dev) {
    const missingValues: Array<string> = [];
    // these should always be provided but make sure they are
    if (!src) {
      missingValues.push('src');
    }
    if (!width) {
      missingValues.push('width');
    }
    if (missingValues.length > 0) {
      throw new Error(
        `Void Image Optimization requires ${missingValues.join(', ')} to be provided. Make sure you pass them as props to the \`Image\` component. Received: ${JSON.stringify(
          { src, width, quality },
        )}`,
      );
    }
  }

  if (src.startsWith('/') && src.includes('?') && isDefaultLocalPatterns(config)) {
    throw new Error(
      `Image with src "${src}" is using a query string which is not configured in images.localPatterns.` +
        `\nRead more: ${IMAGE_DOCS_URL}`,
    );
  }

  if (config.dev) {
    if (src.startsWith('//')) {
      throw new Error(
        `Failed to parse src "${src}" on \`Image\`, protocol-relative URL (//) must be changed to an absolute URL (http:// or https://)`,
      );
    }
    if (src.startsWith('/') && config.localPatterns) {
      if (!hasLocalMatch(config.localPatterns, src)) {
        throw new Error(
          `Invalid src prop (${src}) on \`Image\` does not match \`images.localPatterns\` configured in your \`void.config.ts\`\n` +
            `See more info: ${IMAGE_DOCS_URL}`,
        );
      }
    }
    if (!src.startsWith('/') && (config.domains || config.remotePatterns)) {
      let parsedSrc: URL;
      try {
        parsedSrc = new URL(src);
      } catch (err) {
        console.error(err);
        throw new Error(
          `Failed to parse src "${src}" on \`Image\`, if using relative image it must start with a leading slash "/" or be an absolute URL (http:// or https://)`,
        );
      }
      if (!hasRemoteMatch(config.domains ?? [], config.remotePatterns ?? [], parsedSrc)) {
        throw new Error(
          `Invalid src prop (${src}) on \`Image\`, hostname "${parsedSrc.hostname}" is not configured under images in your \`void.config.ts\`\n` +
            `See more info: ${IMAGE_DOCS_URL}`,
        );
      }
    }
  }

  const q = findClosestQuality(quality, config);
  return `${config.path}?url=${encodeURIComponent(src)}&w=${width}&q=${q}`;
}

/**
 * The default loader: `<path>?url=<src>&w=<width>&q=<quality>` for the
 * `/_void/image` endpoint.
 */
export const defaultLoader: BuiltinImageLoader = Object.assign(defaultLoaderImpl, {
  __void_img_default: true as const,
});

/**
 * `src` with whitespace percent-encoded: a `srcset` candidate URL ends at the
 * first whitespace. Existing escapes, `/`, `:`, `?` and `,` are kept.
 */
function encodeWhitespace(src: string): string {
  return src.replace(/\s/g, encodeURIComponent);
}

function cloudflareLoaderImpl({ config, src, width, quality }: ImageLoaderPropsWithConfig): string {
  // Zone transformations do not exist on the dev server.
  if (config.dev) {
    return encodeWhitespace(src);
  }
  const params = `width=${width},quality=${findClosestQuality(quality, config)},format=auto`;
  const source = encodeWhitespace(src.startsWith('/') ? src.slice(1) : src);
  return `${config.path.replace(/\/+$/, '')}/${params}/${source}`;
}

/**
 * `images.loader: 'cloudflare'`: Cloudflare zone transformation URLs,
 * `<path>/width=<w>,quality=<q>,format=auto/<src>` (`path` defaults to
 * `/cdn-cgi/image`). Returns `src` itself in development. Whitespace in
 * `src` is percent-encoded so `srcset` candidates stay valid.
 */
export const cloudflareLoader: BuiltinImageLoader = Object.assign(cloudflareLoaderImpl, {
  __void_img_default: true as const,
});
