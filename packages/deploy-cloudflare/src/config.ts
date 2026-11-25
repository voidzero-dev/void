import { existsSync, readFileSync } from 'node:fs';
import { isRecord } from '@void/deploy-core';
import { applyEdits, modify, parse as parseJsoncConfig } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';

/** Parse a root Wrangler JSON/JSONC config without accepting a partial parse. */
export function parseRootWranglerConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) {
    return {};
  }
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    return {};
  }
  const content = raw.startsWith('﻿') ? raw.slice(1) : raw;
  const errors: Array<ParseError> = [];
  const parsed: unknown = parseJsoncConfig(content, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(parsed)) {
    return {};
  }
  return parsed;
}

/** Set one value in JSONC text, keeping comments and formatting elsewhere. */
export function setJsoncValue(text: string, path: Array<string>, value: unknown): string {
  return applyEdits(
    text,
    modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }),
  );
}

export function readWranglerTopLevelString(
  config: Record<string, unknown>,
  field: string,
): string | undefined {
  return readConfigEntryString(config, field);
}

/** The first entry of `config[field]` whose `binding` matches. */
function findBindingEntry(
  config: Record<string, unknown>,
  field: string,
  binding: string,
): Record<string, unknown> | undefined {
  const list = config[field];
  if (!Array.isArray(list)) {
    return undefined;
  }
  return list.find(
    (entry: unknown): entry is Record<string, unknown> =>
      typeof entry === 'object' &&
      entry !== null &&
      'binding' in entry &&
      entry.binding === binding,
  );
}

export function readStoredResourceName(
  config: Record<string, unknown>,
  field: string,
  binding: string,
  nameField: string,
): string | undefined {
  return readConfigEntryString(findBindingEntry(config, field, binding), nameField);
}

export function readBindingFieldPresence(
  config: Record<string, unknown>,
  field: string,
  binding: string,
  key: string,
): { present: boolean; value: unknown } {
  const entry = findBindingEntry(config, field, binding);
  return entry && Object.hasOwn(entry, key)
    ? { present: true, value: entry[key] }
    : { present: false, value: undefined };
}

export function readConfigEntryString(entry: unknown, field: string): string | undefined {
  const value = isRecord(entry) ? entry[field] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function resolveD1MigrateTarget(
  config: Record<string, unknown>,
  binding: string,
): { ok: true; token: string } | { ok: false; reason: string } {
  const list = config.d1_databases;
  if (!Array.isArray(list)) {
    return { ok: false, reason: `the root config has no "d1_databases" array` };
  }
  const validatedIndex = list.findIndex(
    (entry) => readConfigEntryString(entry, 'binding') === binding,
  );
  if (validatedIndex === -1) {
    return { ok: false, reason: `no d1_databases entry has binding ${JSON.stringify(binding)}` };
  }
  const validated: unknown = list[validatedIndex];
  const token = readConfigEntryString(validated, 'database_name') ?? binding;
  for (let i = 0; i < validatedIndex; i++) {
    const earlier: unknown = list[i];
    if (
      readConfigEntryString(earlier, 'database_name') === token ||
      readConfigEntryString(earlier, 'binding') === token
    ) {
      return {
        ok: false,
        reason:
          `an earlier d1_databases entry (binding ${JSON.stringify(readConfigEntryString(earlier, 'binding'))}, ` +
          `database_name ${JSON.stringify(readConfigEntryString(earlier, 'database_name'))}) also matches the ` +
          `token ${JSON.stringify(token)}, so wrangler would migrate it instead`,
      };
    }
  }
  return { ok: true, token };
}
