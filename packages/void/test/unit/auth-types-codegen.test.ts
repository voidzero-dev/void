import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  generateAuthTypes,
  removeAuthTypesIfPresent,
  syncAuthTypesFile,
} from '../../src/codegen/auth-types.ts';

function withTempProject(setup: (root: string) => void): {
  root: string;
  outDir: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'void-auth-codegen-'));
  setup(root);
  const outDir = join(root, '.void');
  mkdirSync(outDir, { recursive: true });
  return {
    root,
    outDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('syncAuthTypesFile', () => {
  it('writes auth.d.ts when a config path is provided and removes it when null', () => {
    const { root, outDir, cleanup } = withTempProject((r) => {
      writeFileSync(join(r, 'auth.ts'), 'export default {};\n');
    });
    try {
      expect(syncAuthTypesFile(join(root, 'auth.ts'), outDir)).toBe(true);
      expect(syncAuthTypesFile(join(root, 'auth.ts'), outDir)).toBe(false);
      expect(syncAuthTypesFile(null, outDir)).toBe(true);
      expect(removeAuthTypesIfPresent(outDir)).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe('generateAuthTypes', () => {
  it('emits a module that fills the void/auth VoidAuthTypes registry', () => {
    const { root, outDir, cleanup } = withTempProject((r) => {
      writeFileSync(join(r, 'auth.ts'), 'export default {};');
    });
    try {
      const { dts } = generateAuthTypes(join(root, 'auth.ts'), outDir);
      expect(dts).toContain('export {}');
      // better-auth is reached through void/auth: apps usually cannot resolve it themselves.
      expect(dts).toContain('import type { InferAuthSession } from "void/auth";');
      expect(dts).not.toContain('from "better-auth"');
      expect(dts).toContain(
        'type _VoidAuthSession = InferAuthSession<typeof import("../auth.ts")["default"]>;',
      );
      expect(dts).toContain('declare module "void/auth"');
      expect(dts).toContain('interface VoidAuthTypes {');
      expect(dts).toContain('user: _VoidAuthSession["user"];');
      expect(dts).toContain('session: _VoidAuthSession["session"];');
    } finally {
      cleanup();
    }
  });
});
