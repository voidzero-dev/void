import { mkdirSync, writeFileSync } from 'node:fs';
import { extractPageDataFromHtml } from '@void/isr/core';
import { dirname, isAbsolute, join, relative } from 'pathslash';

const PAGE_DATA_SCRIPT_ID = '__VOID_PAGE_DATA__';

export type PrerenderResult = {
  rendered: Array<string>;
  failed: Array<{ path: string; error: string }>;
};

export function assertNoPrerenderFailures(failed: PrerenderResult['failed']): void {
  if (failed.length === 0) {
    return;
  }
  const details = failed.map(({ path, error }) => `  ${path}: ${error}`).join('\n');
  throw new Error(`${failed.length} page(s) failed to prerender:\n${details}`);
}

/**
 * Static file server that will serve the prerendered files. Hosts decode the
 * request path before the file lookup, so files are written decoded:
 * Cloudflare assets decode each segment with decodeURIComponent, and Hono's
 * serveStatic (Node, Bun, Deno) uses decodeURI, which keeps reserved
 * characters such as %23 and %3F encoded.
 */
export type PrerenderHost = 'cloudflare' | 'node';

function tryDecode(value: string, decode: (value: string) => string): string {
  try {
    return decode(value);
  } catch {
    return value;
  }
}

function filePathForPath(path: string, host: PrerenderHost): string {
  return host === 'node'
    ? tryDecode(path, decodeURI)
    : path
        .split('/')
        .map((segment) => tryDecode(segment, decodeURIComponent))
        .join('/');
}

export function outputFileForPath(path: string, host: PrerenderHost = 'cloudflare'): string {
  if (path === '/404/') {
    return '404.html';
  }
  if (path.endsWith('/')) {
    return `${filePathForPath(path, host).slice(1)}index.html`;
  }
  return path === '/' ? 'index.html' : `${filePathForPath(path, host).slice(1)}.html`;
}

