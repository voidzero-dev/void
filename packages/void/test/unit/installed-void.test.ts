import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { getPackageDir } from '../../src/cli/agents.ts';
import { assertInstalledVoidMatchesCli } from '../../src/cli/installed-void.ts';

let root: string;
const cliVersion = (
  JSON.parse(readFileSync(join(getPackageDir(), 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

function project(installedVersion?: string | 'linked'): void {
  root = mkdtempSync(join(tmpdir(), 'void-installed-plugin-version-test-'));
  writeFileSync(join(root, 'package.json'), '{"dependencies":{"void":"^0.20.0"}}');
  if (installedVersion) {
    const packageRoot = join(root, 'node_modules', 'void');
    if (installedVersion === 'linked') {
      mkdirSync(join(root, 'node_modules'), { recursive: true });
      symlinkSync(getPackageDir(), packageRoot, 'dir');
      return;
    }
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'void', version: installedVersion, main: './dist/index.mjs' }),
    );
    writeFileSync(join(packageRoot, 'dist', 'index.mjs'), 'export default {};\n');
  }
}

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('assertInstalledVoidMatchesCli', () => {
  it('accepts the same installed CLI and plugin version', () => {
    project('linked');
    expect(() => assertInstalledVoidMatchesCli(root)).not.toThrow();
  });

  it('stops different development builds with the same version', () => {
    project(cliVersion);
    expect(() => assertInstalledVoidMatchesCli(root)).toThrow('different Void builds');
  });

  it('stops a newer global CLI before an older project plugin can build', () => {
    project('0.20.0');
    expect(() => assertInstalledVoidMatchesCli(root)).toThrow(
      `this CLI is void@${cliVersion}, but the project's installed Vite plugin is void@0.20.0`,
    );
  });

  it('reports a declared but uninstalled project package', () => {
    project();
    // Vitest resolves missing bare imports through the workspace. Check the
    // missing-package case with Node's actual project-relative resolver.
    const source = new URL('../../src/cli/installed-void.ts', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { assertInstalledVoidMatchesCli } from ${JSON.stringify(source)}; assertInstalledVoidMatchesCli(process.argv[1]);`,
        root,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
        timeout: 10_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('installed Vite plugin is missing');
  });
});
