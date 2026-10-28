import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '@void/deploy-core';
import { join } from 'pathslash';
import { parseJsoncObject } from './cli/generated-wrangler-config.ts';
import { TYPED_CONFIG_FILE } from './config-loader.ts';
import { readConfig } from './config.ts';
import { writeFileAtomic } from './shared/atomic-write.ts';

export const MATERIALIZED_CLOUDFLARE_FILE = '.void-wrangler.jsonc';
export const VOID_LOCK_FILE = 'void.lock.json';
const PREVIEW_POINTER_FILE = 'preview-deploy-config.json';

/** Add the generated Cloudflare config to `.gitignore` unless a line already ignores it. */
export function ignoreMaterializedCloudflareConfig(root: string): void {
  const path = join(root, '.gitignore');
  const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const ignored = source.split('\n').some((line) => {
    const entry = line.trim();
    return entry === MATERIALIZED_CLOUDFLARE_FILE || entry === `/${MATERIALIZED_CLOUDFLARE_FILE}`;
  });
  if (ignored) {
    return;
  }
  const separator = source && !source.endsWith('\n') ? '\n' : '';
  writeFileSync(path, `${source}${separator}${MATERIALIZED_CLOUDFLARE_FILE}\n`);
}

type JsonObject = Record<string, unknown>;
type CloudflareState = {
  version: 1;
  source: JsonObject;
  resolved: JsonObject;
  text: string;
};

function arrayIdentity(value: unknown): string {
  if (isRecord(value)) {
    for (const key of ['binding', 'name', 'tag', 'class_name', 'pattern', 'route']) {
      if (typeof value[key] === 'string') {
        return `${key}:${value[key]}`;
      }
    }
  }
  return JSON.stringify(value) ?? String(value);
}

