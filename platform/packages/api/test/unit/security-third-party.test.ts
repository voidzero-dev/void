import { securityPackageClaims } from '@void/platform/security-lockfile';
import { describe, expect, it } from 'vite-plus/test';
import {
  classifyThirdParty,
  packageNameOfPath,
  parsePackageLock,
  parsePnpmLock,
  parseSecurityLockfile,
  parseSecurityPackageClaims,
} from '../../src/security/input/third-party.ts';

describe('packageNameOfPath', () => {
  it('reads the package after the last node_modules', () => {
    expect(packageNameOfPath('node_modules/hono/dist/index.js')).toBe('hono');
    expect(packageNameOfPath('node_modules/@acme/shared/src/auth.ts')).toBe('@acme/shared');
    expect(packageNameOfPath('node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')).toBe(
      'react',
    );
    expect(packageNameOfPath('src/node_modules.ts')).toBeNull();
    expect(packageNameOfPath('src/app.ts')).toBeNull();
    expect(packageNameOfPath('node_modules/.pnpm/x')).toBeNull();
  });
});

describe('classifyThirdParty', () => {
  const lockfile = new Map([
    ['hono', 'registry' as const],
    ['@acme/shared', 'local' as const],
  ]);

  it('drops only registry packages the lockfile proves', () => {
    expect(classifyThirdParty('node_modules/hono/dist/index.js', lockfile)).toBe('registry');
    expect(classifyThirdParty('node_modules/@acme/shared/src/auth.ts', lockfile)).toBe(
      'first_party',
    );
    expect(classifyThirdParty('src/app.ts', lockfile)).toBe('first_party');
  });

  it('keeps a package it cannot prove as unverified', () => {
    expect(classifyThirdParty('node_modules/zod/index.js', lockfile)).toBe('unverified');
    // A T2 deploy has no lockfile: path text alone never drops code.
    expect(classifyThirdParty('node_modules/hono/dist/index.js', null)).toBe('unverified');
    expect(classifyThirdParty('vendor/hono.js', null)).toBe('first_party');
  });
});

describe('parsePackageLock', () => {
  it('tells registry tarballs from links and files', () => {
    const index = parsePackageLock(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'app' },
          'node_modules/hono': { resolved: 'https://registry.npmjs.org/hono/-/hono-4.0.0.tgz' },
          'node_modules/@acme/shared': { resolved: 'packages/shared', link: true },
          'node_modules/local-lib': { resolved: 'file:../local-lib' },
          'node_modules/forked': { resolved: 'git+ssh://git@github.com/acme/forked.git#abc' },
          'node_modules/a/node_modules/hono': {
            resolved: 'https://registry.npmjs.org/hono/-/hono-3.0.0.tgz',
          },
        },
      }),
    );
    expect(index?.get('hono')).toBe('registry');
    expect(index?.get('@acme/shared')).toBe('local');
    expect(index?.get('local-lib')).toBe('local');
    expect(index?.get('forked')).toBe('local');
  });

  it('refuses text that is not a lockfile', () => {
    expect(parsePackageLock('not json')).toBeNull();
    expect(parsePackageLock('{"name":"x"}')).toBeNull();
  });
});

describe('parsePnpmLock', () => {
  it('reads importer dependencies by their version', () => {
    const index = parsePnpmLock(
      [
        "lockfileVersion: '9.0'",
        '',
        'importers:',
        '',
        '  .:',
        '    dependencies:',
        '      hono:',
        '        specifier: ^4.0.0',
        '        version: 4.0.0',
        "      '@acme/shared':",
        '        specifier: workspace:*',
        '        version: link:packages/shared',
        '    devDependencies:',
        '      local-lib:',
        '        specifier: file:../local-lib',
        '        version: file:../local-lib',
        '',
        'packages:',
        '',
        '  hono@4.0.0:',
        '    resolution: {integrity: sha512-x}',
      ].join('\n'),
    );
    expect(index?.get('hono')).toBe('registry');
    expect(index?.get('@acme/shared')).toBe('local');
    expect(index?.get('local-lib')).toBe('local');
  });

  it('keeps a package local when any importer links it', () => {
    const index = parsePnpmLock(
      [
        'importers:',
        '  apps/web:',
        '    dependencies:',
        '      shared:',
        '        version: link:../../packages/shared',
        '  apps/api:',
        '    dependencies:',
        '      shared:',
        '        version: 1.0.0',
      ].join('\n'),
    );
    expect(index?.get('shared')).toBe('local');
  });

  it('is null for text with no importers', () => {
    expect(parsePnpmLock('hello: world')).toBeNull();
  });
});

