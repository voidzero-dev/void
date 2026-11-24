/**
 * T2 built-output diff (spec §7.1, §7.4). Pure functions over the deployed Worker
 * modules; no I/O.
 *
 * - A module changed when its sha256 differs from the base snapshot's.
 * - Changed modules are mapped back to source through their source map's
 *   `sourcesContent`. A source counts as changed when its content hash differs
 *   from the base's source index (or, with no base index, when it sits in a
 *   changed module).
 * - A module with no usable source map is scanned as built code
 *   (`no-source-maps`).
 * - Priority follows the bundle's import graph from the main module, not folder
 *   names. Text assets come after server code.
 */
import { createHash } from 'node:crypto';
import { SCAN_INPUT_LIMITS } from '../../../../security-scanner/src/runner/limits.ts';

export type SecurityModuleFile = Readonly<{
  name: string;
  sha256: string;
  /** The module's text; empty for a `.map` read ahead into `sources`. */
  text: string;
  /**
   * A `.map` module already read (`securityModuleFile`), so its JSON text is not
   * kept: `null` when it is no usable map.
   */
  sources?: ReadonlyArray<SecurityMapSource> | null;
}>;

/**
 * One deployed module as the input builder holds it. A source map is read here,
 * one module at a time, and only its `sourcesContent` is kept: the map's JSON
 * (mappings and all) is never held next to the rest of the bundle.
 */
export function securityModuleFile(name: string, sha256: string, text: string): SecurityModuleFile {
  if (name.endsWith('.map')) {
    return { name, sha256, text: '', sources: readSourceMap(name, text) };
  }
  return { name, sha256, text };
}

export type SecuritySourceFile = Readonly<{
  /** Path under `/scan/input`. */
  path: string;
  text: string;
  sha256: string;
  /** The module whose map listed it first. */
  module: string;
  /** That module's source map module, when the map is a separate file. */
  map: string | null;
  /** Built code with no source map (`_worker/<module>`). */
  built: boolean;
}>;

/** Where built modules without a source map go under `/scan/input`. */
export const SECURITY_BUILT_PREFIX = '_worker/';
/** Where changed text assets go under `/scan/input`. */
export const SECURITY_ASSET_PREFIX = '_assets/';
/** Where the client asset pass (M31) puts the sources of client bundles. */
export const SECURITY_CLIENT_PREFIX = '_client/';

/** Text assets T2 reads: these types, at most 256 KB each. */
export const SECURITY_TEXT_ASSET_EXTENSIONS: ReadonlyArray<string> = [
  '.js',
  '.mjs',
  '.html',
  '.json',
  '.css',
  '.txt',
];
export const SECURITY_TEXT_ASSET_MAX_BYTES = 256 * 1024;

export function sha256Hex(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

const MAX_SEGMENT_CHARS = 200;
/**
 * A normalized path stays this short, so `_assets/`, a `~n` suffix and `input/`
 * still fit the runner's `changed_files` limit (1024 characters).
 */
const MAX_PATH_CHARS = SCAN_INPUT_LIMITS.maxTaskPathChars - 64;
/** Where a path too long to send goes: `_long/<hash>/<file name>`. */
const LONG_PATH_PREFIX = '_long/';

/**
 * A source map entry as a safe relative path, or `null`. Schemes (`webpack://`)
 * and query strings are cut; the path resolves against the map's folder and its
 * `sourceRoot`; a `..` above the root is dropped. A path still too long for the
 * runner becomes `_long/<sha256 prefix>/<file name>`.
 */
export function normalizeSourcePath(
  mapName: string,
  sourceRoot: string | undefined,
  source: string,
): string | null {
  let path = source;
  for (const stop of ['?', '#']) {
    const at = path.indexOf(stop);
    if (at !== -1) {
      path = path.slice(0, at);
    }
  }
  const scheme = path.indexOf('://');
  let absolute = false;
  if (scheme !== -1) {
    path = path.slice(scheme + 3);
    absolute = true;
  } else if (path.startsWith('/')) {
    absolute = true;
  }
  path = path.split('\\').join('/');
  let joined: string;
  if (absolute) {
    joined = path;
  } else {
    const slash = mapName.lastIndexOf('/');
    const folder = slash === -1 ? '' : mapName.slice(0, slash + 1);
    const root = sourceRoot ? `${sourceRoot.split('\\').join('/')}/` : '';
    joined = `${folder}${root}${path}`;
  }
  const out: Array<string> = [];
  for (const segment of joined.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      out.pop();
      continue;
    }
    let clean = '';
    for (const char of segment) {
      const code = char.charCodeAt(0);
      clean += code < 0x20 || code === 0x7f ? '_' : char;
    }
    // A tar name part holds at most 255 bytes; 60 characters fit in any UTF-8.
    const fits = clean.length <= MAX_SEGMENT_CHARS && new TextEncoder().encode(clean).length <= 240;
    out.push(fits ? clean : clean.slice(0, 60));
  }
  if (out.length === 0) {
    return null;
  }
  const normalized = out.join('/');
  if (normalized.length <= MAX_PATH_CHARS) {
    return normalized;
  }
  return `${LONG_PATH_PREFIX}${sha256Hex(normalized).slice(0, 16)}/${out.at(-1)!.slice(0, 60)}`;
}

