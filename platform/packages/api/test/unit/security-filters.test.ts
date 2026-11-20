import { describe, expect, it } from 'vite-plus/test';
import { looksBinary, securityInputFilter } from '../../src/security/input/filters.ts';

describe('securityInputFilter', () => {
  it('drops secret-like files', () => {
    for (const path of [
      '.env',
      '.env.local',
      'config/.env.production',
      'certs/server.pem',
      'keys/private.key',
      'id_rsa',
      'home/.ssh/id_ed25519.pub',
      'client.p12',
      '.npmrc',
      '.gitignore',
      '.github/workflows/deploy.yml',
      'repo/.git/config',
    ]) {
      expect(securityInputFilter(path), path).toBe('secret');
    }
  });

  it('skips lockfiles, generated types, binaries, images, fonts and wasm', () => {
    for (const path of [
      'pnpm-lock.yaml',
      'apps/web/package-lock.json',
      'yarn.lock',
      'bun.lockb',
      '.void/routes.d.ts',
      'app/.void/db.ts',
      'src/types.d.ts',
      'src/env.d.mts',
      'public/logo.png',
      'fonts/Inter.woff2',
      '_worker/query.wasm',
      'assets/photo.JPG',
    ]) {
      expect(securityInputFilter(path), path).toBe('skipped');
    }
  });

  it('keeps first-party code, even minified or with a key-like name', () => {
    for (const path of [
      'src/routes/index.ts',
      'src/id_utils.ts',
      'src/env.ts',
      'src/keys.ts',
      'dist/chunk-abc.min.js',
      'node_modules/@acme/shared/src/auth.ts',
      'src/environment/config.ts',
    ]) {
      expect(securityInputFilter(path), path).toBeNull();
    }
  });
});

describe('looksBinary', () => {
  it('flags NUL bytes and broken UTF-8', () => {
    expect(looksBinary('abc\u0000def')).toBe(true);
    expect(looksBinary(new TextDecoder().decode(new Uint8Array([0xff, 0xfe, 0x41])))).toBe(true);
    expect(looksBinary('export const a = 1;\n')).toBe(false);
  });
});
