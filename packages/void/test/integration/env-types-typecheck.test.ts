import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { generateEnvTypes } from '../../src/codegen/env-types.ts';

const workspaceRoot = join(import.meta.dirname, '..', '..', '..', '..');
const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('generated env types in a consumer project', () => {
  // `wrangler types` declares an assets binding as `ASSETS: Fetcher`, which must merge with Void's.
  it.each([
    ['', ''],
    [
      ' next to wrangler types output',
      'declare global { namespace Cloudflare { interface Env { ASSETS: Fetcher } } }\n',
    ],
  ])('types schema keys and ASSETS on both env and handler c.env%s', (_, wranglerTypes) => {
    // This nested fixture resolves the workspace's installed void package just
    // as a consumer does, while keeping its source out of the playground routes.
    const root = mkdtempSync(join(workspaceRoot, 'playground/kitchen-sink/.tmp-env-types-'));
    roots.push(root);
    const envFile = join(root, 'env.ts');
    const outDir = join(root, '.void');
    mkdirSync(outDir);
    writeFileSync(
      envFile,
      'import { defineEnv, string } from "void/env";\n' +
        'export default defineEnv({ API_SECRET: string() });\n',
    );
    writeFileSync(join(outDir, 'env.d.ts'), generateEnvTypes(envFile, outDir).dts);
    writeFileSync(
      join(root, 'handler.ts'),
      'import { defineHandler } from "void";\n' +
        'import { env } from "void/env";\n' +
        'const direct: string = env.API_SECRET;\n' +
        'export const GET = defineHandler((c) => c.text(direct + c.env.API_SECRET.toUpperCase()));\n' +
        'export const POST = defineHandler((c) => c.env.ASSETS.fetch(c.req.raw));\n' +
        '// @ts-expect-error Node, Bun and Deno targets fetch assets only by Request.\n' +
        'export const PUT = defineHandler((c) => c.env.ASSETS.fetch("/logo.png"));\n' +
        'export const fetchAsset = (bindings: Cloudflare.Env) => bindings.ASSETS.fetch("https://app.test/");\n' +
        wranglerTypes,
    );
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        files: ['env.ts', '.void/env.d.ts', 'handler.ts'],
      }),
    );

    const result = spawnSync(
      process.execPath,
      [join(workspaceRoot, 'node_modules/typescript/lib/tsc.js'), '--project', root],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
