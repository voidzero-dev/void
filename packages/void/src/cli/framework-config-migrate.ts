import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'pathslash';
import { parseSync } from 'vite';

const GENERATED_PATH = './.void-wrangler.jsonc';
const CONFIG_FILES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'vite.config.mjs',
  'vite.config.cts',
  'vite.config.cjs',
  'svelte.config.ts',
  'svelte.config.js',
  'astro.config.ts',
  'astro.config.mjs',
  'astro.config.js',
  'astro.config.mts',
  'nuxt.config.ts',
  'nuxt.config.mjs',
  'nuxt.config.js',
  'nuxt.config.mts',
];

export type FrameworkConfigPatch = { file: string; original: string; updated: string };

type Expression = {
  type: string;
  start: number;
  end: number;
  body?: Array<Expression>;
  name?: string;
  key?: Expression;
  value?: unknown;
  elements?: Array<Expression>;
  source?: Expression;
  specifiers?: Array<Expression>;
  local?: Expression;
  imported?: Expression;
  callee?: Expression;
  arguments?: Array<Expression>;
  expressions?: Array<Expression>;
  properties?: Array<
    Expression & { key?: Expression; value?: Expression; computed?: boolean; kind?: string }
  >;
};
type Edit = { start: number; end: number; text: string };

function adapterPathError(file: string): Error {
  return new Error(
    `migrate: Update ${file} to pass ${GENERATED_PATH} to its Cloudflare adapter before removing the root Wrangler config.`,
  );
}

function nitroPathError(file: string): Error {
  return new Error(
    `migrate: Set nitro.cloudflareDev.configPath to ${GENERATED_PATH} in ${file} before removing the root Wrangler config.`,
  );
}

function mentionsCloudflareAdapter(source: string): boolean {
  return (
    source.includes('@sveltejs/adapter-cloudflare') ||
    source.includes('@astrojs/cloudflare') ||
    source.includes('nitro-cloudflare-dev')
  );
}

function applyEdits(source: string, edits: Array<Edit>): string {
  return edits
    .sort((a, b) => b.start - a.start)
    .reduce(
      (result, edit) => `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`,
      source,
    );
}

function parseSource(source: string, file: string): Expression {
  return parseSync(file, source).program as Expression;
}

function asNode(value: unknown): Expression | undefined {
  return value !== null &&
    typeof value === 'object' &&
    typeof (value as Expression).type === 'string'
    ? (value as Expression)
    : undefined;
}

function walk(root: Expression): Array<Expression> {
  const result: Array<Expression> = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    result.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value as Array<unknown>) {
          if (
            child &&
            typeof child === 'object' &&
            'type' in child &&
            typeof child.type === 'string'
          ) {
            pending.push(child as Expression);
          }
        }
      } else if (
        value &&
        typeof value === 'object' &&
        typeof (value as Expression).type === 'string'
      ) {
        pending.push(value as Expression);
      }
    }
  }
  return result;
}

function adapterImport(program: Expression, packageName: string, file: string): string | undefined {
  const imports = (program.body ?? []).filter(
    (node) => node.type === 'ImportDeclaration' && node.source?.value === packageName,
  );
  if (imports.length === 0) {
    const loaded = walk(program).some(
      (node) =>
        node.type === 'CallExpression' &&
        (node.callee?.name === 'require' || node.callee?.type === 'Import') &&
        node.arguments?.[0]?.value === packageName,
    );
    if (loaded) {
      throw adapterPathError(file);
    }
    return undefined;
  }
  const defaultImport = imports[0]?.specifiers?.find(
    (specifier) => specifier.type === 'ImportDefaultSpecifier',
  );
  if (imports.length !== 1 || imports[0]?.specifiers?.length !== 1 || !defaultImport?.local?.name) {
    throw adapterPathError(file);
  }
  return defaultImport.local.name;
}

