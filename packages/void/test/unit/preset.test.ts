import { execSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { toSlash } from 'pathslash';
import { describe, expect, it, beforeEach, afterEach } from 'vite-plus/test';
import { packageFixturePath } from '../../../../test/fixture-dir.ts';
import { resolveCloudflareStaticPreset } from '../../src/cli/deploy-cloudflare-static.ts';
import {
  detectPreset,
  findBackendSources,
  formatProjectCommand,
  hasBackendFiles,
  resolveProjectCommand,
} from '../../src/cli/preset.ts';
import type { VoidConfig } from '../../src/config.ts';

const TMP = packageFixturePath(import.meta.dirname, '.tmp-preset');

function setupProject(opts: {
  pkg?: Record<string, unknown>;
  dirs?: Array<string>;
  files?: Record<string, string>;
}): string {
  mkdirSync(TMP, { recursive: true });
  if (opts.pkg) {
    writeFileSync(join(TMP, 'package.json'), JSON.stringify(opts.pkg));
  }
  for (const dir of opts.dirs ?? []) {
    mkdirSync(join(TMP, dir), { recursive: true });
  }
  for (const [name, content] of Object.entries(opts.files ?? {})) {
    mkdirSync(join(TMP, name, '..'), { recursive: true });
    writeFileSync(join(TMP, name), content);
  }
  return TMP;
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('detectPreset', () => {
  it('returns explicit dir preset with --dir flag', () => {
    const root = setupProject({});
    const result = detectPreset(root, { dir: 'public' });
    expect(result).toEqual({
      buildCommand: null,
      outputDir: toSlash(resolve(root, 'public')),
      appType: 'static',
    });
  });

  it('returns SPA mode when --dir and --spa are combined', () => {
    const root = setupProject({});
    const result = detectPreset(root, { dir: 'build', spa: true });
    expect(result).toEqual({
      buildCommand: null,
      outputDir: toSlash(resolve(root, 'build')),
      appType: 'spa',
    });
  });

  it('detects VitePress (root .vitepress)', () => {
    const root = setupProject({
      pkg: { devDependencies: { vitepress: '^1.0.0' } },
      dirs: ['.vitepress'],
    });
    const result = detectPreset(root);
    expect(result).toEqual({
      buildCommand: 'vitepress build',
      outputDir: toSlash(resolve(root, '.vitepress/dist')),
      appType: 'static',
    });
  });

  it('detects VitePress (docs/ subdir)', () => {
    const root = setupProject({
      pkg: { devDependencies: { vitepress: '^1.0.0' } },
      dirs: ['docs/.vitepress'],
    });
    const result = detectPreset(root);
    expect(result).toEqual({
      buildCommand: 'vitepress build docs',
      outputDir: toSlash(resolve(root, 'docs/.vitepress/dist')),
      appType: 'static',
    });
  });

  it('detects Docusaurus', () => {
    const root = setupProject({
      pkg: { dependencies: { '@docusaurus/core': '^3.0.0' } },
    });
    const result = detectPreset(root);
    expect(result).toEqual({
      buildCommand: 'docusaurus build',
      outputDir: toSlash(resolve(root, 'build')),
      appType: 'static',
    });
  });

  it.each(['routes', 'crons', 'middleware', 'pages', 'queues'])(
    'returns null when %s/ dir exists (backend files)',
    (dir) => {
      const root = setupProject({
        pkg: { dependencies: { vite: '^6.0.0' } },
        dirs: [dir],
      });
      expect(detectPreset(root)).toBeNull();
    },
  );

  it('detects plain Vite SPA (no backend files)', () => {
    const root = setupProject({
      pkg: { dependencies: { vite: '^6.0.0' } },
    });
    const result = detectPreset(root);
    expect(result).toEqual({
      buildCommand: 'vite build',
      outputDir: toSlash(resolve(root, 'dist')),
      appType: 'spa',
    });
  });

  it('prefers the project build script for plain Vite SPAs', () => {
    const root = setupProject({
      pkg: {
        dependencies: { vite: '^6.0.0' },
        scripts: { build: 'vite build && node scripts/postbuild.js' },
      },
      files: { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" },
    });
    const result = detectPreset(root);
    expect(result).toEqual({
      buildCommand: 'pnpm build',
      outputDir: toSlash(resolve(root, 'dist')),
      appType: 'spa',
    });
  });

  it('detects Vite+ SPA (no backend files)', () => {
    const root = setupProject({
      pkg: { devDependencies: { 'vite-plus': '^1.0.0' } },
    });
    const result = detectPreset(root);
    expect(result).toEqual({
      buildCommand: 'vp build',
      outputDir: toSlash(resolve(root, 'dist')),
      appType: 'spa',
    });
  });

  it('detects pre-built dist/index.html as static', () => {
    const root = setupProject({
      files: { 'dist/index.html': '<html></html>' },
    });
    const result = detectPreset(root);
    expect(result).toEqual({
      buildCommand: null,
      outputDir: toSlash(resolve(root, 'dist')),
      appType: 'static',
    });
  });

  it('detects root index.html as static', () => {
    const root = setupProject({
      files: { 'index.html': '<html></html>' },
    });
    const result = detectPreset(root);
    expect(result).toEqual({
      buildCommand: null,
      outputDir: root,
      appType: 'static',
    });
  });

  it('returns null when no build tool and no output found', () => {
    const root = setupProject({
      pkg: { name: 'empty' },
    });
    const result = detectPreset(root);
    expect(result).toBeNull();
  });
});

// SSG detection (step 2) runs BEFORE the `hasBackendFiles` check (step 3), so an
// SSG repo that also has `routes/` / `middleware/` / `crons/` / `queues/` /
// `pages/` / an SSR entry returns a pure static preset and the backend is
// dropped with no diagnostic at all. `strictBackend` makes the ambiguous case
// loud — but only on the UNCONFIGURED auto-detect path, because `--dir` and a
// configured `inference.appType` are the user stating their intent.
describe('detectPreset — strictBackend', () => {
  const vitepressPkg = { devDependencies: { vitepress: '^1.0.0' } };

  it('throws when an SSG project also has routes/', () => {
    const root = setupProject({ pkg: vitepressPkg, dirs: ['.vitepress', 'routes'] });
    expect(() => detectPreset(root, { strictBackend: true })).toThrow('vitepress');
  });

  it('names the backend directories it found', () => {
    const root = setupProject({
      pkg: vitepressPkg,
      dirs: ['.vitepress', 'routes', 'middleware', 'crons'],
    });
    let message = '';
    try {
      detectPreset(root, { strictBackend: true });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('routes/');
    expect(message).toContain('middleware/');
    expect(message).toContain('crons/');
    // ...and tells the user both ways out, so the error is actionable.
    expect(message).toContain('"appType": "static"');
    expect(message).toContain('"appType": "void"');
    expect(message).toContain('"build"');
  });

  it('detects an SSR entry as a backend source too', () => {
    const root = setupProject({
      pkg: vitepressPkg,
      dirs: ['.vitepress'],
      files: { 'src/main.ssr.ts': 'export default {};' },
    });
    expect(() => detectPreset(root, { strictBackend: true })).toThrow('main.ssr.ts');
  });

  it('does NOT throw for an SSG project with no backend', () => {
    const root = setupProject({ pkg: vitepressPkg, dirs: ['.vitepress'] });
    expect(detectPreset(root, { strictBackend: true })).toEqual({
      buildCommand: 'vitepress build',
      outputDir: toSlash(resolve(root, '.vitepress/dist')),
      appType: 'static',
    });
  });

  it('does NOT throw without the flag (auto-detect is opt-in)', () => {
    const root = setupProject({ pkg: vitepressPkg, dirs: ['.vitepress', 'routes'] });
    expect(detectPreset(root)).toEqual({
      buildCommand: 'vitepress build',
      outputDir: toSlash(resolve(root, '.vitepress/dist')),
      appType: 'static',
    });
  });

  it('does NOT throw for an explicit --dir (the user said what they want)', () => {
    const root = setupProject({ pkg: vitepressPkg, dirs: ['.vitepress', 'routes'] });
    // `--dir` short-circuits at step 1, before SSG detection is even reached —
    // and `resolveStaticDeployPreset` never passes strictBackend on that path.
    expect(detectPreset(root, { dir: '.vitepress/dist', strictBackend: true })).toEqual({
      buildCommand: null,
      outputDir: toSlash(resolve(root, '.vitepress/dist')),
      appType: 'static',
    });
  });

  it('does NOT throw when a non-SSG project has backend files', () => {
    // Step 3 already returns null for these; the guard must not change that.
    const root = setupProject({
      pkg: { dependencies: { vite: '^6.0.0' } },
      dirs: ['routes'],
    });
    expect(detectPreset(root, { strictBackend: true })).toBeNull();
  });
});

describe('resolveCloudflareStaticPreset — configured app type', () => {
  const vitepressPkg = { devDependencies: { vitepress: '^1.0.0' } };

  // The guide sends a VitePress site with `routes/` to `appType: "void"`, which this branch ignored.
  it('returns null for a configured appType "void" with an SSG plus backend', () => {
    const root = setupProject({ pkg: vitepressPkg, dirs: ['.vitepress', 'routes'] });
    const voidConfig = { inference: { appType: 'void' } } as VoidConfig;
    expect(resolveCloudflareStaticPreset(root, voidConfig, {})).toBeNull();
  });

  it('still refuses the unconfigured SSG plus backend case', () => {
    const root = setupProject({ pkg: vitepressPkg, dirs: ['.vitepress', 'routes'] });
    expect(() => resolveCloudflareStaticPreset(root, {}, {})).toThrow('vitepress');
  });

  it('keeps resolving a configured static app that also has backend sources', () => {
    const root = setupProject({ pkg: vitepressPkg, dirs: ['.vitepress', 'routes'] });
    const voidConfig = { inference: { appType: 'static' } } as VoidConfig;
    expect(resolveCloudflareStaticPreset(root, voidConfig, {})).toEqual({
      buildCommand: 'vitepress build',
      outputDir: toSlash(resolve(root, '.vitepress/dist')),
      appType: 'static',
    });
  });
});

describe('findBackendSources', () => {
  it('lists every backend source relative to the root', () => {
    const root = setupProject({
      dirs: ['routes', 'pages', 'middleware', 'crons', 'queues', 'email'],
      files: { 'src/main.ssr.tsx': 'export default {};' },
    });
    expect(findBackendSources(root)).toEqual([
      'routes/',
      'pages/',
      'middleware/',
      'crons/',
      'queues/',
      'email/',
      'src/main.ssr.tsx',
    ]);
  });

  // `email/` compiles to the worker's `email()` export. A static deploy uploads
  // no worker, so leaving it out here drops every inbound handler silently.
  it('counts email/ as a backend, and agrees with hasBackendFiles', () => {
    const root = setupProject({ dirs: ['email'] });
    expect(findBackendSources(root)).toEqual(['email/']);
    expect(hasBackendFiles(root)).toBe(true);
  });

  it('is empty for a project with no backend, and agrees with hasBackendFiles', () => {
    const root = setupProject({ pkg: { devDependencies: { vitepress: '^1.0.0' } } });
    expect(findBackendSources(root)).toEqual([]);
    expect(hasBackendFiles(root)).toBe(false);
  });
});

describe('project Vite commands', () => {
  it('formats Vite commands with vp when Vite+ is installed', () => {
    const root = setupProject({
      pkg: { devDependencies: { 'vite-plus': '^1.0.0' } },
    });

    expect(formatProjectCommand(root, 'vite dev')).toBe('vp dev');
    expect(formatProjectCommand(root, 'vite build')).toBe('vp build');
    expect(formatProjectCommand(root, 'vite preview')).toBe('vp preview');
  });

  it('resolves Vite+ commands to the local vp binary', () => {
    const root = setupProject({
      pkg: { devDependencies: { 'vite-plus': '^1.0.0' } },
      files: { 'node_modules/.bin/vp': '' },
    });

    expect(resolveProjectCommand(root, 'vite build')).toBe(
      `${toSlash(join(root, 'node_modules', '.bin', 'vp'))} build`,
    );
  });

  it('keeps plain Vite commands unchanged', () => {
    const root = setupProject({
      pkg: { devDependencies: { vite: '^6.0.0' } },
    });

    expect(formatProjectCommand(root, 'vite dev')).toBe('vite dev');
    expect(resolveProjectCommand(root, 'vite build')).toBe('vite build');
  });
});

describe('resolveProjectCommand shell safety (project root with spaces)', () => {
  // A dedicated root whose path contains a space + a single quote — both are
  // shell-significant and must be quoted before the string reaches execSync.
  const SPACED_TMP = join(import.meta.dirname, ".tmp preset o'space");

  beforeEach(() => {
    rmSync(SPACED_TMP, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(SPACED_TMP, { recursive: true, force: true });
  });

  function setupSpacedProject(binName: string): { root: string; binPath: string } {
    mkdirSync(join(SPACED_TMP, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(SPACED_TMP, 'package.json'), JSON.stringify({ dependencies: {} }));
    const binPath = join(SPACED_TMP, 'node_modules', '.bin', binName);
    // Executable that prints a sentinel + its args so we can confirm the shell
    // launched THIS binary (not a truncated `/…/.tmp` prefix from word-splitting).
    writeFileSync(binPath, `#!/bin/sh\necho "VOID_BIN_OK args=$*"\n`);
    chmodSync(binPath, 0o755);
    return { root: SPACED_TMP, binPath };
  }

  it('quotes the resolved executable path so the shell does not word-split it', () => {
    const { root, binPath } = setupSpacedProject('vitepress');
    const cmd = resolveProjectCommand(root, 'vitepress build');

    // The bin path (which contains a space and a single quote) must be quoted
    // as a single token, not left as a bare substring the shell would split.
    expect(cmd).not.toBe(`${binPath} build`);
    expect(cmd.endsWith(' build')).toBe(true);
    if (process.platform === 'win32') {
      expect(cmd).toBe(`"${toSlash(binPath)}" build`);
    } else {
      // POSIX single-quote wrap, embedded `'` escaped as '\''.
      expect(cmd).toBe(`'${binPath.replaceAll("'", String.raw`'\''`)}' build`);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'executes the correct binary through a shell for a spaced root',
    () => {
      const { root } = setupSpacedProject('vitepress');
      const cmd = resolveProjectCommand(root, 'vitepress build docs');
      const out = execSync(cmd, { encoding: 'utf8' });
      expect(out).toContain('VOID_BIN_OK');
      expect(out).toContain('args=build docs');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'shell-quotes the vite build path for a spaced root',
    () => {
      const { binPath } = setupSpacedProject('vp');
      // vite-plus present → `vite build` resolves to the local `vp` binary.
      writeFileSync(
        join(SPACED_TMP, 'package.json'),
        JSON.stringify({ devDependencies: { 'vite-plus': '^1.0.0' } }),
      );
      const cmd = resolveProjectCommand(SPACED_TMP, 'vite build');
      expect(cmd).toBe(`'${binPath.replaceAll("'", String.raw`'\''`)}' build`);
      const out = execSync(cmd, { encoding: 'utf8' });
      expect(out).toContain('VOID_BIN_OK');
      expect(out).toContain('args=build');
    },
  );
});
