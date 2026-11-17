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
          'runtime/handler/index.d.mts',
          'runtime/env/public.d.mts',
          'runtime/sandbox/index.d.mts',
          'runtime/sandbox/container.d.mts',
          'runtime/live/index.d.mts',
          'runtime/live/server.d.mts',
          'runtime/email/index.d.mts',
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
      'src/runtime/handler/index.ts',
      'src/runtime/handler/response.ts',
      'src/runtime/routing/index.ts',
      'src/runtime/handler/validator.ts',
      'src/routes-stub.ts',
      'src/runtime/client/index.ts',
      'src/runtime/client/react.ts',
      'src/runtime/client/vue.ts',
      'src/runtime/client/svelte.ts',
      'src/runtime/client/solid.ts',
      'src/runtime/client/fetch.ts',
      'src/runtime/client/fetch-server.ts',
      'src/runtime/client/fetch-stream.ts',
      'src/runtime/routing/route-url.ts',
      'src/runtime/sse/index.ts',
      'src/runtime/sse/client.ts',
      'src/runtime/live/index.ts',
      'src/runtime/live/client.ts',
      'src/runtime/auth/index.ts',
      'src/runtime/auth/client.ts',
      'src/runtime/ws/index.ts',
      'src/runtime/ws/room.ts',
      'src/runtime/auth/client-react.ts',
      'src/runtime/auth/client-vue.ts',
      'src/runtime/auth/client-svelte.ts',
      'src/runtime/auth/client-solid.ts',
      'src/runtime/auth/better-auth-d1.ts',
      'src/runtime/auth/better-auth-postgres.ts',
      'src/runtime/auth/better-auth-mysql.ts',
      'src/runtime/env/runtime.ts',
      'src/runtime/env/public.ts',
      'src/runtime/env/public-client.ts',
      'src/runtime/db/index.ts',
      'src/runtime/db/postgres.ts',
      'src/runtime/db/mysql.ts',
      'src/runtime/durable/index.ts',
      'src/runtime/db/seed.ts',
      'src/runtime/db/validators/drizzle-zod.ts',
      'src/runtime/db/validators/drizzle-valibot.ts',
      'src/runtime/db/validators/drizzle-arktype.ts',
      'src/runtime/db/schema/d1.ts',
      'src/runtime/db/schema/postgres.ts',
      'src/runtime/db/schema/mysql.ts',
      'src/runtime/kv/index.ts',
      'src/runtime/queues/index.ts',
      'src/runtime/storage/index.ts',
      'src/runtime/isr/index.ts',
      'src/runtime/log/index.ts',
      'src/runtime/ai/index.ts',
      'src/runtime/limits/index.ts',
      'src/runtime/email/index.ts',
      'src/runtime/email/protocol.ts',
      'src/runtime/email/testing.ts',
      'src/runtime/sandbox/index.ts',
      'src/runtime/sandbox/container.ts',
      'src/runtime/remote/index.ts',
      'src/runtime/remote/binding-handler.ts',
      'src/runtime/db/migrations/d1-handler.ts',
      'src/runtime/db/migrations/postgres-handler.ts',
      'src/runtime/db/migrations/mysql-handler.ts',
      'src/runtime/ws/server.ts',
      'src/runtime/live/server.ts',
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
          filter: { id: /\.(?:css|html|js)\?raw$/ },
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
