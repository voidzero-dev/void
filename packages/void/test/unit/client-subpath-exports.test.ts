import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

describe('client package exports', () => {
  it('publishes framework-specific client subpaths', () => {
    const packageJson = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../package.json'), 'utf-8'),
    );

    for (const framework of ['react', 'vue', 'svelte', 'solid']) {
      expect(packageJson.exports[`./client/${framework}`]).toEqual({
        import: `./dist/runtime/client/${framework}.mjs`,
        require: `./dist/runtime/client/${framework}.mjs`,
        types: `./dist/runtime/client/${framework}.d.mts`,
      });
    }
  });
});
