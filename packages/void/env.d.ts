/**
 * Constants the build folds into both the client and server bundles, such as
 * the Pages build id. Vite replaces each key at build time.
 */
interface ImportMeta {
  readonly env: Record<string, unknown>;
}
