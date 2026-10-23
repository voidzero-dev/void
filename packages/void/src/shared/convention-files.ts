import { globSync } from 'tinyglobby';
import { ROUTE_EXTENSIONS } from './route-extensions.ts';

function isConventionPath(filePath: string): boolean {
  return filePath
    .replace(/\\/g, '/')
    .split('/')
    .every(
      (segment, index) =>
        !segment.startsWith('_') &&
        (!segment.startsWith('.') || (index === 0 && segment === '.well-known')),
    );
}

/** Whether a path relative to routes/ participates in HTTP or WebSocket routing. */
export function isRouteFile(filePath: string): boolean {
  return isConventionPath(filePath) && ROUTE_EXTENSIONS.some((ext) => filePath.endsWith(`.${ext}`));
}

/** Handler files under `dir`, relative to it, skipping paths with a `_`-prefixed segment. */
function listFilesWithExtensions(dir: string, extensions: ReadonlyArray<string>): Array<string> {
  const suffix = `*.{${extensions.join(',')}}`;
  return globSync([`**/${suffix}`, `.well-known/**/${suffix}`], {
    cwd: dir,
  }).filter(isConventionPath);
}

export function listConventionFiles(dir: string): Array<string> {
  return listFilesWithExtensions(dir, ['ts', 'mts', 'js', 'mjs']);
}

export function listRouteFiles(dir: string): Array<string> {
  return listFilesWithExtensions(dir, ROUTE_EXTENSIONS);
}