type RawMap = {
  sources?: unknown;
  sourcesContent?: unknown;
  sourceRoot?: unknown;
  sections?: unknown;
};

export type SecurityMapSource = Readonly<{ path: string; text: string }>;

/**
 * The sources a map carries text for, in map order. Entries with no
 * `sourcesContent` are left out (they cannot be read). Index maps (`sections`)
 * are read one level deep.
 */
export function readSourceMap(mapName: string, text: string): Array<SecurityMapSource> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const out: Array<SecurityMapSource> = [];
  const read = (map: RawMap) => {
    if (!Array.isArray(map.sources) || !Array.isArray(map.sourcesContent)) {
      return;
    }
    const root = typeof map.sourceRoot === 'string' ? map.sourceRoot : undefined;
    map.sources.forEach((source: unknown, index: number) => {
      const content = (map.sourcesContent as Array<unknown>)[index];
      if (typeof source !== 'string' || typeof content !== 'string') {
        return;
      }
      const path = normalizeSourcePath(mapName, root, source);
      if (path !== null) {
        out.push({ path, text: content });
      }
    });
  };
  const raw = value as RawMap;
  if (Array.isArray(raw.sections)) {
    for (const section of raw.sections) {
      const map = (section as { map?: unknown } | null)?.map;
      if (typeof map === 'object' && map !== null) {
        read(map as RawMap);
      }
    }
  } else {
    read(raw);
  }
  return out;
}

function folderOf(name: string): string {
  const slash = name.lastIndexOf('/');
  return slash === -1 ? '' : name.slice(0, slash + 1);
}

function resolveRelative(from: string, specifier: string): string | null {
  const out: Array<string> = [];
  for (const segment of `${folderOf(from)}${specifier}`.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (out.length === 0) {
        return null;
      }
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

/** Where a module's source map is: a `.map` module by name, or inline JSON text. */
export type SecurityMapRef = Readonly<{ name: string; inline: string | null }>;

/**
 * The module's source map: the last `sourceMappingURL` comment (a file name, or an
 * inline base64 `data:` URL), else `<module>.map`. `maps` holds the `.map` module names.
 */
export function sourceMapFor(
  module: Readonly<{ name: string; text: string }>,
  maps: Readonly<{ has(name: string): boolean }>,
): SecurityMapRef | null {
  const marker = module.text.lastIndexOf('sourceMappingURL=');
  if (marker !== -1) {
    const text = module.text;
    let end = marker + 'sourceMappingURL='.length;
    const from = end;
    while (end < text.length) {
      const char = text[end]!;
      if (char === ' ' || char === '\n' || char === '\r' || char === '*' || char === '\t') {
        break;
      }
      end++;
    }
    const url = text.slice(from, end);
    const base64 = ';base64,';
    if (url.startsWith('data:') && url.includes(base64)) {
      try {
        const binary = atob(url.slice(url.indexOf(base64) + base64.length));
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return { name: `${module.name}.map`, inline: new TextDecoder().decode(bytes) };
      } catch {
        return null;
      }
    }
    if (url.length > 0 && !url.includes('://')) {
      const name = resolveRelative(module.name, url);
      if (name !== null && maps.has(name)) {
        return { name, inline: null };
      }
    }
  }
  const sibling = `${module.name}.map`;
  return maps.has(sibling) ? { name: sibling, inline: null } : null;
}

function readQuoted(text: string, from: number): string | null {
  let index = from;
  while (
    index < text.length &&
    (text[index] === ' ' || text[index] === '\n' || text[index] === '\t' || text[index] === '\r')
  ) {
    index++;
  }
  const quote = text[index];
  if (quote !== '"' && quote !== "'" && quote !== '`') {
    return null;
  }
  const end = text.indexOf(quote, index + 1);
  if (end === -1 || end - index > 1024) {
    return null;
  }
  return text.slice(index + 1, end);
}

/** Relative specifiers after `from`, `import` and `import(`; plain text scan, no regex. */
export function relativeImports(text: string): Array<string> {
  const found: Array<string> = [];
  const take = (specifier: string | null) => {
    if (specifier !== null && (specifier.startsWith('./') || specifier.startsWith('../'))) {
      found.push(specifier);
    }
  };
  for (const keyword of ['from', 'import']) {
    let at = text.indexOf(keyword);
    while (at !== -1) {
      const after = at + keyword.length;
      if (keyword === 'import') {
        let index = after;
        while (text[index] === ' ' || text[index] === '\n' || text[index] === '\t') {
          index++;
        }
        take(readQuoted(text, text[index] === '(' ? index + 1 : index));
      } else {
        take(readQuoted(text, after));
      }
      at = text.indexOf(keyword, after);
    }
  }
  return found;
}

/** Index after the whitespace and `//` or block comments at `from`. */
function skipBlank(text: string, from: number): number {
  let index = from;
  while (index < text.length) {
    const char = text[index]!;
    if (char === ' ' || char === '\n' || char === '\t' || char === '\r') {
      index++;
    } else if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end + 1;
    } else if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
    } else {
      break;
    }
  }
  return index;
}

