import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { packageFixturePath } from '../../../../test/fixture-dir.ts';
import { resolveStaticPageDataBuildOptions } from '../../src/pages/static-data.ts';

const tmpDir = packageFixturePath(import.meta.dirname, '.tmp-static-data-test');

function setupConfig(content: Record<string, unknown>): void {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, 'void.json'), JSON.stringify(content));
}

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveStaticPageDataBuildOptions', () => {
  it('disables the fast path when output is not "static"', () => {
    setupConfig({ output: 'server' });
    const opts = resolveStaticPageDataBuildOptions(tmpDir, { publicDir: false });
    expect(opts.enabled).toBe(false);
    expect(opts.fastPath).toBe(false);
  });

  it('enables the fast path for static builds with no routing rules', () => {
    setupConfig({ output: 'static' });
    const opts = resolveStaticPageDataBuildOptions(tmpDir, { publicDir: false });
    expect(opts.enabled).toBe(true);
    expect(opts.fastPath).toBe(true);
  });

  it('disables the fast path when routing.redirects is non-empty', () => {
    setupConfig({ output: 'static', routing: { redirects: { '/old': '/new' } } });
    const opts = resolveStaticPageDataBuildOptions(tmpDir, { publicDir: false });
    expect(opts.fastPath).toBe(false);
  });

  it('disables the fast path when routing.rewrites is non-empty', () => {
    setupConfig({ output: 'static', routing: { rewrites: { '/old': '/new' } } });
    const opts = resolveStaticPageDataBuildOptions(tmpDir, { publicDir: false });
    expect(opts.fastPath).toBe(false);
  });

  it('disables the fast path when routing.fallbacks is non-empty', () => {
    setupConfig({ output: 'static', routing: { fallbacks: { '/missing': '/index' } } });
    const opts = resolveStaticPageDataBuildOptions(tmpDir, { publicDir: false });
    expect(opts.fastPath).toBe(false);
  });

  it('keeps the fast path enabled when only routing.headers is set', () => {
    setupConfig({
      output: 'static',
      routing: { headers: { '/api/*': ['Cache-Control: no-store'] } },
    });
    const opts = resolveStaticPageDataBuildOptions(tmpDir, { publicDir: false });
    expect(opts.fastPath).toBe(true);
  });

  it('keeps the fast path enabled when routing.rewrites is an empty object', () => {
    setupConfig({ output: 'static', routing: { rewrites: {} } });
    const opts = resolveStaticPageDataBuildOptions(tmpDir, { publicDir: false });
    expect(opts.fastPath).toBe(true);
  });
});
