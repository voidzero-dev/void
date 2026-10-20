import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'pathslash';
import { resolvePlatformSourceRevision } from './source-revision.mjs';

// Records the source revision in the manifest that scripts/build-runtime.mjs wrote, so a new
// revision reruns only this step and not the cached runtime build.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = join(packageRoot, '..', '..');
const manifestPath = join(packageRoot, 'dist', 'runtime', 'manifest.json');
const { parsePlatformRuntimeManifest } = await import(
  pathToFileURL(join(packageRoot, 'dist', 'installer.mjs')).href
);

const manifest = parsePlatformRuntimeManifest({
  ...JSON.parse(readFileSync(manifestPath, 'utf8')),
  sourceRevision: resolvePlatformSourceRevision({ repositoryRoot }),
});
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