function isBindingChar(char: string): boolean {
  return (
    (char >= 'a' && char <= 'z') ||
    (char >= 'A' && char <= 'Z') ||
    (char >= '0' && char <= '9') ||
    char === '_' ||
    char === '$' ||
    char === '{' ||
    char === '}' ||
    char === ',' ||
    char === '*'
  );
}

/**
 * A facade chunk: only `import "./x.js"`, `import { a } from "./x.js"`,
 * `export … from "./x.js"` and `export { a }` statements, with comments. It holds no
 * code of its own, so a missing source map loses nothing. Plain text scan, no regex.
 */
export function onlyImportsAndExports(text: string): boolean {
  let index = skipBlank(text, 0);
  while (index < text.length) {
    const keyword = text.startsWith('import', index)
      ? 'import'
      : text.startsWith('export', index)
        ? 'export'
        : null;
    if (keyword === null) {
      return false;
    }
    index += keyword.length;
    let braces = false;
    let ended = false;
    while (!ended) {
      index = skipBlank(text, index);
      const char = text[index];
      if (char === undefined || char === ';') {
        // `export { a }` re-exports what an import above bound; anything else needs a specifier.
        if (keyword !== 'export' || !braces) {
          return false;
        }
        index++;
        ended = true;
      } else if (char === '"' || char === "'") {
        const end = text.indexOf(char, index + 1);
        if (end === -1) {
          return false;
        }
        index = skipBlank(text, end + 1);
        if (text[index] === ';') {
          index++;
        }
        ended = true;
      } else if (isBindingChar(char)) {
        braces ||= char === '{';
        index++;
      } else {
        return false;
      }
    }
    index = skipBlank(text, index);
  }
  return true;
}

/**
 * Module names in import-graph order: breadth-first from `main` along relative
 * imports, then the modules nothing reached, by name.
 */
