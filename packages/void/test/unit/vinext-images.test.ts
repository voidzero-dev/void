import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  detectVinextImagesOptimizer,
  detectVinextImagesOptimizerInSource,
} from '../../src/inference/vinext-images.ts';

const MODULE = '@vinext/cloudflare/images/images-optimizer';

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('detectVinextImagesOptimizerInSource', () => {
  it.each<[string, string]>([
    [
      `import { imagesOptimizer } from '${MODULE}';\nvinext({ images: { optimizer: imagesOptimizer() } });`,
      'IMAGES',
    ],
    [`import { imagesOptimizer } from '${MODULE}';\nimagesOptimizer({});`, 'IMAGES'],
    [
      `import { imagesOptimizer } from '${MODULE}';\nimagesOptimizer({ binding: 'PHOTOS' });`,
      'PHOTOS',
    ],
    [
      `import { imagesOptimizer } from '${MODULE}';\nimagesOptimizer({ 'binding': "PHOTOS" });`,
      'PHOTOS',
    ],
    [
      `import { imagesOptimizer } from '${MODULE}';\nimagesOptimizer({ binding: \`PHOTOS\` });`,
      'PHOTOS',
    ],
    [`import { imagesOptimizer as cf } from '${MODULE}';\ncf({ binding: 'MEDIA' });`, 'MEDIA'],
    [
      `import * as images from '${MODULE}';\nimages.imagesOptimizer({ binding: 'MEDIA' });`,
      'MEDIA',
    ],
    // A non-literal name cannot be read statically; vinext's default applies.
    [`import { imagesOptimizer } from '${MODULE}';\nimagesOptimizer({ binding: name });`, 'IMAGES'],
    [`import { imagesOptimizer } from '${MODULE}';\nimagesOptimizer(options);`, 'IMAGES'],
  ])('detects %s', (code, binding) => {
    expect(detectVinextImagesOptimizerInSource(code, 'vite.config.ts')).toEqual({ binding });
  });

  it.each([
    'import vinext from "vinext";\nvinext();',
    `import { imagesOptimizer } from '${MODULE}';`,
    `import type { imagesOptimizer } from '${MODULE}';\nimagesOptimizer();`,
    `import { imagesOptimizer } from './local-optimizer';\nimagesOptimizer();`,
    `// import { imagesOptimizer } from '${MODULE}';\nimagesOptimizer();`,
    `import * as images from '${MODULE}';\nimages.other({ binding: 'MEDIA' });`,
    `import { imagesOptimizer } from '${MODULE}';\nimagesOptimizer();\nnot { valid`,
  ])('ignores %s', (code) => {
    expect(detectVinextImagesOptimizerInSource(code, 'vite.config.ts')).toBeUndefined();
  });
});

describe('detectVinextImagesOptimizer', () => {
  function project(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'void-vinext-images-'));
    roots.push(root);
    for (const [file, code] of Object.entries(files)) {
      writeFileSync(join(root, file), code);
    }
    return root;
  }

  it('reads the project Vite config', () => {
    const root = project({
      'vite.config.mts': `import { imagesOptimizer } from '${MODULE}';\nimagesOptimizer({ binding: 'PHOTOS' });`,
    });
    expect(detectVinextImagesOptimizer(root)).toEqual({ binding: 'PHOTOS' });
  });

  it('reads only the Vite config Vite would load first', () => {
    const root = project({
      'vite.config.ts': 'export default {};',
      'vite.config.js': `import { imagesOptimizer } from '${MODULE}';\nimagesOptimizer();`,
    });
    expect(detectVinextImagesOptimizer(root)).toBeUndefined();
  });

  it('returns undefined without a Vite config', () => {
    expect(detectVinextImagesOptimizer(project({}))).toBeUndefined();
  });
});
