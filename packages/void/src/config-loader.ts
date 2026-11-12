import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { join } from 'pathslash';
import { aliasHint } from './host/alias-hint.ts';

export const LEGACY_CONFIG_FILE = 'void.json';
export const TYPED_CONFIG_FILE = 'void.config.ts';

export type LoadedVoidConfig = { source: string; value: unknown };

/** The file to name in messages about a project's settings. Only legacy projects use JSON. */
export function getConfigFileName(root: string): string {
  return existsSync(join(root, LEGACY_CONFIG_FILE)) ? LEGACY_CONFIG_FILE : TYPED_CONFIG_FILE;
}

/** Evaluate a TypeScript config without requiring Void to be installed in the target project. */
export function loadTypedVoidConfigFile(path: string): unknown {
  const sourceEntry = fileURLToPath(new URL('./config-entry.ts', import.meta.url));
  const configEntry = existsSync(sourceEntry)
    ? sourceEntry
    : fileURLToPath(import.meta.resolve('void/config'));
  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    moduleCache: false,
    interopDefault: false,
    alias: { 'void/config': configEntry },
  });
  const module = jiti(path) as { default?: unknown };
  if (!Object.hasOwn(module, 'default')) {
    throw new Error('expected a default export');
  }
  return module.default;
}

/** Load project-authored configuration before runtime validation. */
export function loadVoidConfig(root: string): LoadedVoidConfig | null {
  const typedPath = join(root, TYPED_CONFIG_FILE);
  const jsonPath = join(root, LEGACY_CONFIG_FILE);
  const hasTyped = existsSync(typedPath);
  const hasJson = existsSync(jsonPath);
  if (hasTyped && hasJson) {
    throw new Error(
      `config: Found both ${TYPED_CONFIG_FILE} and ${LEGACY_CONFIG_FILE}. Move the settings from ${LEGACY_CONFIG_FILE} into ${TYPED_CONFIG_FILE}, then delete ${LEGACY_CONFIG_FILE}.`,
    );
  }
  if (!hasTyped && !hasJson) {
    return null;
  }

  if (hasTyped) {
    try {
      return { source: TYPED_CONFIG_FILE, value: loadTypedVoidConfigFile(typedPath) };
    } catch (error) {
      const base = `config: Could not load ${TYPED_CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`;
      const hint = aliasHint(error, TYPED_CONFIG_FILE);
      throw new Error(hint ? `${base}\n\n${hint}` : base, { cause: error });
    }
  }

  try {
    return { source: LEGACY_CONFIG_FILE, value: JSON.parse(readFileSync(jsonPath, 'utf-8')) };
  } catch (error) {
    throw new Error(`config: Invalid JSON in ${LEGACY_CONFIG_FILE}.`, { cause: error });
  }
}