export function importGraphOrder(
  modules: ReadonlyArray<Readonly<{ name: string; text: string }>>,
  main: string | null,
): Array<string> {
  const byName = new Map(modules.map((module) => [module.name, module]));
  const order: Array<string> = [];
  const seen = new Set<string>();
  const queue: Array<string> = [];
  if (main !== null && byName.has(main)) {
    queue.push(main);
    seen.add(main);
  }
  while (queue.length > 0) {
    const name = queue.shift()!;
    order.push(name);
    for (const specifier of relativeImports(byName.get(name)!.text)) {
      const target = resolveRelative(name, specifier);
      if (target !== null && byName.has(target) && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  const rest = modules
    .map((module) => module.name)
    .filter((name) => !seen.has(name))
    .sort();
  return [...order, ...rest];
}

export type SecurityBundleSources = Readonly<{
  /** Every readable server file, in import-graph priority order, one per path. */
  files: ReadonlyArray<SecuritySourceFile>;
  /** Modules (not maps) scanned as built code. */
  noSourceMaps: number;
}>;

function isCodeModule(name: string): boolean {
  return name.endsWith('.js') || name.endsWith('.mjs') || name.endsWith('.cjs');
}

/**
 * The Worker bundle as source files. `.map` modules are read only as maps;
 * `.txt`/`.json` modules are kept as they are. Two sources with the same path
 * and different text: the later gets a `~2` (… `~n`) suffix.
 */
export function bundleSources(
  modules: ReadonlyArray<SecurityModuleFile>,
  main: string | null,
): SecurityBundleSources {
  // A map read ahead (`securityModuleFile`) carries its sources; a plain one is read here.
  const maps = new Map<string, SecurityModuleFile>();
  const code: Array<SecurityModuleFile> = [];
  for (const module of modules) {
    if (module.name.endsWith('.map')) {
      maps.set(module.name, module);
    } else {
      code.push(module);
    }
  }
  const byName = new Map(code.map((module) => [module.name, module]));
  const files: Array<SecuritySourceFile> = [];
  const byPath = new Map<string, SecuritySourceFile>();
  let noSourceMaps = 0;
  const add = (file: SecuritySourceFile) => {
    const existing = byPath.get(file.path);
    if (existing?.sha256 === file.sha256) {
      return;
    }
    let path = file.path;
    for (let suffix = 2; byPath.has(path); suffix++) {
      path = `${file.path}~${suffix}`;
    }
    const placed = { ...file, path };
    byPath.set(path, placed);
    files.push(placed);
  };
  for (const name of importGraphOrder(code, main)) {
    const module = byName.get(name)!;
    const map = isCodeModule(name) ? sourceMapFor(module, maps) : null;
    let sources: ReadonlyArray<SecurityMapSource> | null = null;
    if (map !== null && map.inline !== null) {
      sources = readSourceMap(map.name, map.inline);
    } else if (map !== null) {
      const file = maps.get(map.name)!;
      sources = file.sources !== undefined ? file.sources : readSourceMap(map.name, file.text);
    }
    if (sources && sources.length > 0) {
      for (const source of sources) {
        add({
          path: source.path,
          text: source.text,
          sha256: sha256Hex(source.text),
          module: name,
          map: map!.inline === null ? map!.name : null,
          built: false,
        });
      }
      continue;
    }
    // A facade chunk (`import "./chunk.js";`) has no code of its own to map back.
    if (isCodeModule(name) && !onlyImportsAndExports(module.text)) {
      noSourceMaps++;
    }
    add({
      path: `${SECURITY_BUILT_PREFIX}${name}`,
      text: module.text,
      sha256: module.sha256,
      module: name,
      map: null,
      built: true,
    });
  }
  return { files, noSourceMaps };
}

/**
 * Changed files in priority order. A module changed when its hash, or its source
 * map's, differs from the base's (or it is new). With a base source index, a source
 * changed when its text hash differs (or it is new) and its module changed; without
 * one, every source of a changed module counts. The module maps hold every module,
 * `.map` files too.
 */
export function changedSources(
  files: ReadonlyArray<SecuritySourceFile>,
  headModules: ReadonlyMap<string, string>,
  baseModules: ReadonlyMap<string, string>,
  baseSources: ReadonlyMap<string, string> | null,
): Array<SecuritySourceFile> {
  const changedModules = new Set<string>();
  for (const [name, sha256] of headModules) {
    if (baseModules.get(name) !== sha256) {
      changedModules.add(name);
    }
  }
  return files.filter((file) => {
    if (!changedModules.has(file.module) && (file.map === null || !changedModules.has(file.map))) {
      return false;
    }
    return baseSources === null || baseSources.get(file.path) !== file.sha256;
  });
}

export type SecurityAssetEntry = Readonly<{ path: string; hash: string; size: number }>;

function isTextAsset(path: string): boolean {
  const lower = path.toLowerCase();
  return SECURITY_TEXT_ASSET_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** Text assets (by type and size) whose hash differs from the base's, or every one with no base. */
export function changedTextAssets(
  head: ReadonlyArray<SecurityAssetEntry>,
  base: ReadonlyMap<string, string> | null,
): Array<SecurityAssetEntry> {
  return head
    .filter(
      (asset) =>
        isTextAsset(asset.path) &&
        asset.size <= SECURITY_TEXT_ASSET_MAX_BYTES &&
        !asset.path.startsWith('/.void-deploy/') &&
        (base === null || base.get(asset.path) !== asset.hash),
    )
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/**
 * M31: text assets over the read limit whose hash differs from the base's (every one
 * with no base). Too big to send, they are only searched for stored secret values.
 */
export function oversizedTextAssets(
  head: ReadonlyArray<SecurityAssetEntry>,
  base: ReadonlyMap<string, string> | null,
): Array<SecurityAssetEntry> {
  return head
    .filter(
      (asset) =>
        isTextAsset(asset.path) &&
        asset.size > SECURITY_TEXT_ASSET_MAX_BYTES &&
        !asset.path.startsWith('/.void-deploy/') &&
        (base === null || base.get(asset.path) !== asset.hash),
    )
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** An asset's path under `/scan/input`, or `null` when it has none. */
export function assetInputPath(path: string): string | null {
  const normalized = normalizeSourcePath(
    '',
    undefined,
    path.startsWith('/') ? path.slice(1) : path,
  );
  return normalized === null ? null : `${SECURITY_ASSET_PREFIX}${normalized}`;
}
