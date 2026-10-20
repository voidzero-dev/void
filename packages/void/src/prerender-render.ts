import { mkdirSync, writeFileSync } from 'node:fs';
import { extractPageDataFromHtml } from '@void/isr/core';
import { dirname, isAbsolute, join, relative } from 'pathslash';

const PAGE_DATA_SCRIPT_ID = '__VOID_PAGE_DATA__';

export type PrerenderResult = {
  rendered: Array<string>;
  failed: Array<{ path: string; error: string }>;
};

export function outputFileForPath(path: string): string {
  return path === '/' ? 'index.html' : `${path.slice(1)}.html`;
}

export async function readPrerenderPathsResponse(response: Response): Promise<Array<string>> {
  if (!response.ok) {
    throw new Error(`prerender: Failed to collect prerender paths. HTTP ${response.status}.`);
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

function pageDataFileForPath(path: string): string {
  return path === '/' ? '_void/pages/index.json' : `_void/pages/${path.slice(1)}.json`;
}

/** Whether `path` resolves strictly inside `directory`. */
function isInside(directory: string, path: string): boolean {
  const child = relative(directory, path);
  return child !== '' && child !== '..' && !child.startsWith('../') && !isAbsolute(child);
}

function normalizedFile(clientDir: string, path: string): string {
  return join(clientDir, path).normalize('NFC').toLowerCase();
}

function generatedFiles(path: string, clientDir: string): Array<string> {
  return [outputFileForPath(path), pageDataFileForPath(path)].map((file) =>
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

function renderConcurrency(paths: ReadonlyArray<string>, clientDir: string): number {
  const outputs = paths.map((path) => generatedFiles(path, clientDir));
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
): Promise<PrerenderResult> {
  const results = paths.map((): PrerenderResult => ({ rendered: [], failed: [] }));
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(paths.length, renderConcurrency(paths, clientDir)) },
      async () => {
        while (next < paths.length) {
          const index = next++;
          const path = paths[index]!;
          const result = results[index]!;
          const outputFile = outputFileForPath(path);
          const outputPath = join(clientDir, outputFile);
          const pageDataPath = join(clientDir, pageDataFileForPath(path));
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
