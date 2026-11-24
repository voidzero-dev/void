import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { loadUserEnvFile } from '../../src/host/load-user-env.ts';

/**
 * Coverage for the env.ts loader. The loader uses Node's native `import()`,
 * so only relative + bare-package imports resolve. tsconfig path aliases
 * are intentionally unsupported — they get detected and produce a friendly
 * error with a pointer to the offending specifier.
 */

const roots: Array<string> = [];

function createTempProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-load-user-env-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('loadUserEnvFile', () => {
  it('loads env.ts with relative imports', async () => {
    const root = createTempProject();
    const sentinel = join(root, 'sentinel.txt');
    writeFileSync(join(root, 'helper.ts'), 'export const APP = "relative-ok";\n');
    writeFileSync(
      join(root, 'env.ts'),
      'import { writeFileSync } from "node:fs";\n' +
        'import { APP } from "./helper.ts";\n' +
        `writeFileSync(${JSON.stringify(sentinel)}, APP);\n`,
    );

    await loadUserEnvFile(join(root, 'env.ts'));

    expect(existsSync(sentinel)).toBe(true);
    expect(readFileSync(sentinel, 'utf8')).toBe('relative-ok');
  });

  it('re-evaluates the file on repeat loads so HMR picks up edits', async () => {
    const root = createTempProject();
    const sentinel = join(root, 'sentinel.txt');
    const envPath = join(root, 'env.ts');

    writeFileSync(
      envPath,
      'import { writeFileSync } from "node:fs";\n' +
        `writeFileSync(${JSON.stringify(sentinel)}, "first");\n`,
    );
    await loadUserEnvFile(envPath);
    expect(readFileSync(sentinel, 'utf8')).toBe('first');

    writeFileSync(
      envPath,
      'import { writeFileSync } from "node:fs";\n' +
        `writeFileSync(${JSON.stringify(sentinel)}, "second");\n`,
    );
    await loadUserEnvFile(envPath);
    expect(readFileSync(sentinel, 'utf8')).toBe('second');
  });

  it('wraps runtime failures with the source file path', async () => {
    const root = createTempProject();
    const envPath = join(root, 'env.ts');
    writeFileSync(envPath, 'throw new Error("boom from env.ts");\n');

    await expect(loadUserEnvFile(envPath)).rejects.toThrow(
      /Failed to load.*env\.ts.*boom from env\.ts/s,
    );
  });

  it('gives a targeted hint when env.ts imports through a tsconfig path alias', async () => {
    const root = createTempProject();
    const envPath = join(root, 'env.ts');
    // `@/shared/env-keys` is the classic tsconfig-paths shape: starts with
    // `@` but has no scope segment, so it isn't a valid bare package.
    writeFileSync(envPath, 'import { X } from "@/shared/env-keys";\nconsole.log(X);\n');

    await expect(loadUserEnvFile(envPath)).rejects.toThrow(
      /tsconfig path alias.*use a relative import/s,
    );
  });

  it('does not add the alias hint for a genuine missing bare package', async () => {
    const root = createTempProject();
    const envPath = join(root, 'env.ts');
    // `@scope/name` is scoped-package-shaped — a missing module of this
    // form is a real dependency problem, not an alias, so we shouldn't
    // mislead the user with alias guidance.
    writeFileSync(envPath, 'import "@definitely-not-installed/pkg";\n');

    await expect(loadUserEnvFile(envPath)).rejects.toThrow(/Failed to load.*env\.ts/s);
    await expect(loadUserEnvFile(envPath)).rejects.not.toThrow(/tsconfig path alias/);
  });
});
