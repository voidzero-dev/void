import { globSync } from 'tinyglobby';
import { ROUTE_EXTENSIONS } from '../router/parse-filename.ts';

/** Handler files under `dir`, relative to it, skipping paths with a `_`-prefixed segment. */
function listFilesWithExtensions(dir: string, extensions: ReadonlyArray<string>): Array<string> {
  const suffix = `*.{${extensions.join(',')}}`;
  return globSync([`**/${suffix}`, `.well-known/**/${suffix}`], {
    cwd: dir,
  }).filter((filePath) => !filePath.split('/').some((segment) => segment.startsWith('_')));
}

export function listConventionFiles(dir: string): Array<string> {
  return listFilesWithExtensions(dir, ['ts', 'mts', 'js', 'mjs']);
}

export function listRouteFiles(dir: string): Array<string> {
  return listFilesWithExtensions(dir, ROUTE_EXTENSIONS);
}
