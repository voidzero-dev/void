import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';

const roots: Array<string> = [];

function runPrepare(root: string): { written: Array<string>; removed: Array<string> } {
  const stdout = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'const { prepareProject } = await import(process.argv[1]); console.log(JSON.stringify(await prepareProject(process.argv[2])));',
      new URL('../../src/codegen/prepare.ts', import.meta.url).href,
      root,
    ],
    { encoding: 'utf8', stdio: 'pipe' },
  );
  return JSON.parse(stdout.trim().split('\n').at(-1)!);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('auth types prepare lifecycle', () => {
  it('writes auth.d.ts and updates tsconfig after prepare; removes both when auth.ts is gone', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-auth-prepare-'));
    roots.push(root);
    mkdirSync(join(root, '.void'), { recursive: true });
    writeFileSync(
      join(root, 'auth.ts'),
      'import type { VoidAuthConfig } from "void/auth";\nexport default {} satisfies VoidAuthConfig;\n',
    );

    expect(runPrepare(root).written).toContain('.void/auth.d.ts');
    expect(existsSync(join(root, '.void', 'auth.d.ts'))).toBe(true);
    const withAuth = JSON.parse(readFileSync(join(root, '.void', 'tsconfig.json'), 'utf8')) as {
      files: Array<string>;
    };
    expect(withAuth.files).toContain('auth.d.ts');

    rmSync(join(root, 'auth.ts'));
    expect(runPrepare(root).removed).toContain('.void/auth.d.ts');
    expect(existsSync(join(root, '.void', 'auth.d.ts'))).toBe(false);
    const withoutAuth = JSON.parse(readFileSync(join(root, '.void', 'tsconfig.json'), 'utf8')) as {
      files: Array<string>;
    };
    expect(withoutAuth.files).not.toContain('auth.d.ts');
  }, 30_000);
});