/** Keep authored values authoritative while retaining fields produced by Void. */
function mergeConfig(previous: unknown, resolved: unknown, authored: unknown): unknown {
  if (isDeepStrictEqual(previous, authored)) {
    return resolved;
  }
  if (Array.isArray(previous) && Array.isArray(resolved) && Array.isArray(authored)) {
    const previousByIdentity = new Map(previous.map((item) => [arrayIdentity(item), item]));
    const resolvedByIdentity = new Map(resolved.map((item) => [arrayIdentity(item), item]));
    const authoredIdentities = new Set(authored.map(arrayIdentity));
    return [
      ...authored.map((item) => {
        const identity = arrayIdentity(item);
        return previousByIdentity.has(identity) && resolvedByIdentity.has(identity)
          ? mergeConfig(previousByIdentity.get(identity), resolvedByIdentity.get(identity), item)
          : item;
      }),
      ...resolved.filter((item) => {
        const identity = arrayIdentity(item);
        return !previousByIdentity.has(identity) && !authoredIdentities.has(identity);
      }),
    ];
  }
  if (isRecord(previous) && isRecord(resolved) && isRecord(authored)) {
    const result: JsonObject = {};
    for (const key of new Set([
      ...Object.keys(previous),
      ...Object.keys(resolved),
      ...Object.keys(authored),
    ])) {
      if (!(key in authored)) {
        if (!(key in previous) && key in resolved) {
          Object.defineProperty(result, key, {
            value: resolved[key],
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        continue;
      }
      const value = mergeConfig(previous[key], resolved[key], authored[key]);
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  }
  return authored;
}

function parseCloudflareText(text: string, path: string): JsonObject {
  const value = parseJsoncObject(text);
  if (!value) {
    throw new Error(`config: ${path} must contain a valid JSON/JSONC object.`);
  }
  return value;
}

function readState(root: string): CloudflareState | undefined {
  const path = join(root, VOID_LOCK_FILE);
  if (!existsSync(path)) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`config: Invalid ${VOID_LOCK_FILE}. Fix or restore it before continuing.`);
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isRecord(value.source) ||
    !isRecord(value.resolved) ||
    typeof value.text !== 'string'
  ) {
    throw new Error(`config: Invalid ${VOID_LOCK_FILE}. Fix or restore it before continuing.`);
  }
  const state = value as CloudflareState;
  if (!isDeepStrictEqual(parseCloudflareText(state.text, VOID_LOCK_FILE), state.resolved)) {
    // `resolved` is the editable checked-in state. Rebuild the materialized text after an edit.
    state.text = `${provenance(state.text)}${JSON.stringify(state.resolved, null, 2)}\n`;
  }
  return state;
}

function writeState(root: string, state: CloudflareState): void {
  const path = join(root, VOID_LOCK_FILE);
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (existsSync(path)) {
    try {
      if (isDeepStrictEqual(JSON.parse(readFileSync(path, 'utf8')), state)) {
        return;
      }
    } catch {
      // Replace an invalid lock only after the caller has validated its state.
    }
  }
  writeFileAtomic(path, content);
}

/** Keep Vite preview usable without leaving Wrangler's implicit deploy pointer after a build. */
export function stashCloudflareDeployPointer(root: string): void {
  const pointer = join(root, '.wrangler', 'deploy', 'config.json');
  if (!existsSync(pointer)) {
    return;
  }
  const directory = join(root, '.void');
  mkdirSync(directory, { recursive: true });
  writeFileAtomic(join(directory, PREVIEW_POINTER_FILE), readFileSync(pointer, 'utf8'));
  rmSync(pointer, { force: true });
}

export function restoreCloudflarePreviewPointer(root: string): boolean {
  const saved = join(root, '.void', PREVIEW_POINTER_FILE);
  if (!existsSync(saved)) {
    return false;
  }
  const directory = join(root, '.wrangler', 'deploy');
  mkdirSync(directory, { recursive: true });
  writeFileAtomic(join(directory, 'config.json'), readFileSync(saved, 'utf8'));
  return true;
}

/** Preserve Void's JSONC provenance comments when authored settings change. */
function provenance(text: string): string {
  const lines = text.match(
    /^\s*\/\/ void:(?:managed-queues|published-traffic):v1:[A-Za-z0-9_-]+\s*$/gm,
  );
  return lines ? `${lines.join('\n')}\n` : '';
}

/** Resolve the config file passed to Cloudflare tooling. Typed projects use a generated file. */
export function materializeCloudflareConfig(root: string): string {
  if (!existsSync(join(root, TYPED_CONFIG_FILE))) {
    for (const name of ['wrangler.jsonc', 'wrangler.json']) {
      if (existsSync(join(root, name))) {
        return join(root, name);
      }
    }
    return join(root, 'wrangler.jsonc');
  }

  if (['wrangler.jsonc', 'wrangler.json'].some((name) => existsSync(join(root, name)))) {
    throw new Error(
      'config: Run `void migrate` to move the root Wrangler config into void.config.ts.',
    );
  }
  const authored = (readConfig(root).cloudflare ?? {}) as JsonObject;
  const state = readState(root);
  const resolved = (
    state ? mergeConfig(state.source, state.resolved, authored) : authored
  ) as JsonObject;
  const text =
    state &&
    isDeepStrictEqual(resolved, state.resolved) &&
    isDeepStrictEqual(authored, state.source)
      ? state.text
      : `${provenance(state?.text ?? '')}${JSON.stringify(resolved, null, 2)}\n`;
  const path = join(root, MATERIALIZED_CLOUDFLARE_FILE);
  if (!existsSync(path) || readFileSync(path, 'utf8') !== text) {
    writeFileAtomic(path, text);
  }
  if (state) {
    writeState(root, { version: 1, source: authored, resolved, text });
  }
  return path;
}

/** Record Cloudflare settings written by Void so later builds reproduce them. */
export function persistCloudflareConfig(root: string): void {
  if (!existsSync(join(root, TYPED_CONFIG_FILE))) {
    return;
  }
  const path = join(root, MATERIALIZED_CLOUDFLARE_FILE);
  if (!existsSync(path)) {
    throw new Error(`config: Missing generated ${MATERIALIZED_CLOUDFLARE_FILE}.`);
  }
  const text = readFileSync(path, 'utf8');
  const resolved = parseCloudflareText(text, path);
  const authored = (readConfig(root).cloudflare ?? {}) as JsonObject;
  if (
    readState(root) ||
    !isDeepStrictEqual(resolved, authored) ||
    text !== `${JSON.stringify(authored, null, 2)}\n`
  ) {
    writeState(root, { version: 1, source: authored, resolved, text });
  }
}

/** Seed the checked-in lock from a root Wrangler file during migration. */
export function seedCloudflareConfig(root: string, source: JsonObject, text: string): void {
  const existing = readState(root);
  if (existing) {
    if (
      isDeepStrictEqual(existing.source, source) &&
      isDeepStrictEqual(existing.resolved, source)
    ) {
      return;
    }
    throw new Error(
      `migrate: ${VOID_LOCK_FILE} already exists with different settings. Resolve it before migrating.`,
    );
  }
  if (!isDeepStrictEqual(parseCloudflareText(text, MATERIALIZED_CLOUDFLARE_FILE), source)) {
    throw new Error('migrate: The Cloudflare config changed during migration. Retry.');
  }
  writeState(root, { version: 1, source, resolved: source, text });
}
