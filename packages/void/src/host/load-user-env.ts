/**
 * Loader for the user's `env.ts`.
 *
 * Uses Node's native `import()` (type-stripping is on by default in the
 * supported Node version), so only relative imports and bare package
 * specifiers resolve. tsconfig path aliases (`@/foo`, `~/foo`) are NOT
 * supported — if the user writes one, we detect the resulting resolution
 * error and re-throw with guidance pointing at the offending specifier.
 *
 * Side-effect contract: loading the file evaluates the user's `defineEnv`
 * call, which registers the schema in the singleton state in
 * `runtime/env-public.ts`. Callers read the result from there.
 *
 * Node-only (lives under `host/`). Must not be imported from anything
 * that ships in worker bundles.
 */
import { pathToFileURL } from 'node:url';
import { aliasHint } from './alias-hint.ts';

let loadCounter = 0;

export async function loadUserEnvFile(envFile: string): Promise<void> {
  // Counter + timestamp so back-to-back HMR reloads in the same millisecond
  // still produce distinct URLs (Node's ESM loader caches by URL).
  const url = pathToFileURL(envFile).href + `?t=${Date.now()}-${++loadCounter}`;
  try {
    await import(/* @vite-ignore */ url);
  } catch (err) {
    const base = `env: Failed to load '${envFile}': '${(err as Error).message}'.`;
    const hint = aliasHint(err, 'env.ts');
    throw new Error(hint ? `${base}\n\n${hint}` : base);
  }
}