export async function readPrerenderPathsResponse(response: Response): Promise<Array<string>> {
  if (!response.ok) {
    // The app returns getPrerenderPaths() errors as { error }.
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const detail = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}.`;
    throw new Error(`prerender: Failed to collect prerender paths. ${detail}`);
  }

  const payload = (await response.json()) as { paths?: unknown } | null;
  if (
    !payload ||
    !Array.isArray(payload.paths) ||
    !payload.paths.every((path) => typeof path === 'string')
  ) {
    throw new Error('prerender: Failed to collect prerender paths. Response payload is invalid.');
  }

  return payload.paths;
}

function pageDataFileForPath(path: string, host: PrerenderHost): string {
  return path === '/'
    ? '_void/pages/index.json'
    : `_void/pages/${filePathForPath(path, host).slice(1)}${path.endsWith('/') ? 'index' : ''}.json`;
}

/** Whether `path` resolves strictly inside `directory`. */
function isInside(directory: string, path: string): boolean {
  const child = relative(directory, path);
  return child !== '' && child !== '..' && !child.startsWith('../') && !isAbsolute(child);
}

function normalizedFile(clientDir: string, path: string): string {
  return join(clientDir, path).normalize('NFC').toLowerCase();
}

function generatedFiles(path: string, clientDir: string, host: PrerenderHost): Array<string> {
  return [outputFileForPath(path, host), pageDataFileForPath(path, host)].map((file) =>
    normalizedFile(clientDir, file),
  );
}

function requestAssetCandidates(path: string, clientDir: string): Set<string> {
  const relativePath = path === '/' ? '' : path.slice(1);
  const candidates = new Set<string>();
  const addCandidates = (candidate: string) => {
    candidates.add(candidate);
    if (candidate === '' || candidate.endsWith('/')) {
      candidates.add(`${candidate}index.html`);
    } else if (!candidate.split('/').at(-1)?.includes('.')) {
      // Cloudflare's HTML handling can resolve an extension-less document to
      // either foo.html or foo/index.html. The Node asset provider also resolves
      // an existing directory to its index.html.
      candidates.add(`${candidate}.html`);
      candidates.add(`${candidate}/index.html`);
    }
  };
  addCandidates(relativePath);
  try {
    addCandidates(decodeURI(relativePath));
  } catch {
    // The asset provider will reject malformed escapes; the raw candidate is enough.
  }
  try {
    // Asset lookup may also decode reserved filename characters such as %23.
    // This is only an ordering guard, so an extra serial fallback is safe.
    addCandidates(decodeURIComponent(relativePath));
  } catch {
    // The asset provider will reject malformed escapes; the raw candidate is enough.
  }
  return new Set([...candidates].map((file) => normalizedFile(clientDir, file)));
}

function renderConcurrency(
  paths: ReadonlyArray<string>,
  clientDir: string,
  host: PrerenderHost,
): number {
  const outputs = paths.map((path) => generatedFiles(path, clientDir, host));
  const ownerByOutput = new Map<string, number>();
  for (let index = 0; index < outputs.length; index++) {
    for (const output of outputs[index]!) {
      if (ownerByOutput.has(output)) {
        return 1;
      }
      ownerByOutput.set(output, index);
    }
  }
  // Preserve serial behavior for file/directory collisions. Case folding also
  // covers case-insensitive disks.
  for (const file of ownerByOutput.keys()) {
    let parent = dirname(file);
    while (parent !== dirname(parent)) {
      if (ownerByOutput.has(parent)) {
        return 1;
      }
      parent = dirname(parent);
    }
  }
  // A generated file can change a different render's asset fallback. Run the
  // original serial order for the whole list when either request could observe
  // the other's output, including canonical foo.html/foo/index.html lookups.
  for (let index = 0; index < paths.length; index++) {
    for (const candidate of requestAssetCandidates(paths[index]!, clientDir)) {
      const owner = ownerByOutput.get(candidate);
      if (owner !== undefined && owner !== index) {
        return 1;
      }
    }
  }
  return 4;
}

/** Shared renderer for local Workers and the isolated Node prerender child. */
export async function renderPrerenderPaths(
  paths: Array<string>,
  clientDir: string,
  fetchPath: (path: string) => Promise<Response>,
  fetchPageData?: (path: string) => Promise<Response>,
  onResult?: (path: string, outputFile: string, error?: string) => void,
  host: PrerenderHost = 'cloudflare',
): Promise<PrerenderResult> {
  const results = paths.map((): PrerenderResult => ({ rendered: [], failed: [] }));
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(paths.length, renderConcurrency(paths, clientDir, host)) },
      async () => {
        while (next < paths.length) {
          const index = next++;
          const path = paths[index]!;
          const result = results[index]!;
          const outputFile = outputFileForPath(path, host);
          const outputPath = join(clientDir, outputFile);
          const pageDataPath = join(clientDir, pageDataFileForPath(path, host));
          // Paths come from getPrerenderPaths and may include unencoded user data
          // such as '../', which must not write files outside the output directory.
          if (
            !isInside(clientDir, outputPath) ||
            !isInside(join(clientDir, '_void/pages'), pageDataPath)
          ) {
            const error = 'prerender path resolves outside the output directory';
            result.failed.push({ path, error });
            onResult?.(path, outputFile, error);
            continue;
          }
          try {
            const response = await fetchPath(path);
            const html = await response.text();
            // Redirects are served by routing and have no HTML or page data to emit.
            if (
              [301, 302, 303, 307, 308].includes(response.status) &&
              response.headers.get('Location')
            ) {
              continue;
            }
            if (!response.ok) {
              const error = `HTTP ${response.status}`;
              result.failed.push({ path, error });
              onResult?.(path, outputFile, error);
              continue;
            }
            mkdirSync(dirname(outputPath), { recursive: true });
            writeFileSync(outputPath, html);
            // Reuse the page object the HTML embeds for hydration, re-stringified to drop
            // the \u003c-style escapes. Deferred props embed unresolved, so those pages
            // still make the X-VoidPages request. HTML without the script gets no JSON.
            const embeddedPageData = extractPageDataFromHtml(html);
            let pageData: unknown;
            if (embeddedPageData !== null) {
              pageData = JSON.parse(embeddedPageData);
            } else if (fetchPageData && html.includes(PAGE_DATA_SCRIPT_ID)) {
              const pageDataResponse = await fetchPageData(path);
              if (pageDataResponse.headers.get('X-VoidPages')) {
                pageData = await pageDataResponse.json();
              }
            }
            if (pageData !== undefined) {
              mkdirSync(dirname(pageDataPath), { recursive: true });
              writeFileSync(pageDataPath, JSON.stringify(pageData));
            }
            result.rendered.push(path);
            onResult?.(path, outputFile);
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            result.failed.push({ path, error });
            onResult?.(path, outputFile, error);
          }
        }
      },
    ),
  );
  return {
    rendered: results.flatMap((result) => result.rendered),
    failed: results.flatMap((result) => result.failed),
  };
}
