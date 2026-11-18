import { describe, expect, it } from 'vite-plus/test';
import {
  classifyThirdParty,
  packageNameOfPath,
  parsePackageLock,
  parsePnpmLock,
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
