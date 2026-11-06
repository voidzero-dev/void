import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..');
const CLI_ENTRY = join(PACKAGE_ROOT, 'dist', 'cli', 'cli.mjs');
const VERSION = (
  JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'void-cli-runtime-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Runs the built bin with `process.versions` replaced before any CLI module loads. */
function runWithVersions(versions: Record<string, string> | null, args: Array<string>) {
  const execArgv: Array<string> = [];
  if (versions) {
    const preload = join(root, `versions-${Object.values(versions).join('-')}.mjs`);
    writeFileSync(
      preload,
      `Object.defineProperty(process, 'versions', {
  value: { ...process.versions, ...${JSON.stringify(versions)} },
});\n`,
    );
    execArgv.push('--import', pathToFileURL(preload).href);
  }
  return spawnSync(process.execPath, [...execArgv, CLI_ENTRY, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root },
  });
}

describe('void runtime check (built bin)', () => {
  it('stops on an unsupported Node before the CLI loads', () => {
    const result = runWithVersions({ node: '22.23.4' }, ['--version']);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `void: Node.js 24.22+ or 26.12+ is required. Found Node.js v22.23.4 (${process.execPath}).\n` +
        'bunx, npx and package scripts use the `node` on PATH; vp/vpx use .node-version.\n' +
        'Update .node-version or the node on PATH. In GitHub Actions add actions/setup-node\n' +
        'with `node-version: lts/*` and `check-latest: true` before this step.\n',
    );
    // `--version` output would mean the main CLI module ran.
    expect(result.stdout).toBe('');
  });

  it('stops on Bun below the minimum', () => {
    const result = runWithVersions({ bun: '1.3.14', node: '24.3.0' }, ['--version']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('void: Bun 1.4.0 or later is required. Found Bun 1.3.14');
    expect(result.stdout).toBe('');
  });

  it('hands off to the CLI on a supported runtime', () => {
    const result = runWithVersions(null, ['--version']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(VERSION);
  });
});
