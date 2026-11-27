import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest } from 'vite';
import { expect, it } from 'vite-plus/test';
import { createIsolatedPlayground } from '../../../../test/integration-helpers.ts';

const workspace = join(import.meta.dirname, '../../../..');

it('builds a custom Worker entry named pages-client with shared plugins', () => {
  const fixture = createIsolatedPlayground(workspace, 'playground/react-pages');
  try {
    writeFileSync(join(fixture.root, 'custom-entry.js'), 'console.log("custom Worker entry");');
    writeFileSync(
      join(fixture.root, 'vite.config.ts'),
      `
import { voidReact } from '@void/react/plugin';
import { voidPlugin } from 'void';

export default {
  plugins: [voidPlugin(), voidReact()],
  builder: { sharedPlugins: true },
  environments: {
    void_worker: {
      build: { rollupOptions: { input: { 'pages-client': './custom-entry.js' } } },
    },
  },
};
`,
    );
    execFileSync('vp', ['run', 'build'], { cwd: fixture.root, stdio: 'pipe' });

    const worker = JSON.parse(
      readFileSync(join(fixture.root, 'dist/ssr/.vite/manifest.json'), 'utf8'),
    ) as Manifest;
    expect(worker['custom-entry.js']).toMatchObject({ file: 'pages-client.js', isEntry: true });
  } finally {
    fixture.cleanup();
  }
});
