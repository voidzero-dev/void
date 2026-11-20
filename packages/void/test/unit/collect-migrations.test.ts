import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vite-plus/test';
import { packageFixturePath } from '../../../../test/fixture-dir.ts';
import { collectMigrations } from '../../src/migrations/collect.ts';

const TMP_DIR = packageFixturePath(import.meta.dirname, '.tmp-collect-test');

function setup(files: Record<string, string>) {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(TMP_DIR, name), content);
  }
}

function cleanup() {
  rmSync(TMP_DIR, { recursive: true, force: true });
}

describe('collectMigrations', () => {
  it('returns empty array for missing directory', () => {
    const result = collectMigrations('/nonexistent/path');
    expect(result).toEqual([]);
  });

  it('collects and sorts .sql files', () => {
    setup({
      '002_second.sql': 'CREATE TABLE b;',
      '001_first.sql': 'CREATE TABLE a;',
      '003_third.sql': 'CREATE TABLE c;',
    });

    const result = collectMigrations(TMP_DIR);
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('001_first.sql');
    expect(result[1].name).toBe('002_second.sql');
    expect(result[2].name).toBe('003_third.sql');
    expect(result[0].sql).toBe('CREATE TABLE a;');

    cleanup();
  });

  it('ignores non-.sql files', () => {
    setup({
      '001_create.sql': 'CREATE TABLE a;',
      'README.md': '# Migrations',
      'notes.txt': 'some notes',
    });

    const result = collectMigrations(TMP_DIR);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('001_create.sql');

    cleanup();
  });

  it('handles empty directory', () => {
    setup({});
    const result = collectMigrations(TMP_DIR);
    expect(result).toEqual([]);
    cleanup();
  });

  it('excludes seed.sql', () => {
    setup({
      '001_create.sql': 'CREATE TABLE a;',
      'seed.sql': 'INSERT INTO a VALUES (1);',
    });

    const result = collectMigrations(TMP_DIR);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('001_create.sql');

    cleanup();
  });
});
