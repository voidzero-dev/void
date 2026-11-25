import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuilder } from 'vite';
import type { Plugin } from 'vite';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { voidPlugin } from '../../src/index.ts';

const roots: Array<string> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// pnpm installs Vite once per set of peers, so the Vite that runs a build can differ from the one
// the Cloudflare plugin imports. Rolldown then skips the Cloudflare plugin's esmExternalRequirePlugin,
// as this plugin does.
const skipCloudflareRequireConversion: Plugin = {
  name: 'test:skip-cloudflare-require-conversion',
  configResolved(config) {
    for (const environment of Object.values(config.environments)) {
      const options = environment.build.rolldownOptions;
      if (Array.isArray(options.plugins)) {
        options.plugins = options.plugins.filter(
          (plugin) =>
            !(plugin && 'name' in plugin && plugin.name === 'builtin:esm-external-require'),
        );
      }
    }
  },
};

it('serves the Node built-ins that CommonJS requires in a MySQL Worker build from imports', async () => {
  // Windows runners report a short-name temp path, which Vite refuses to serve.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'void-worker-require-')));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify({ database: 'mysql', worker: { compatibility_date: '2026-02-24' } }),
  );
  // mysql2 requires node:buffer like this.
  mkdirSync(join(root, 'lib'));
  writeFileSync(
    join(root, 'lib/size.cjs'),
    "exports.size = (text) => require('node:buffer').Buffer.byteLength(text);\n",
  );
  mkdirSync(join(root, 'routes/api'), { recursive: true });
  writeFileSync(
    join(root, 'routes/api/size.ts'),
    "import { size } from '../../lib/size.cjs';\nexport const GET = () => Response.json({ size: size('void') });\n",
  );
  vi.spyOn(process, 'cwd').mockReturnValue(root);

  const builder = await createBuilder(
    {
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [voidPlugin(), skipCloudflareRequireConversion],
    },
    null,
  );
  await builder.buildApp();

  const output = join(root, 'dist/ssr');
  const code = readdirSync(output, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('.js'))
    .map((file) => readFileSync(join(output, file), 'utf8'))
    .join('\n');
  // workerd has no `require`, so this call would throw when the route runs.
  expect(code).not.toContain('__require("node:buffer")');
  expect(code).toMatch(/^import \w+ from "node:buffer";$/m);
});
