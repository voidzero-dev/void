import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { writePnpmBuildPolicy } from '../../src/pm.ts';

const temporaryDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('create-void package manager bootstrap', () => {
  it('writes the narrow Void build policy before a fresh pnpm install', () => {
    const root = mkdtempSync(join(tmpdir(), 'create-void-pnpm-'));
    temporaryDirectories.push(root);

    writePnpmBuildPolicy(root, 'pnpm');

    expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf-8')).toBe(
      'allowBuilds:\n  better-sqlite3: false\n  esbuild: true\n  sharp: true\n  workerd: true\n',
    );
  });

  it('does not add pnpm policy files for other package managers', () => {
    for (const manager of ['npm', 'yarn', 'bun'] as const) {
      const root = mkdtempSync(join(tmpdir(), `create-void-${manager}-`));
      temporaryDirectories.push(root);

      writePnpmBuildPolicy(root, manager);

      expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(false);
    }
  });
});
