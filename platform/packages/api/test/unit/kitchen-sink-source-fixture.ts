import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageFixturePath } from '../../../../../test/fixture-dir.ts';

/** Transform actual playground source without needing generated playground types. */
export function kitchenSinkSourceFixture(files: Array<string>) {
  const workspace = fileURLToPath(new URL('../../../../../', import.meta.url));
  // Stay under the API package so the public Void imports resolve through its
  // installed workspace dependency, including on a package-only CI build.
  const root = mkdtempSync(packageFixturePath(import.meta.dirname, '.tmp-kitchen-sink-source-'));
  try {
    // Keep runtime tests independent of the app's build-generated .void config.
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    for (const file of files) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(workspace, 'playground/kitchen-sink', file), target);
    }
    return {
      root,
      cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
