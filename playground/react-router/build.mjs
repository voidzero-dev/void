import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifest = new URL(import.meta.resolve('@react-router/dev/package.json'));
const { bin } = JSON.parse(readFileSync(manifest, 'utf8'));
const reactRouter = fileURLToPath(new URL(bin['react-router'], manifest));

// Type generation and the build both write framework configuration. Cache their final output
// as one task so restoring the earlier stage cannot overwrite the completed build's files.
for (const args of [
  [reactRouter, 'typegen'],
  [reactRouter, 'build', ...process.argv.slice(2)],
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
