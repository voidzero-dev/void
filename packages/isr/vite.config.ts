import { defineConfig } from 'vite-plus';

const WORKERS_TYPES_REFERENCE = '/// <reference types="@cloudflare/workers-types" />';

type BundleOutput =
  | { fileName: string; type: 'asset'; source?: string | Uint8Array }
  | { fileName: string; type: 'chunk'; code?: string };

function injectWorkersTypesReferencePlugin() {
  return {
    name: 'void-isr:inject-workers-types-reference',
    generateBundle(_options: unknown, bundle: Record<string, BundleOutput>) {
      const output = Object.values(bundle).find((item) => item.fileName === 'runtime.d.mts');
      if (!output) {
        return;
      }
      if (output.type === 'asset') {
        const source = String(output.source ?? '');
        output.source = source.startsWith(WORKERS_TYPES_REFERENCE)
          ? source
          : `${WORKERS_TYPES_REFERENCE}\n${source}`;
        return;
      }
      const code = String(output.code ?? '');
      output.code = code.startsWith(WORKERS_TYPES_REFERENCE)
        ? code
        : `${WORKERS_TYPES_REFERENCE}\n${code}`;
    },
  };
}

export default defineConfig({
  pack: {
    entry: ['src/index.ts', 'src/core.ts', 'src/runtime.ts'],
    format: 'esm',
    dts: true,
    clean: true,
    plugins: [injectWorkersTypesReferencePlugin()],
  },
});
