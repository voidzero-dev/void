import { readFileSync } from 'node:fs';
import { parse } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';

/** Parse JSON/JSONC text with an optional BOM; undefined unless it is one valid object. */
export function parseJsoncObject(text: string): Record<string, unknown> | undefined {
  const errors: Array<ParseError> = [];
  const parsed: unknown = parse(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
  if (errors.length > 0 || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/** Parse a generated Wrangler JSON/JSONC config without accepting a partial parse. */
export function readGeneratedWranglerConfigFile(path: string): Record<string, unknown> {
  const parsed = parseJsoncObject(readFileSync(path, 'utf8'));
  if (!parsed) {
    throw new Error('Invalid Wrangler JSON/JSONC config.');
  }
  return parsed;
}
