import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  BUN_MINIMUM,
  NODE_ENGINES,
  parseVersion,
  unsupportedRuntimeMessage,
} from '../../src/cli/runtime-support.ts';

const PACKAGES = join(import.meta.dirname, '..', '..', '..');
const EXEC_PATH = '/usr/local/bin/node';

function readEnginesNode(pkg: string): string {
  const manifest = JSON.parse(readFileSync(join(PACKAGES, pkg, 'package.json'), 'utf8')) as {
    engines: { node: string };
  };
  return manifest.engines.node;
}

describe('runtime support check', () => {
  it.each(['20.20.2', '22.23.4', '24.13.0', '24.21.0', '25.4.0', '26.11.9'])(
    'rejects Node %s',
    (node) => {
      const message = unsupportedRuntimeMessage({ node }, EXEC_PATH);
      expect(message).toBe(
        `void: Node.js 24.22+ or 26.12+ is required. Found Node.js v${node} (${EXEC_PATH}).\n` +
          'bunx, npx and package scripts use the `node` on PATH; vp/vpx use .node-version.\n' +
          'Update .node-version or the node on PATH. In GitHub Actions add actions/setup-node\n' +
          'with `node-version: lts/*` and `check-latest: true` before this step.',
      );
    },
  );

  it.each(['24.22.0', '24.22.1', '24.30.0', '26.12.0', '27.0.0', '27.0.0-nightly20261104abcdef'])(
    'accepts Node %s',
    (node) => {
      expect(unsupportedRuntimeMessage({ node }, EXEC_PATH)).toBeNull();
    },
  );

  it('rejects a missing or malformed Node version', () => {
    expect(unsupportedRuntimeMessage({}, EXEC_PATH)).toContain(
      'Found Node.js an unknown version (/usr/local/bin/node).',
    );
    expect(unsupportedRuntimeMessage({ node: '24.x' }, EXEC_PATH)).toContain('Found Node.js v24.x');
  });

  // Bun reports Node v26.3.0 (1.4.x) or v24.3.0 (1.3.x), so it is checked on its own version.
  it('rejects Bun below the minimum even though it reports a Node version', () => {
    expect(unsupportedRuntimeMessage({ bun: '1.3.14', node: '24.3.0' }, '/usr/local/bin/bun')).toBe(
      'void: Bun 1.4.0 or later is required. Found Bun 1.3.14 (/usr/local/bin/bun).\n' +
        'Update Bun, or run void on Node.js 24.22+ or 26.12+.',
    );
  });

  it.each(['1.4.0', '1.4.3'])('lets Bun %s through', (bun) => {
    expect(unsupportedRuntimeMessage({ bun, node: '26.3.0' }, '/usr/local/bin/bun')).toBeNull();
  });

  it('names the calling command in the message', () => {
    const message = unsupportedRuntimeMessage({ node: '22.23.4' }, EXEC_PATH, 'create-void');
    expect(message?.split('\n')[0]).toBe(
      `create-void: Node.js 24.22+ or 26.12+ is required. Found Node.js v22.23.4 (${EXEC_PATH}).`,
    );
  });

  it('parses versions', () => {
    expect(parseVersion('v24.22.1')).toEqual([24, 22, 1]);
    expect(parseVersion('1.4.0+build.5')).toEqual([1, 4, 0]);
    expect(parseVersion('27.0.0-nightly2026')).toEqual([27, 0, 0]);
    expect(parseVersion('24.22')).toBeNull();
    expect(parseVersion('24.22.x')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion(BUN_MINIMUM)).toEqual([1, 4, 0]);
  });

  it('keeps NODE_ENGINES equal to engines.node of void and create-void', () => {
    expect(readEnginesNode('void')).toBe(NODE_ENGINES);
    expect(readEnginesNode('create-void')).toBe(NODE_ENGINES);
  });

  it('keeps the create-void copy identical to the CLI copy', () => {
    expect(readFileSync(join(PACKAGES, 'create-void', 'src', 'runtime-support.ts'), 'utf8')).toBe(
      readFileSync(join(PACKAGES, 'void', 'src', 'cli', 'runtime-support.ts'), 'utf8'),
    );
  });
});
