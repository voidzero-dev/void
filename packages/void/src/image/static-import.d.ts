// Types for static image imports: `import hero from './hero.png?image'`.
// Shipped as `dist/image/static-import.d.ts` (with the import pointing at
// `./index.mjs`) and referenced from the `void/env` and `void/image` types.

declare module '*?image' {
  const image: import('./types.ts').StaticImageData;
  export default image;
}
