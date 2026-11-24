import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  bundlePackageNames,
  findProjectLockfile,
  readSecurityPackageClaims,
} from '../../src/cli/deploy-security-packages.ts';
import { Buffer } from '../../src/cli/node-buffer.ts';

const dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'void-security-packages-'));
  dirs.push(dir);
  return dir;
}

const LOCK = [
  "lockfileVersion: '9.0'",
  'importers:',
  '  apps/web:',
  '    dependencies:',
  '      hono:',
  '        specifier: ^4.0.0',
  '        version: 4.0.0',
  "      '@acme/shared':",
  '        specifier: workspace:*',
  '        version: link:../../packages/shared',
  'packages:',
  '  hono@4.0.0:',
  '    resolution: {integrity: sha512-x}',
  '  scheduler@0.23.2:',
  '    resolution: {integrity: sha512-y}',
].join('\n');

function map(sources: Array<string>): Buffer {
  return Buffer.from(JSON.stringify({ version: 3, sources, mappings: '' }));
}

describe('deploy security package claims', () => {
  it('reads the packages the source maps name, not the code', () => {
    const files = new Map([
      ['index.js', Buffer.from('export default {}')],
      [
        'index.js.map',
        map([
          '../src/server.ts',
          '../../../node_modules/.pnpm/hono@4.0.0/node_modules/hono/dist/index.js',
          String.raw`..\node_modules\@acme\shared\src\auth.ts`,
        ]),
      ],
      ['broken.js.map', Buffer.from('{not json')],
    ]);
    expect([...bundlePackageNames(files)].sort()).toEqual(['@acme/shared', 'hono']);
  });

  it('finds the nearest lockfile up to the repository root, and none above it', () => {
    const root = repo();
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'apps', 'web'), { recursive: true });
    expect(findProjectLockfile(join(root, 'apps', 'web'))).toBeNull();
    writeFileSync(join(root, 'pnpm-lock.yaml'), LOCK);
    expect(findProjectLockfile(join(root, 'apps', 'web'))).toBe(join(root, 'pnpm-lock.yaml'));
    writeFileSync(join(root, 'apps', 'web', 'package-lock.json'), '{}');
    expect(findProjectLockfile(join(root, 'apps', 'web'))).toBe(
      join(root, 'apps', 'web', 'package-lock.json'),
    );
  });

  it('claims each bundle package the lockfile places (transitive ones too)', () => {
    const root = repo();
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'apps', 'web'), { recursive: true });
    writeFileSync(join(root, 'pnpm-lock.yaml'), LOCK);
    const files = new Map([
      [
        'index.js.map',
        map([
          '../node_modules/hono/dist/index.js',
          '../node_modules/scheduler/index.js',
          '../node_modules/@acme/shared/src/auth.ts',
          '../node_modules/unknown/index.js',
        ]),
      ],
    ]);
    expect(readSecurityPackageClaims(join(root, 'apps', 'web'), files)).toEqual({
      registry: ['hono', 'scheduler'],
      local: ['@acme/shared'],
    });
  });

  it('sends nothing without a lockfile, a map or a placed package', () => {
    const root = repo();
    mkdirSync(join(root, '.git'));
    const files = new Map([['index.js.map', map(['../node_modules/hono/index.js'])]]);
    expect(readSecurityPackageClaims(root, files)).toBeNull();
    writeFileSync(join(root, 'pnpm-lock.yaml'), LOCK);
    expect(readSecurityPackageClaims(root, new Map([['index.js', Buffer.from('x')]]))).toBeNull();
    expect(
      readSecurityPackageClaims(root, new Map([['a.js.map', map(['../node_modules/zz/x.js'])]])),
    ).toBeNull();
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'not a lockfile');
    expect(readSecurityPackageClaims(root, files)).toBeNull();
  });
});
