import { join, relative } from 'pathslash';
import { globSync } from 'tinyglobby';
import { ROUTE_EXTENSIONS } from './route-extensions.ts';

const WELL_KNOWN_DIR = '.well-known';

/** Include the convention directory's .well-known files when it is inside the scan directory. */
export function conventionFileGlobs(
  scanDir: string,
  pattern: string,
  conventionDir: string = scanDir,
): Array<string> {
  const patterns = [pattern];
  const conventionRelative = relative(scanDir, conventionDir);
  if (conventionRelative !== '..' && !conventionRelative.startsWith('../')) {
    patterns.push(join(conventionRelative, WELL_KNOWN_DIR, pattern));
  }
  return patterns;
}

function isConventionPath(filePath: string): boolean {
  return filePath
    .replace(/\\/g, '/')
    .split('/')
    .every(
      (segment, index) =>
        !segment.startsWith('_') &&
        (!segment.startsWith('.') || (index === 0 && segment === WELL_KNOWN_DIR)),
    );
}

/** Whether a path relative to routes/ participates in HTTP or WebSocket routing. */
export function isRouteFile(filePath: string): boolean {
  return isConventionPath(filePath) && ROUTE_EXTENSIONS.some((ext) => filePath.endsWith(`.${ext}`));
}

/** Handler files under `dir`, relative to it, skipping paths with a `_`-prefixed segment. */
function listFilesWithExtensions(dir: string, extensions: ReadonlyArray<string>): Array<string> {
  const suffix = `*.{${extensions.join(',')}}`;
  return globSync(conventionFileGlobs(dir, `**/${suffix}`), {
    cwd: dir,
  }).filter(isConventionPath);
}

/** Cron and queue handlers with .ts, .mts, .js, or .mjs extensions. */
export function listConventionFiles(dir: string): Array<string> {
  return listFilesWithExtensions(dir, ['ts', 'mts', 'js', 'mjs']);
}

/** HTTP and WebSocket handlers, also allowing .tsx and .jsx for JSX. */
export function listRouteFiles(dir: string): Array<string> {
  return listFilesWithExtensions(dir, ROUTE_EXTENSIONS);
}
