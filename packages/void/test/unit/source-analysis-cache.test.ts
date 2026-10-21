import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  deriveFromSource,
  invalidateSourceAnalysis,
} from '../../src/shared/source-analysis-cache.ts';

describe('deriveFromSource', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'void-source-cache-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Move the clock past the window in which a file's stat is not trusted. */
  function settle(): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
  }

  it('reuses a derived value until the file changes', () => {
    const file = join(dir, 'page.ts');
    writeFileSync(file, 'export const loader = 1;');
    settle();
    const derive = vi.fn((source: string) => source.length);

    expect(deriveFromSource(file, 'length', derive)).toBe(24);
    expect(deriveFromSource(file, 'length', derive)).toBe(24);
    expect(derive).toHaveBeenCalledTimes(1);

    writeFileSync(file, 'export const action = 2;;');
    expect(deriveFromSource(file, 'length', derive)).toBe(25);
    expect(derive).toHaveBeenCalledTimes(2);
  });

  it('derives again from files that changed too recently to trust their stat', () => {
    const file = join(dir, 'page.ts');
    writeFileSync(file, 'one');
    const derive = vi.fn((source: string) => source);

    expect(deriveFromSource(file, 'source', derive)).toBe('one');
    expect(deriveFromSource(file, 'source', derive)).toBe('one');
    expect(derive).toHaveBeenCalledTimes(2);
  });

  it('keeps analyses of one file separate', () => {
    const file = join(dir, 'page.ts');
    writeFileSync(file, 'abc');
    settle();

    expect(deriveFromSource(file, 'upper', (source) => source.toUpperCase())).toBe('ABC');
    expect(deriveFromSource(file, 'length', (source) => source.length)).toBe(3);
    expect(deriveFromSource(file, 'upper', () => 'unused')).toBe('ABC');
  });

  it('derives again after a watcher invalidates the file', () => {
    const file = join(dir, 'page.ts');
    writeFileSync(file, 'abc');
    settle();
    const derive = vi.fn((source: string) => source);

    deriveFromSource(file, 'source', derive);
    invalidateSourceAnalysis(file);
    deriveFromSource(file, 'source', derive);
    expect(derive).toHaveBeenCalledTimes(2);
  });

  it('reports a missing file as a read error', () => {
    expect(() => deriveFromSource(join(dir, 'missing.ts'), 'source', (source) => source)).toThrow(
      /ENOENT/,
    );
  });
});