describe('parsePnpmLock: every resolved package (S7: transitive ones too)', () => {
  it('reads the packages section, v9 and v6 keys, with its resolution kind', () => {
    const index = parsePnpmLock(
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        '      react-dom:',
        '        specifier: ^18.3.1',
        '        version: 18.3.1(react@18.3.1)',
        'packages:',
        '  react-dom@18.3.1:',
        '    resolution: {integrity: sha512-a}',
        '    peerDependencies:',
        '      react: ^18.3.1',
        '  scheduler@0.23.2:',
        '    resolution: {integrity: sha512-b}',
        "  '@scope/devalue@5.1.1':",
        '    resolution: {integrity: sha512-c, tarball: https://registry.example.com/devalue.tgz}',
        '  /legacy@1.0.0:',
        '    resolution: {integrity: sha512-d}',
        '  local-lib@file:../local-lib:',
        '    resolution: {directory: ../local-lib, type: directory}',
        '  vendored@file:vendor/vendored.tgz:',
        '    resolution:',
        '      integrity: sha512-e',
        '      tarball: file:vendor/vendored.tgz',
        '  forked@https://codeload.github.com/acme/forked/tar.gz/abc:',
        '    resolution: {tarball: https://codeload.github.com/acme/forked/tar.gz/abc}',
        '  gitdep@git+https://github.com/acme/gitdep.git#abc:',
        '    resolution: {commit: abc, repo: https://github.com/acme/gitdep.git, type: git}',
        'snapshots:',
        '  scheduler@0.23.2: {}',
      ].join('\n'),
    );
    expect(Object.fromEntries(index ?? [])).toEqual({
      'react-dom': 'registry',
      scheduler: 'registry',
      '@scope/devalue': 'registry',
      legacy: 'registry',
      'local-lib': 'local',
      vendored: 'local',
      forked: 'registry',
      gitdep: 'local',
    });
  });

  it('keeps a workspace package local even when a registry copy is also resolved', () => {
    const index = parsePnpmLock(
      [
        'importers:',
        '  apps/web:',
        '    dependencies:',
        '      shared:',
        '        version: link:../../packages/shared',
        'packages:',
        '  shared@1.0.0:',
        '    resolution: {integrity: sha512-x}',
      ].join('\n'),
    );
    expect(index?.get('shared')).toBe('local');
  });
});

describe('deploy package claims', () => {
  it('names only the bundle packages the lockfile places, sorted', () => {
    const index = new Map([
      ['hono', 'registry' as const],
      ['@acme/shared', 'local' as const],
      ['zod', 'registry' as const],
    ]);
    expect(
      securityPackageClaims(index, ['zod', 'hono', '@acme/shared', 'unknown', 'hono']),
    ).toEqual({ registry: ['hono', 'zod'], local: ['@acme/shared'] });
  });

  it('reads claims back, local winning, and refuses bad shapes and names', () => {
    const index = parseSecurityPackageClaims({ registry: ['hono', 'x'], local: ['x'] });
    expect(Object.fromEntries(index ?? [])).toEqual({ hono: 'registry', x: 'local' });
    expect(parseSecurityPackageClaims(null)).toBeNull();
    expect(parseSecurityPackageClaims({ registry: 'hono', local: [] })).toBeNull();
    expect(parseSecurityPackageClaims({ registry: ['../evil'], local: [] })).toBeNull();
    expect(parseSecurityPackageClaims({ registry: ['a/b/c'], local: [] })).toBeNull();
    expect(parseSecurityPackageClaims({ registry: [''], local: [] })).toBeNull();
    expect(
      parseSecurityPackageClaims({
        registry: Array.from({ length: 5_001 }, (_, i) => `p${i}`),
        local: [],
      }),
    ).toBeNull();
  });

  it('reads a lockfile by its name', () => {
    expect(
      parseSecurityLockfile(
        'apps/pnpm-lock.yaml',
        'importers:\n  .:\n    dependencies:\n      a:\n        version: 1.0.0',
      )?.get('a'),
    ).toBe('registry');
    expect(parseSecurityLockfile('yarn.lock', 'a@1:\n  version "1"')).toBeNull();
  });
});
