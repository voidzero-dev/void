import type {} from 'react';
import type { ImageStyle } from './generate/image-input.ts';

declare module 'react' {
  interface DOMAttributes<T> {
    /** Tailwind classes for generated images. */
    tw?: string;
  }

  interface CSSProperties extends Record<`--${string}`, string | number | undefined> {
    /** Fits text to its available space in generated images. */
    textFit?: ImageStyle['textFit'];
  }
}

export {};
