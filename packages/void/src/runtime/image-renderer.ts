import { fontFromUrl } from 'takumi-js/helpers';
import { Renderer, type FontLoader } from 'takumi-js/wasm/no-init';

const FONT_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const FONT_CACHE_MAX_ENTRIES = 128;

let initialized: Promise<void> | undefined;
let idle: ImageRenderer | undefined;

function initialize(): Promise<void> {
  return (initialized ??= import('takumi-js/wasm')
    .then(async ({ default: source, init }) => {
      // Node's auto entry has initialized the bindings already; workerd exports
      // a compiled module. Void's server build supplies a lazy asset loader.
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
      renderer.trimFonts();
      idle = renderer;
    }
  }
}

class ImageRenderer extends Renderer {
  private fontBytes = 0;
  private fontEntries = 0;

  constructor() {
    super({ fontCacheMaxBytes: FONT_CACHE_MAX_BYTES });
  }

  override async prepare(...[source, options]: Parameters<Renderer['prepare']>) {
    // Takumi's budget evicts whole families, except the family just loaded.
    // Same-family subsets can therefore grow indefinitely; an image larger
    // than the budget can also lose fonts before it renders. Pin this image's
    // fonts and trim BETWEEN renders instead. The lease prevents concurrent
    // images from clearing fonts another image is still preparing or drawing.
    const loaded = await Promise.allSettled(
      ((await options?.fonts) ?? []).map(async (font) => this.registerFont(this.countedFont(font))),
    );
    // All loads must settle before a failed render returns its renderer to the
    // pool, including when several fallback downloads fail together.
    for (const result of loaded) {
      if (result.status === 'rejected') {
        throw result.reason;
      }
    }
    return super.prepare(source, options);
  }

  private countedFont(input: FontLoader): FontLoader {
    const font = typeof input === 'string' ? fontFromUrl(input) : input;
    // Void supplies URL loaders or descriptors with stable keys (including
    // Inter), so wrapping data() preserves Takumi's registration identity.
    if (font instanceof ArrayBuffer || font instanceof Uint8Array) {
      this.countBytes(font);
      return font;
    }
    if (!('key' in font) || typeof font.key !== 'string') {
      throw new TypeError('void/image: font loaders must have a stable key.');
    }
    return {
      ...font,
      key: font.key,
      data: async () => {
        const data = await (typeof font.data === 'function' ? font.data() : font.data);
        this.countBytes(data);
        return data;
      },
    };
  }

  private countBytes(data: ArrayBuffer | Uint8Array) {
    this.fontBytes += decodedFontBytes(data);
    this.fontEntries++;
  }

  trimFonts() {
    if (this.fontBytes >= FONT_CACHE_MAX_BYTES || this.fontEntries >= FONT_CACHE_MAX_ENTRIES) {
      this.clearFonts();
      this.fontBytes = 0;
      this.fontEntries = 0;
    }
  }
}

/** WOFF/WOFF2 retain decoded SFNT data, not just the smaller downloaded file. */
function decodedFontBytes(data: ArrayBuffer | Uint8Array): number {
  const view =
    data instanceof ArrayBuffer
      ? new DataView(data)
      : new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.byteLength >= 20) {
    const signature = view.getUint32(0);
    if (signature === 0x774f4646 || signature === 0x774f4632) {
      return Math.max(view.byteLength, view.getUint32(16));
    }
  }
  return view.byteLength;
}
