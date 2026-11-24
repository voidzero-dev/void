import MagicString from 'magic-string';
import { parseSync } from 'vite';
import type { Plugin, ResolvedConfig } from 'vite';
import {
  extractEnvBindings,
  isVoidEnvScriptCandidate,
  walkEnvReads,
} from './plugin-env-client-guard.ts';
import type { ImportBindings } from './plugin-env-client-guard.ts';
import { isIdentifier, isLiteral } from './shared/ast.ts';
import type { AstMemberExpression, AstProgram } from './shared/ast.ts';
import { isClientEnvKey } from './shared/env.ts';

type FoldHit = {
  start: number;
  end: number;
  property: string;
};

/**
 * Walk the AST and collect every static `env.FOO` / `env["FOO"]` (or
 * `<ns>.env.FOO`) read. Dynamic keys (`env[variable]`) are intentionally
 * ignored — the Proxy still serves them at runtime, and we can't prove
 * they'd be folded the same way Vite folds `import.meta.env.FOO`.
 */
function findFoldHits(program: AstProgram, bindings: ImportBindings): Array<FoldHit> {
  const hits: Array<FoldHit> = [];
  walkEnvReads(program, bindings, (node) => pushHit(node, hits));
  return hits;
}

function pushHit(node: AstMemberExpression, hits: Array<FoldHit>): void {
  // Static dot access: `env.FOO`
  if (!node.computed && isIdentifier(node.property)) {
    hits.push({ start: node.start!, end: node.end!, property: node.property.name });
    return;
  }
  // Static bracket access with a string literal: `env["FOO"]`
  if (node.computed && isLiteral(node.property) && typeof node.property.value === 'string') {
    hits.push({ start: node.start!, end: node.end!, property: node.property.value });
    return;
  }
  // Everything else (identifiers, template literals, etc.) falls through
  // to the runtime Proxy — not our problem.
}

/**
 * Build-time constant folding for client-only `env.FOO` reads.
 *
 * Purpose: match what Vite already does for `import.meta.env.FOO` so that
 * branches like `if (env.VITE_FLAG === "on") { ... }` get dead-code
 * eliminated in production client bundles. The runtime `env` Proxy on the
 * client already resolves keys via `import.meta.env`, so *semantics* don't
 * change — we just move the lookup from runtime to build time, which
 * unlocks DCE and bundler minification of guarded blocks.
 *
 * Safety properties:
 *   • Runs only when `this.environment.name === 'client'`. Server / SSR /
 *     worker builds keep the full runtime Proxy (secrets, runtime-injected
 *     vars, HMR remain live).
 *   • Only folds keys that match Void's fixed `VITE_` client prefix. A
 *     server-only key is never folded (and the env-client-guard plugin
 *     would have errored out earlier anyway).
 *   • Only folds static member access: `env.FOO` and `env["FOO"]`.
 *     Dynamic access, destructuring, and reassignment fall through to the
 *     runtime Proxy.
 *   • Only folds keys with a known build-time value (build shell, or a schema
 *     `.default(...)` that the env-schema plugin adds). Unknown keys are left as-is
 *     and the Proxy handles them at runtime — no "undefined" shoved in.
 *   • Build-only (`apply: 'build'`). Dev runs through the Proxy so local
 *     `.env` edits take effect without a full rebuild.
 */
export function envClientFoldPlugin(): Plugin {
  let loadedEnv: Record<string, string> = {};

  return {
    name: 'void:env-client-fold',
    apply: 'build',
    // Run after SFC compilers (Svelte/Vue/Astro) so the `.svelte` / `.vue` /
    // `.astro` id arrives as compiled JS we can parse and fold.
    enforce: 'post',
    configResolved(config: ResolvedConfig) {
      // Vite runs configResolved hooks concurrently. Keep the shared env object
      // so transforms observe the schema plugin's completed removal of local
      // values and insertion of defaults, rather than an early snapshot.
      loadedEnv = (config.env ?? {}) as Record<string, string>;
    },
    async transform(code, id) {
      if (this.environment?.name !== 'client') {
        return;
      }
      if (!isVoidEnvScriptCandidate(id, code)) {
        return;
      }

      let parsed: ReturnType<typeof parseSync>;
      try {
        parsed = parseSync(id, code);
      } catch {
        return;
      }

      const program = parsed.program as unknown as AstProgram;
      const bindings = extractEnvBindings(program);
      if (!bindings) {
        return;
      }

      const hits = findFoldHits(program, bindings);
      if (hits.length === 0) {
        return;
      }

      let ms: MagicString | null = null;
      for (const hit of hits) {
        if (!isClientEnvKey(hit.property)) {
          // Server-only key — let the client-guard plugin handle it.
          continue;
        }
        const value = loadedEnv[hit.property];
        if (value === undefined) {
          // Client-exposed but no known build-time value — Proxy will
          // read it from `import.meta.env` at runtime.
          continue;
        }
        if (!ms) {
          ms = new MagicString(code);
        }
        ms.overwrite(hit.start, hit.end, JSON.stringify(value));
      }

      if (!ms) {
        return;
      }
      return {
        code: ms.toString(),
        map: ms.generateMap({ hires: 'boundary' }),
      };
    },
  };
}
