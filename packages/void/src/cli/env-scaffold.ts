/**
 * `void init` hook — when the project has no `env.ts` but has dotenv files
 * on disk, scaffold an `env.ts` whose keys mirror what the user already
 * has. Inference is intentionally permissive: we only upgrade from the
 * default `string()` helper when the value is unambiguously a boolean,
 * URL, or small integer. Everything else stays a string and carries a
 * one-line banner nudging the user to tighten the schema.
 *
 * This is a best-effort DX sweetener, not a correctness boundary — a
 * wrong guess only costs the user a single-line edit.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'pathslash';
import { parseDotenvFile } from '../shared/dotenv.ts';

export type InferredHelper = 'string' | 'number' | 'boolean' | 'url';

export type InferredEntry = {
  key: string;
  helper: InferredHelper;
};

const BOOLEAN_LITERAL = /^(true|false)$/i;
const HTTP_URL = /^https?:\/\/\S+$/;
// Plain integer, reasonable port/size range, no leading zero unless value is 0.
// Deliberately strict: phone numbers, Stripe IDs, and timestamps all look
// numeric but users read them as strings.
const SMALL_INTEGER = /^(?:0|[1-9]\d{0,4})$/;

/**
 * Classify a single `.env` value into the Void built-in helper to use.
 * Returns `'string'` whenever inference is ambiguous — the comment in the
 * scaffolded file asks the user to tighten any wrong guesses.
 */
export function inferHelperForValue(value: string | undefined): InferredHelper {
  if (!value) {
    return 'string';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return 'string';
  }
  if (BOOLEAN_LITERAL.test(trimmed)) {
    return 'boolean';
  }
  if (HTTP_URL.test(trimmed)) {
    return 'url';
  }
  if (SMALL_INTEGER.test(trimmed)) {
    return 'number';
  }
  return 'string';
}

/** Collect the inferred entries from the local `.env`, sorted by key. */
export function collectInferredEntries(root: string): Array<InferredEntry> {
  const values = parseDotenvFile(join(root, '.env'));
  return Object.keys(values)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => ({ key, helper: inferHelperForValue(values[key]) }));
}

/**
 * Render the scaffolded `env.ts` body. The imports are pulled in lazily
 * so only helpers we reference appear in the import statement.
 */
export function renderEnvTs(entries: Array<InferredEntry>): string {
  if (entries.length === 0) {
    return [
      `import { defineEnv } from 'void/env';`,
      ``,
      `// Define your environment variables here. See https://void.cloud/guide/env-vars`,
      `export default defineEnv({});`,
      ``,
    ].join('\n');
  }

  const helpers = new Set<InferredHelper>(['string']);
  for (const e of entries) {
    helpers.add(e.helper);
  }
  const importList = (['string', 'number', 'boolean', 'url'] as const).filter((h) =>
    helpers.has(h),
  );

  const lines: Array<string> = [];
  lines.push(`import { defineEnv, ${importList.join(', ')} } from 'void/env';`);
  lines.push('');
  lines.push(`// Scaffolded from .env. Inference is conservative — review each`);
  lines.push(`// entry and tighten types as needed (e.g. oneOf([...]), url(), .optional(),`);
  lines.push(`// .default(value), or a Standard Schema validator from valibot/zod/arktype).`);
  lines.push(`export default defineEnv({`);
  for (const entry of entries) {
    lines.push(`  ${entry.key}: ${entry.helper}(),`);
  }
  lines.push(`});`);
  lines.push('');
  return lines.join('\n');
}

export type ScaffoldResult = {
  /** Path written (absolute), or `null` if nothing was written. */
  written: string | null;
  /** Reason we skipped, when `written` is null. */
  skipReason?: 'env-ts-exists' | 'no-dotenv-files';
  entries: Array<InferredEntry>;
};

/**
 * If the project has no `env.ts`, scaffold one based on the local `.env`
 * user already has. Safe to call unconditionally during `void init` — it
 * no-ops when `env.ts` is present. Never overwrites an existing file.
 */
export function maybeScaffoldEnvTs(root: string): ScaffoldResult {
  // Respect `env.*` at the root or under `src/`, whichever the user already uses.
  for (const dir of ['', 'src/']) {
    for (const ext of ['ts', 'mts', 'js', 'mjs']) {
      if (existsSync(join(root, `${dir}env.${ext}`))) {
        return { written: null, skipReason: 'env-ts-exists', entries: [] };
      }
    }
  }

  if (!existsSync(join(root, '.env'))) {
    return { written: null, skipReason: 'no-dotenv-files', entries: [] };
  }

  const entries = collectInferredEntries(root);
  const target = join(root, 'env.ts');
  writeFileSync(target, renderEnvTs(entries));
  return { written: target, entries };
}
