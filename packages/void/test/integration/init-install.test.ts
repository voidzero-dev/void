import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { installProjectDependencies } from '../../src/cli/init.ts';

let root: string;
let bin: string;
let callsFile: string;

function executable(name: string, status = 0): void {
  const script = join(bin, `${name}.cjs`);
  writeFileSync(
    script,
    `const { appendFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ command: ${JSON.stringify(name)}, args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
process.exitCode = process.argv.includes('--version') ? 0 : ${status};
`,
  );
  if (process.platform === 'win32') {
    writeFileSync(join(bin, `${name}.cmd`), `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    writeFileSync(join(bin, name), `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`, {
      mode: 0o755,
    });
  }
}

function calls(): Array<{ command: string; args: Array<string>; cwd: string }> {
  return readFileSync(callsFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'void-init-install-')));
  bin = join(root, 'bin');
  callsFile = join(root, 'calls.jsonl');
  mkdirSync(bin);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      private: true,
      packageManager: 'pnpm@12.4.1',
      devDependencies: { 'vite-plus': '^1.3.0' },
    }),
  );
  // The host's tools must not mask a missing vp or supply a newer pnpm.
  vi.stubEnv('PATH', bin);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('init dependency installation (real subprocesses)', () => {
  it('uses Vite+ instead of delegating a pnpm 12 pin to an older global pnpm', () => {
    executable('vp');
    executable('pnpm', 1);

    installProjectDependencies(root, 'pnpm');

    expect(calls()).toEqual([
      { command: 'vp', args: ['--version'], cwd: root },
      { command: 'vp', args: ['install', '--no-frozen-lockfile'], cwd: root },
    ]);
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager).toBe(
      'pnpm@12.4.1',
    );
  });

  it('bootstraps Vite+ when neither a local nor a global vp is installed', () => {
    executable('npx');
    executable('pnpm', 1);

    installProjectDependencies(root, 'pnpm');

    // Assert the received argv: Windows cmd.exe must preserve the semver caret.
    expect(calls()).toEqual([
      {
        command: 'npx',
        args: ['--yes', '--package=vite-plus@^1.4.0', 'vp', 'install', '--no-frozen-lockfile'],
        cwd: root,
      },
    ]);
  });

  it('reports a Vite+ install failure without retrying through another installer', () => {
    executable('vp', 7);
    executable('npx');
    executable('pnpm', 1);

    expect(() => installProjectDependencies(root, 'pnpm')).toThrow(
      'vp install failed with exit code 7',
    );
    expect(calls()).toEqual([
      { command: 'vp', args: ['--version'], cwd: root },
      { command: 'vp', args: ['install', '--no-frozen-lockfile'], cwd: root },
    ]);
  });

  it('uses an installed project-local Vite+ without requiring tools on PATH', () => {
    const vitePlus = join(root, 'node_modules', 'vite-plus');
    mkdirSync(join(vitePlus, 'bin'), { recursive: true });
    writeFileSync(join(vitePlus, 'package.json'), JSON.stringify({ name: 'vite-plus' }));
    executable('local-vp');
    writeFileSync(join(vitePlus, 'bin', 'vp'), readFileSync(join(bin, 'local-vp.cjs'), 'utf8'));

    installProjectDependencies(root, 'pnpm');

    expect(calls()).toEqual([
      { command: 'local-vp', args: ['install', '--no-frozen-lockfile'], cwd: root },
    ]);
  });

  it('keeps plain Vite projects on their selected package manager', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
    executable('vp', 1);
    executable('pnpm');

    installProjectDependencies(root, 'pnpm');

    expect(calls()).toEqual([
      { command: 'pnpm', args: ['install', '--no-frozen-lockfile'], cwd: root },
    ]);
  });
});
