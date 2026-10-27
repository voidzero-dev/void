import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite-plus';

const WORKERS_TYPES_REFERENCE = '/// <reference types="@cloudflare/workers-types" />';

type BundleOutput =
  | {
      fileName: string;
      type: 'asset';
      source?: string | Uint8Array;
    }
  | {
      fileName: string;
      type: 'chunk';
      code?: string;
    };

function injectWorkersTypesReferencePlugin() {
  return {
    name: 'void:inject-workers-types-reference',
    // tsdown's declaration emit currently drops source-level triple-slash references.
    // Our public handler types use Cloudflare global types (D1Database, KVNamespace, etc.),
    // so we inject the reference into the emitted .d.mts to keep consumer DX zero-config.
    generateBundle(_options: unknown, bundle: Record<string, BundleOutput>) {
      for (const output of Object.values(bundle)) {
        // Patch declaration entrypoints whose source uses Cloudflare globals.
        const targets = new Set([
          'runtime/handler.d.mts',
          'runtime/env-public.d.mts',
          'runtime/sandbox.d.mts',
          'runtime/sandbox-container.d.mts',
          'runtime/live.d.mts',
          'runtime/live-server.d.mts',
          'runtime/email.d.mts',
          'runtime/email/testing.d.mts',
        ]);
        if (!targets.has(output.fileName)) {
          continue;
        }

        if (output.type === 'asset') {
          const source = String(output.source ?? '');
          if (!source.startsWith(WORKERS_TYPES_REFERENCE)) {
            output.source = `${WORKERS_TYPES_REFERENCE}\n${source}`;
          }
          continue;
        }

        if (output.type === 'chunk') {
          const code = String(output.code ?? '');
          if (!code.startsWith(WORKERS_TYPES_REFERENCE)) {
            output.code = `${WORKERS_TYPES_REFERENCE}\n${code}`;
          }
        }
      }
    },
  };
}

export default defineConfig({
  pack: {
    entry: [
      'src/index.ts',
      'src/config-entry.ts',
      'src/deploy.ts',
      'src/prerender-render.ts',
      'src/database-provider.ts',
      'src/edge.ts',
      'src/runtime/handler.ts',
      'src/runtime/response.ts',
      'src/runtime/routing.ts',
      'src/runtime/validator.ts',
      'src/routes-stub.ts',
      'src/runtime/client.ts',
      'src/runtime/client-react.ts',
      'src/runtime/client-vue.ts',
      'src/runtime/client-svelte.ts',
      'src/runtime/client-solid.ts',
      'src/runtime/fetch.ts',
      'src/runtime/fetch-server.ts',
      'src/runtime/fetch-stream.ts',
      'src/runtime/route-url.ts',
      'src/runtime/sse.ts',
      'src/runtime/sse-client.ts',
      'src/runtime/live.ts',
      'src/runtime/live-client.ts',
      'src/runtime/auth.ts',
      'src/runtime/auth-client.ts',
      'src/runtime/ws.ts',
      'src/runtime/auth-client-react.ts',
      'src/runtime/auth-client-vue.ts',
      'src/runtime/auth-client-svelte.ts',
      'src/runtime/auth-client-solid.ts',
      'src/runtime/better-auth.ts',
      'src/runtime/better-auth-pg.ts',
      'src/runtime/better-auth-mysql.ts',
      'src/runtime/env.ts',
      'src/runtime/env-public.ts',
      'src/runtime/env-public-client.ts',
      'src/runtime/db.ts',
      'src/runtime/db-pg.ts',
      'src/runtime/db-mysql.ts',
      'src/runtime/durable.ts',
      'src/runtime/seed.ts',
      'src/runtime/drizzle-zod.ts',
      'src/runtime/drizzle-valibot.ts',
      'src/runtime/drizzle-arktype.ts',
      'src/runtime/schema-d1.ts',
      'src/runtime/schema-pg.ts',
      'src/runtime/schema-mysql.ts',
      'src/runtime/kv.ts',
      'src/runtime/queues.ts',
      'src/runtime/storage.ts',
      'src/runtime/isr.ts',
      'src/runtime/log.ts',
      'src/runtime/ai.ts',
      'src/runtime/limits.ts',
      'src/runtime/email.ts',
      'src/runtime/email-protocol.ts',
      'src/runtime/email/testing.ts',
      'src/runtime/sandbox.ts',
      'src/runtime/sandbox-container.ts',
      'src/runtime/remote/index.ts',
      'src/runtime/remote/binding-handler.ts',
      'src/runtime/migration-handler.ts',
      'src/runtime/migration-handler-pg.ts',
      'src/runtime/migration-handler-mysql.ts',
      'src/runtime/ws-server.ts',
      'src/runtime/live-server.ts',
      'src/sveltekit.ts',
      'src/nitro.ts',
      'src/pages/index.ts',
      'src/pages/protocol.ts',
      'src/pages/head.ts',
      'src/pages/prefetch.ts',
      'src/pages/client.ts',
      'src/pages/serialize.ts',
      'src/pages/islands-plugin.ts',
      'src/cli/cli.ts',
      // Stable entry that deploy spawns as an isolated child.
      'src/cli/env-schema-probe.ts',
      // Private typed Cloudflare transport, spawned by deployment orchestrators.
      'src/cli/cloudflare-operation-process.ts',
    ],
    format: 'esm',
    dts: true,
    clean: true,
    plugins: [
      {
        name: 'void:raw-assets',
        load: {
          filter: { id: /\.(?:css|html)\?raw$/ },
          handler(id) {
            const file = id.slice(0, -'?raw'.length);
            this.addWatchFile(file);
            return `export default ${JSON.stringify(readFileSync(file, 'utf8'))};`;
          },
        },
      },
      injectWorkersTypesReferencePlugin(),
    ],
    deps: {
      resolveDepSubpath: true,
      neverBundle: [
        // This module is augmented by users, keep it as external so tsdown does not rewrite it.
        'void/routes',
        'vite',
        '@cloudflare/vite-plugin',
        'better-sqlite3',
        'cloudflare:workers',
        'cloudflare:email',
        '@void/vue',
        '@void/react',
        '@void/svelte',
        '@void/solid',
        '@napi-rs/keyring',
        '@cloudflare/sandbox',
        '@cloudflare/containers',
      ],
      onlyBundle: [
        'fdir',
        'picomatch',
        'tinyglobby',
        'estree-walker',
        'magic-string',
        '@jridgewell/sourcemap-codec',
        '@voidzero-dev/vite-plus-prompts',
        '@clack/core',
        'fast-string-truncated-width',
        'fast-string-width',
        'fast-wrap-ansi',
        'sisteransi',
        'picocolors',
        'ofetch',
        'pathslash',
        // Dependency-free; bundled so the CLI interactivity gate (`isWranglerNonInteractiveOrCI`)
        // adds no runtime dependency.
        'ci-info',
      ],
    },
  },
});
