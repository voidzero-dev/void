import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const UNAVAILABLE_VOID_VERSIONS = new Set([
  '0.0.1',
  '0.1.0',
  '0.1.2',
  '0.1.3',
  '0.1.5',
  '0.1.6',
  '1.0.0',
  '1.0.1',
  '1.0.2',
  '3.0.0',
  '3.0.1',
]);

export function releasePolicy(
  tag: string,
  packages: ReadonlyArray<{ name: string; version: string }>,
): { version: string; npmTag: string } {
  // Retry metadata identifies a Git release attempt, not a new npm version.
  // Keep real prereleases in the captured version and in channel selection.
  const match =
    /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?)(?:\+retry\.[1-9]\d*)?$/.exec(
      tag,
    );
  if (!match || match[0] !== tag || match[2]?.split('.').some((part) => /^0\d+$/.test(part))) {
    throw new Error(
      'Release tags must be v followed by an exact semantic version, optionally ending in +retry.N (N is a positive integer).',
    );
  }
  const version = match[1];
  if (UNAVAILABLE_VOID_VERSIONS.has(version)) {
    throw new Error(`void@${version} was previously unpublished and cannot be reused.`);
  }
  if (!packages.some((pkg) => pkg.name === 'void')) {
    throw new Error('The release must include the public void package.');
  }
  for (const pkg of packages) {
    if (pkg.version !== version) {
      throw new Error(
        `${pkg.name}@${pkg.version} does not match release ${tag}. Retry tags use +retry.N; the base version must still match every package.`,
      );
    }
  }
  const prefix = match[2]?.split('.')[0];
  const npmTag = prefix
    ? /^[a-z][a-z0-9-]*$/.test(prefix) && prefix !== 'latest'
      ? prefix
      : 'next'
    : 'latest';
  return { version, npmTag };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = new URL('../../packages/', import.meta.url);
  const packages = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap(({ name }) => {
      const manifest = JSON.parse(
        readFileSync(new URL(`${encodeURIComponent(name)}/package.json`, root), 'utf8'),
      ) as { private?: boolean; name: string; version: string };
      return manifest.private ? [] : [{ name: manifest.name, version: manifest.version }];
    });
  const result = releasePolicy(process.env.GITHUB_REF_NAME ?? '', packages);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${result.version}\nnpm-tag=${result.npmTag}\n`,
    );
  }
  console.log(
    `Validated ${packages.length} packages at ${result.version}; npm tag: ${result.npmTag}.`,
  );
}
