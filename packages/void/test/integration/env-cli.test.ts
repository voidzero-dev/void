import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vite-plus/test';

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..');
const CLI_ENTRY = join(PACKAGE_ROOT, 'dist', 'cli', 'cli.mjs');
const ENV_PUBLIC_DIST = join(PACKAGE_ROOT, 'dist', 'runtime', 'env-public.mjs');

const roots: Array<string> = [];

function createProject(envSchemaBody?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'void-env-cli-'));
  roots.push(root);
  // Node loads env.ts with the nearest package's module type; tmpdir has no package.json.
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  if (envSchemaBody !== undefined) {
    // Import defineEnv from dist so the CLI and env.ts share one schema registry.
    const envPublicUrl = pathToFileURL(ENV_PUBLIC_DIST).href;
    writeFileSync(
      join(root, 'env.ts'),
      `import { defineEnv, string, number } from "${envPublicUrl}";\n` +
        `export default defineEnv(${envSchemaBody});\n`,
    );
  }
  return root;
}

function runVoid(
  root: string,
  args: Array<string>,
): { stdout: string; stderr: string; status: number } {
  const res = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: root,
      USERPROFILE: root,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
    },
  });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status ?? 1,
  };
}

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('void env check (subprocess)', () => {
  it('exits 0 and reports "nothing to validate" when no env.ts exists', () => {
    const root = createProject();
    const { stdout, status } = runVoid(root, ['env', 'check']);
    expect(status).toBe(0);
    expect(stdout).toContain('No env.ts found');
  });

  it('exits 1 and names the missing key when a required env var is absent', () => {
    const root = createProject('{ STRIPE_KEY: string() }');
    const { stdout, status } = runVoid(root, ['env', 'check']);
    expect(status).toBe(1);
    expect(stdout).toContain('Env validation failed');
    expect(stdout).toContain('STRIPE_KEY');
  });

  it('exits 0 when .env satisfies every required key locally', () => {
    const root = createProject('{ STRIPE_KEY: string(), PORT: number() }');
    writeFileSync(join(root, '.env'), 'STRIPE_KEY=sk_dev\nPORT=8080\n');
    const { stdout, status } = runVoid(root, ['env', 'check']);
    expect(status).toBe(0);
    expect(stdout).toContain('Local .env values are valid');
  });

  it('redacts secret-looking values from invalid-env report output', () => {
    // PORT expects a number; the user accidentally pasted an API key.
    // The CLI output must NOT contain the raw token.
    const root = createProject('{ PORT: number() }');
    writeFileSync(join(root, '.env'), 'PORT=sk_live_abc123456\n');
    const { stdout, status } = runVoid(root, ['env', 'check']);
    expect(status).toBe(1);
    expect(stdout).toContain('PORT');
    expect(stdout).not.toContain('sk_live_abc123456');
    expect(stdout).toContain('<redacted>');
  });

  it('rejects legacy .env.local files', () => {
    const root = createProject('{ STRIPE_KEY: string() }');
    writeFileSync(join(root, '.env.local'), 'STRIPE_KEY=sk_dev\n');
    const { stdout, status } = runVoid(root, ['env', 'check']);
    expect(status).toBe(1);
    expect(stdout).toContain('only .env is supported');
    expect(stdout).toContain('.env.local');
    expect(stdout).not.toContain('env.ts lists the keys');
  });

  it('points .env.example users at env.ts', () => {
    const root = createProject('{ STRIPE_KEY: string() }');
    writeFileSync(join(root, '.env.example'), 'STRIPE_KEY=\n');
    const { stdout, status } = runVoid(root, ['env', 'check']);
    expect(status).toBe(1);
    expect(stdout).toContain('Remove .env.example');
    expect(stdout).toContain('env.ts lists the keys');
  });
});

describe('void env types (subprocess)', () => {
  it('writes .void/env.d.ts augmenting void/env and void/handler', () => {
    const root = createProject('{ API_KEY: string() }');
    const { stdout, status } = runVoid(root, ['env', 'types']);
    expect(status).toBe(0);
    expect(stdout).toContain('Wrote');

    const dtsPath = join(root, '.void', 'env.d.ts');
    expect(existsSync(dtsPath)).toBe(true);
    const dts = readFileSync(dtsPath, 'utf-8');
    expect(dts).toContain('declare module "void/env"');
    expect(dts).toContain('declare module "void/handler"');
    expect(dts).toContain('typeof import("../env.ts")');
  });

  it('prints a friendly message and exits 0 when no env.ts exists', () => {
    const root = createProject();
    const { stdout, status } = runVoid(root, ['env', 'types']);
    expect(status).toBe(0);
    expect(stdout).toContain('No env.ts found');
    expect(existsSync(join(root, '.void', 'env.d.ts'))).toBe(false);
  });
});