/** Find an adapter's explicit root Wrangler JSON file, including custom build filenames. */
export function discoverFrameworkWranglerFiles(root: string): Array<string> {
  const names = new Set<string>();
  for (const file of CONFIG_FILES) {
    const path = join(root, file);
    if (!existsSync(path)) {
      continue;
    }
    const source = readFileSync(path, 'utf8');
    if (!mentionsCloudflareAdapter(source)) {
      continue;
    }
    const program = parseSource(source, file);
    const hasAdapter = walk(program).some(
      (node) =>
        node.type === 'ImportDeclaration' &&
        (node.source?.value === '@sveltejs/adapter-cloudflare' ||
          node.source?.value === '@astrojs/cloudflare'),
    );
    const hasNitro = walk(program).some(
      (node) => node.type === 'Literal' && node.value === 'nitro-cloudflare-dev',
    );
    if (!hasAdapter && !hasNitro) {
      continue;
    }
    for (const node of walk(program)) {
      const value = asNode(node.value);
      if (
        node.type !== 'Property' ||
        (node.key?.name !== 'configPath' && node.key?.name !== 'config') ||
        typeof value?.value !== 'string'
      ) {
        continue;
      }
      const name = value.value.replace(/^\.\//, '');
      if (/^wrangler[A-Za-z0-9._-]*\.jsonc?$/.test(name) && existsSync(join(root, name))) {
        names.add(name);
      }
    }
  }
  return [...names];
}

function property(object: Expression, key: string): Expression | undefined {
  return object.properties?.find(
    (item) =>
      item.type === 'Property' &&
      !item.computed &&
      item.kind === 'init' &&
      (item.key?.name === key || item.key?.value === key),
  )?.value;
}

function setPath(
  object: Expression,
  key: string,
  file: string,
  edits: Array<Edit>,
  legacyName?: string,
): void {
  const value = property(object, key);
  if (!value) {
    edits.push({
      start: object.start + 1,
      end: object.start + 1,
      text: `${key}: '${GENERATED_PATH}', `,
    });
  } else if (
    value.type === 'Literal' &&
    typeof value.value === 'string' &&
    (['wrangler.jsonc', 'wrangler.json', legacyName].includes(value.value.replace(/^\.\//, '')) ||
      value.value === GENERATED_PATH)
  ) {
    edits.push({ start: value.start, end: value.end, text: `'${GENERATED_PATH}'` });
  } else {
    throw adapterPathError(file);
  }
}

function patchAdapterCall(
  source: string,
  identifier: string,
  file: string,
  kind: 'svelte' | 'astro',
  legacyName?: string,
): string {
  const calls = walk(parseSource(source, file)).filter(
    (node) => node.type === 'CallExpression' && node.callee?.name === identifier,
  );
  if (calls.length !== 1) {
    throw adapterPathError(file);
  }
  const call = calls[0]!;
  const args = call.arguments ?? [];
  if (args.length > 1 || (args.length === 1 && args[0]?.type !== 'ObjectExpression')) {
    throw adapterPathError(file);
  }
  if (args.length === 0) {
    const options =
      kind === 'svelte'
        ? `{ config: '${GENERATED_PATH}', platformProxy: { configPath: '${GENERATED_PATH}' } }`
        : `{ configPath: '${GENERATED_PATH}' }`;
    return `${source.slice(0, call.end - 1)}${options}${source.slice(call.end - 1)}`;
  }
  const options = args[0]!;
  const edits: Array<Edit> = [];
  if (kind === 'astro') {
    setPath(options, 'configPath', file, edits, legacyName);
  } else {
    setPath(options, 'config', file, edits, legacyName);
    const proxy = property(options, 'platformProxy');
    if (!proxy) {
      edits.push({
        start: options.start + 1,
        end: options.start + 1,
        text: `platformProxy: { configPath: '${GENERATED_PATH}' }, `,
      });
    } else if (proxy.type === 'ObjectExpression') {
      setPath(proxy, 'configPath', file, edits, legacyName);
    } else {
      throw adapterPathError(file);
    }
  }
  return applyEdits(source, edits);
}

/** Plan only edits whose adapter call can be identified without changing authored options. */
export function planFrameworkConfigMigration(
  root: string,
  legacyName?: string,
): Array<FrameworkConfigPatch> {
  const patches: Array<FrameworkConfigPatch> = [];
  for (const file of CONFIG_FILES) {
    const path = join(root, file);
    if (!existsSync(path)) {
      continue;
    }
    const original = readFileSync(path, 'utf8');
    let updated = original;

    if (!mentionsCloudflareAdapter(original)) {
      continue;
    }
    const program = parseSource(original, file);
    const svelteIdentifier = adapterImport(program, '@sveltejs/adapter-cloudflare', file);
    if (svelteIdentifier) {
      updated = patchAdapterCall(updated, svelteIdentifier, file, 'svelte', legacyName);
    }

    const astroIdentifier = adapterImport(program, '@astrojs/cloudflare', file);
    if (astroIdentifier) {
      updated = patchAdapterCall(updated, astroIdentifier, file, 'astro', legacyName);
    }

    const nitroConfigurations = walk(parseSource(updated, file)).filter((node) => {
      const nitro = asNode(node.value);
      if (
        node.type !== 'Property' ||
        node.key?.name !== 'nitro' ||
        nitro?.type !== 'ObjectExpression'
      ) {
        return false;
      }
      const modules = property(nitro, 'modules');
      return (
        modules?.type === 'ArrayExpression' &&
        modules.elements?.some((entry) => entry?.value === 'nitro-cloudflare-dev')
      );
    });
    if (nitroConfigurations.length > 0) {
      if (nitroConfigurations.length !== 1) {
        throw nitroPathError(file);
      }
      const nitro = asNode(nitroConfigurations[0]!.value)!;
      if (property(nitro, 'preset')?.value !== 'cloudflare-module') {
        throw nitroPathError(file);
      }
      const dev = property(nitro, 'cloudflareDev');
      const edits: Array<Edit> = [];
      if (!dev) {
        edits.push({
          start: nitro.start + 1,
          end: nitro.start + 1,
          text: `cloudflareDev: { configPath: '${GENERATED_PATH}' }, `,
        });
      } else if (dev.type === 'ObjectExpression') {
        setPath(dev, 'configPath', file, edits, legacyName);
      } else {
        throw nitroPathError(file);
      }
      updated = applyEdits(updated, edits);
    }

    if (updated !== original) {
      patches.push({ file, original, updated });
    }
  }
  return patches;
}

export function applyFrameworkConfigMigration(
  root: string,
  patches: Array<FrameworkConfigPatch>,
): boolean {
  for (const patch of patches) {
    const path = join(root, patch.file);
    if (readFileSync(path, 'utf8') !== patch.original) {
      throw new Error(`migrate: ${patch.file} changed during migration. Retry.`);
    }
    const backup = join(root, '.void', 'config-migration', patch.file);
    mkdirSync(dirname(backup), { recursive: true });
    if (!existsSync(backup)) {
      writeFileSync(backup, patch.original, { flag: 'wx' });
    }
    writeFileSync(path, patch.updated);
  }
  return patches.length > 0;
}

export function migrateFrameworkAdapterPaths(root: string): boolean {
  if (!existsSync(join(root, 'void.config.ts'))) {
    return false;
  }
  return applyFrameworkConfigMigration(root, planFrameworkConfigMigration(root));
}
