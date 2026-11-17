import { fontFromUrl } from 'takumi-js/helpers';
import { Renderer, type FontLoader } from 'takumi-js/wasm/no-init';
import { cachedFontData } from './font-data-cache.ts';

const FONT_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const FONT_CACHE_MAX_ENTRIES = 128;

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
      renderer.trimFonts();
      idle = renderer;
    }
  }
}

class ImageRenderer extends Renderer {
  private fontBytes = 0;
  private fontEntries = 0;
  private fontKeys: Array<string | ArrayBuffer | Uint8Array> = [];

  constructor() {
    super({ fontCacheMaxBytes: FONT_CACHE_MAX_BYTES });
  }

  override async prepare(...[source, options]: Parameters<Renderer['prepare']>) {
    const fonts = ((await options?.fonts) ?? []).map(normalizeFont);
    const keys = fonts.map((font) =>
      font instanceof ArrayBuffer || font instanceof Uint8Array ? font : font.key,
    );
    // Takumi selects entire families, not individual registrations. Keeping an
    // old face of a current family would let it participate in this image.
    if (
      keys.length !== this.fontKeys.length ||
      keys.some((key, index) => key !== this.fontKeys[index])
    ) {
      this.clearFonts();
    }
    this.fontKeys = keys;
    // Takumi's budget evicts whole families, except the family just loaded.
    // Same-family subsets can therefore grow indefinitely; an image larger
    // than the budget can also lose fonts before it renders. Pin this image's
    // fonts and trim BETWEEN renders instead. The lease prevents concurrent
    // images from clearing fonts another image is still preparing or drawing.
    const loaded = await Promise.allSettled(
      fonts.map(async (font) => this.registerFont(this.countedFont(font))),
    );
    // All loads must settle before a failed render returns its renderer to the
    // pool, including when several fallback downloads fail together.
    for (const result of loaded) {
      if (result.status === 'rejected') {
        throw result.reason;
      }
    }
    return super.prepare(source, { ...options, fonts });
  }

  private countedFont(font: NormalizedFont): FontLoader {
    // Void supplies URL loaders or descriptors with stable keys (including
    // Inter), so wrapping data() preserves Takumi's registration identity.
    if (font instanceof ArrayBuffer || font instanceof Uint8Array) {
      this.countBytes(font);
      return font;
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

  override clearFonts() {
    super.clearFonts();
    this.fontBytes = 0;
    this.fontEntries = 0;
    this.fontKeys = [];
  }

  trimFonts() {
    if (this.fontBytes >= FONT_CACHE_MAX_BYTES || this.fontEntries >= FONT_CACHE_MAX_ENTRIES) {
      this.clearFonts();
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
