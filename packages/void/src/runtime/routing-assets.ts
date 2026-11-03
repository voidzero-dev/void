import type { DevCssAsset } from '../pages/types.ts';
import type { RuntimeEnvironment } from './routing-worker.ts';

// `c.rewrite()` cannot reach files the asset layer serves. `.html` is excluded: routes may use it.
export const ASSET_EXTENSIONS: Array<string> = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
  'ico',
  'css',
  'js',
  'mjs',
  'cjs',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'mp4',
  'webm',
  'mp3',
  'wav',
  'pdf',
  'txt',
  'xml',
  'json',
  'wasm',
  'map',
];

export type ClientAssetTags = {
  css: string;
  preloads: string;
  body: string;
  devCss?: Array<DevCssAsset>;
};
export type ClientManifest = Record<
  string,
  {
    file?: string;
    imports?: Array<string>;
    css?: Array<string>;
    /** Build-proven fingerprinted outputs; absent in older/third-party manifests. */
    immutableFiles?: Array<string>;
  }
>;
export type ManifestLoader = (
  request: Request,
  env: RuntimeEnvironment,
) => Promise<ClientManifest | null>;
export function createManifestLoader(): ManifestLoader {
  let cached: ClientManifest | null = null;
  let pending: Promise<ClientManifest | null> | null = null;
  return async (request, env) => {
    if (cached) {
      return cached;
    }
    const injected = (globalThis as typeof globalThis & { __VITE_MANIFEST__?: unknown })
      .__VITE_MANIFEST__;
    if (typeof injected === 'object' && injected) {
      cached = injected as ClientManifest;
      return cached;
    }
    const assets = env?.ASSETS;
    if (!assets || typeof assets.fetch !== 'function') {
      return null;
    }
    // Concurrent cold requests share one fetch and parse. A missing or failed
    // manifest is not cached, so a later request retries.
    pending ??= (async () => {
      const response = await assets.fetch(
        new Request(new URL('/.vite/manifest.json', request.url).toString()),
      );
      if (!response.ok) {
        return null;
      }
      cached = (await response.json()) as ClientManifest;
      return cached;
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
}
export type ClientAssetOptions = {
  entryId: string;
  entryUrl: string;
  extraEntryId?: string;
  extraEntryUrl?: string;
  pageCssKeys?: Record<string, Array<string>>;
  devRootPhases?: Record<string, Array<Array<string>>>;
  kind: 'ssr' | 'pages' | 'islands';
  dev?: boolean;
  reactRefresh?: boolean;
  devCss?: (
    request: Request,
    env: RuntimeEnvironment,
    options: { kind: 'pages' | 'islands'; componentId: string; rootPhases: Array<Array<string>> },
  ) => Promise<unknown>;
};
const BINDING_HINT_SCRIPT = '<script type="module" src="/@id/virtual:void/binding-hint"></script>';
const REACT_REFRESH_SCRIPT = `<script type="module">
import RefreshRuntime from "/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script>`;
const escapeAttribute = (value: string): string => String(value).replace(/"/g, '&quot;');
const script = (url: string): string =>
  `<script type="module" src="${escapeAttribute(url)}"></script>`;
function collectManifestFiles(
  manifest: ClientManifest,
  entryId: string,
  depthFirst: boolean,
): Array<string> {
  const seen = new Set<string>();
  const pending = [entryId];
  for (let index = 0; depthFirst ? pending.length > 0 : index < pending.length;) {
    const id = depthFirst ? pending.pop()! : pending[index++];
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const imports = manifest[id]?.imports;
    if (Array.isArray(imports)) {
      pending.push(...imports);
    }
  }
  return [...seen];
}
function collectRouteCss(manifest: ClientManifest, roots: Array<string>): Set<string> {
  const css = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) {
      return;
    }
    visited.add(id);
    const chunk = manifest[id];
    if (!chunk) {
      return;
    }
    if (Array.isArray(chunk.css)) {
      for (const file of chunk.css) {
        css.add(file);
      }
    }
    if (Array.isArray(chunk.imports)) {
      for (const imported of chunk.imports) {
        visit(imported);
      }
    }
  };
  for (const root of roots) {
    visit(root);
  }
  return css;
}
/** Frameworks supply only client entry IDs and active layout/page roots. */
export function createClientAssetTags(
  options: ClientAssetOptions,
  loadManifest: ManifestLoader = createManifestLoader(),
): (request: Request, env: RuntimeEnvironment, componentId?: string) => Promise<ClientAssetTags> {
  return async (request, env, componentId = '') => {
    const empty = { css: '', preloads: '', body: '' };
    const manifest = await loadManifest(request, env);
    if (!manifest || typeof manifest !== 'object') {
      if (!options.dev) {
        return empty;
      }
      const preloads = [script('/@vite/client'), BINDING_HINT_SCRIPT];
      if (options.kind === 'ssr' && options.reactRefresh) {
        preloads.push(REACT_REFRESH_SCRIPT);
      }
      let body = script(options.entryUrl);
      if (options.extraEntryUrl) {
        body += '\n' + script(options.extraEntryUrl);
      }
      const tags: ClientAssetTags = { css: '', preloads: preloads.join('\n'), body };
      if (options.devCss && options.kind !== 'ssr') {
        const css = await options.devCss(request, env, {
          kind: options.kind,
          componentId,
          rootPhases: options.devRootPhases?.[componentId] || [[options.entryUrl]],
        });
        tags.devCss = Array.isArray(css) ? (css as Array<DevCssAsset>) : [];
      }
      return tags;
    }
    const entry = manifest[options.entryId];
    if (!entry || typeof entry !== 'object' || typeof entry.file !== 'string') {
      return empty;
    }
    const ids = collectManifestFiles(manifest, options.entryId, options.kind === 'ssr');
    const extraEntry = options.extraEntryId ? manifest[options.extraEntryId] : undefined;
    const hasExtra = extraEntry && typeof extraEntry.file === 'string';
    if (hasExtra) {
      ids.push(...collectManifestFiles(manifest, options.extraEntryId!, false));
    }
    const css =
      options.kind === 'ssr'
        ? new Set<string>()
        : collectRouteCss(manifest, [
            options.entryId,
            ...(options.pageCssKeys?.[componentId] ?? []),
          ]);
    if (hasExtra) {
      for (const file of collectRouteCss(manifest, [options.extraEntryId!])) {
        css.add(file);
      }
    }
    const preloads = new Set<string>();
    for (const id of ids) {
      const chunk = manifest[id];
      if (!chunk || typeof chunk !== 'object') {
        continue;
      }
      if (options.kind === 'ssr' && Array.isArray(chunk.css)) {
        for (const file of chunk.css) {
          css.add(file);
        }
      }
      if (id !== options.entryId && id !== options.extraEntryId && typeof chunk.file === 'string') {
        preloads.add(chunk.file);
      }
    }
    let body = script('/' + entry.file);
    if (hasExtra) {
      body += '\n' + script('/' + extraEntry.file!);
    }
    return {
      css: [...css]
        .map((file) => `<link rel="stylesheet" href="/${escapeAttribute(file)}">`)
        .join('\n'),
      preloads: [...preloads]
        .map((file) => `<link rel="modulepreload" href="/${escapeAttribute(file)}">`)
        .join('\n'),
      body,
    };
  };
}
