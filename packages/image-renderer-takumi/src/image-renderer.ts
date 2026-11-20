import { fontFromUrl } from 'takumi-js/helpers';
import { Renderer, type FontLoader } from 'takumi-js/wasm/no-init';
import { cachedFontData } from './font-data-cache.ts';

const CACHE_MAX_BYTES = 8 * 1024 * 1024;

let initialized: Promise<void> | undefined;
let idle: ImageRenderer | undefined;

type FontBytes = ArrayBuffer | Uint8Array;
type NormalizedFont = FontBytes | (Exclude<FontLoader, string | FontBytes> & { key: string });

function normalizeFont(input: FontLoader): NormalizedFont {
  let font = input;
  if (typeof font === 'string') {
    const loader = fontFromUrl(font);
    font = {
      ...loader,
      data: () => cachedFontData(`url:${loader.key}`, loader.data),
    };
  }
  if (font instanceof ArrayBuffer || font instanceof Uint8Array) {
    return font;
  }
  if (!('key' in font) || typeof font.key !== 'string') {
    throw new TypeError('@void/image: font loaders must have a stable key.');
  }
  return { ...font, key: font.key };
}

function initialize(): Promise<void> {
  return (initialized ??= import('takumi-js/wasm')
    .then(async ({ default: source, init }) => {
      // Node and Bun's auto entry initializes the bindings; workerd exports
      // a compiled module. Always use WASM, never Takumi's native backend.
      if (typeof source === 'function') {
        await source();
      } else {
        await init({ module_or_path: await source });
      }
    })
    .catch((error) => {
      initialized = undefined;
      throw error;
    }));
}

/** One warm renderer; concurrent images own temporary renderers, freed on return. */
export async function withImageRenderer<T>(use: (renderer: Renderer) => Promise<T>): Promise<T> {
  await initialize();
  const renderer = idle ?? new ImageRenderer();
  idle = undefined;
  try {
    return await use(renderer);
  } finally {
    if (idle) {
      renderer.free();
    } else {
      idle = renderer;
    }
  }
}

class ImageRenderer extends Renderer {
  constructor() {
    super({ cache: { maxBytes: CACHE_MAX_BYTES } });
  }

  override async prepare(...[source, options]: Parameters<Renderer['prepare']>) {
    const pending: Array<Promise<FontBytes>> = [];
    const fonts = ((await options?.fonts) ?? []).map((input) => {
      const font = normalizeFont(input);
      if (font instanceof ArrayBuffer || font instanceof Uint8Array) {
        return font;
      }
      return {
        ...font,
        data: () => {
          const loading = Promise.resolve().then(() =>
            typeof font.data === 'function' ? font.data() : font.data,
          );
          pending.push(loading);
          return Promise.resolve().then(async () => {
            // Let Takumi start the other loaders before taking the snapshot.
            // Settle their data before any reaches native decoding: either a
            // download or decode failure must not return/free this renderer
            // while another loader can still write into it.
            await Promise.allSettled(pending);
            return loading;
          });
        },
      };
    });
    // Per-render fonts are isolated and evictable in Takumi 2.21. registerFont
    // would instead pin them and make them available to unrelated requests.
    return super.prepare(source, { ...options, fonts });
  }
}
