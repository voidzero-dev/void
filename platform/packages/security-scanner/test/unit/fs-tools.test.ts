import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import { createFsTools } from '../../src/runner/tools/fs.ts';
import type { FsTools } from '../../src/runner/tools/fs.ts';

let dir: string;
let root: string;
let tools: FsTools;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scanner-fs-'));
  root = join(dir, 'scan');
  await mkdir(join(root, 'input/src/lib'), { recursive: true });
  await mkdir(join(root, 'memory/history'), { recursive: true });
  await mkdir(join(root, 'out'), { recursive: true });
  await writeFile(join(root, 'task.json'), '{"version":1}');
  await writeFile(join(root, 'out/status.json'), '{}');
  await writeFile(
    join(root, 'input/src/index.ts'),
    [
      'import { db } from "./lib/db";',
      'export default {',
      '  fetch(req) { return db(req); }',
      '};',
    ].join('\n'),
  );
  await writeFile(
    join(root, 'input/src/lib/db.ts'),
    'export const db = (req) => env.DB.prepare(req.url);\n',
  );
  await writeFile(join(root, 'memory/index.json'), '[{"id":"F-1"}]');
  await writeFile(join(dir, 'secret.txt'), 'TOKEN=outside');
  tools = createFsTools({ root });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('read_file', () => {
  test('reads numbered lines by absolute or input-relative path', async () => {
    const absolute = await tools.readFile({ path: '/scan/input/src/index.ts' });
    expect(absolute.ok).toBe(true);
    expect(absolute.text).toContain('/scan/input/src/index.ts (lines 1-4 of 4)');
    expect(absolute.text).toContain('3\t  fetch(req) { return db(req); }');
    const relative = await tools.readFile({ path: 'src/index.ts' });
    expect(relative.text).toBe(absolute.text);
  });

  test('reads a window with offset and limit and says where to continue', async () => {
    const result = await tools.readFile({ path: 'src/index.ts', offset: 2, limit: 2 });
    expect(result.text).toBe(
      [
        '/scan/input/src/index.ts (lines 2-3 of 4)',
        '2\texport default {',
        '3\t  fetch(req) { return db(req); }',
        '[more lines; call read_file with offset=4]',
      ].join('\n'),
    );
  });

  test('reads memory files', async () => {
    const result = await tools.readFile({ path: '/scan/memory/index.json' });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('F-1');
  });

  test.each([
    ['../secret.txt', 'must not hold ".."'],
    ['/scan/input/../../secret.txt', 'must not hold ".."'],
    ['/etc/passwd', 'outside /scan'],
    ['/scan/task.json', 'only /scan/input and /scan/memory'],
    ['/scan/out/status.json', 'only /scan/input and /scan/memory'],
    ['/scan', 'only /scan/input and /scan/memory'],
    ['src/nope.ts', 'not found'],
    ['src\u0000.ts', 'control character'],
  ])('refuses %j', async (path, message) => {
    const result = await tools.readFile({ path });
    expect(result.ok).toBe(false);
    expect(result.text).toContain(message);
  });

  test('never follows a symlink, to a file or through a folder', async () => {
    await symlink(join(dir, 'secret.txt'), join(root, 'input/src/leak.txt'));
    await symlink(dir, join(root, 'input/up'));
    await symlink(join(root, 'input/src/index.ts'), join(root, 'input/inside-link.ts'));
    for (const path of ['src/leak.txt', 'up/secret.txt', 'inside-link.ts']) {
      const result = await tools.readFile({ path });
      expect(result.ok, path).toBe(false);
      expect(result.text).toContain('symlinks are not followed');
      expect(result.text).not.toContain('TOKEN');
    }
  });

  test('refuses a symlinked input root', async () => {
    await rm(join(root, 'memory'), { recursive: true });
    await symlink(dir, join(root, 'memory'));
    const result = await tools.readFile({ path: '/scan/memory/secret.txt' });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('symlinks are not followed');
  });

  test('refuses big and binary files, and folders', async () => {
    const small = createFsTools({ root, maxFileBytes: 64 });
    await writeFile(join(root, 'input/big.js'), 'x'.repeat(65));
    const big = await small.readFile({ path: 'big.js' });
    expect(big.ok).toBe(false);
    expect(big.text).toContain('too large to read (65 bytes)');
    await writeFile(join(root, 'input/blob.bin'), Buffer.from([0x41, 0x00, 0x42]));
    expect((await tools.readFile({ path: 'blob.bin' })).text).toContain('binary file');
    expect((await tools.readFile({ path: 'src' })).text).toContain('not a regular file');
  });

  test('caps output and long lines', async () => {
    const capped = createFsTools({ root, maxOutputChars: 200 });
    await writeFile(
      join(root, 'input/long.txt'),
      Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'),
    );
    const result = await capped.readFile({ path: 'long.txt' });
    expect(result.text).toContain('[output truncated;');
    await writeFile(join(root, 'input/wide.txt'), 'y'.repeat(5000));
    const wide = await tools.readFile({ path: 'wide.txt' });
    expect(wide.text.length).toBeLessThan(2200);
  });

  test('checks offset and limit', async () => {
    expect((await tools.readFile({ path: 'src/index.ts', offset: 0 })).text).toContain(
      'offset must be',
    );
    expect((await tools.readFile({ path: 'src/index.ts', offset: 99 })).text).toContain(
      'past the end',
    );
    expect((await tools.readFile({ path: 7 })).text).toContain('path must be a string');
  });
});

describe('list_files', () => {
  test('lists one level by default and the tree with recursive', async () => {
    const flat = await tools.listFiles({});
    expect(flat.text).toBe('/scan/input/src/');
    const tree = await tools.listFiles({ path: '/scan/input', recursive: true });
    expect(tree.text.split('\n')).toEqual([
      '/scan/input/src/',
      '/scan/input/src/index.ts',
      '/scan/input/src/lib/',
      '/scan/input/src/lib/db.ts',
    ]);
  });

  test('skips symlinks and never walks through them', async () => {
    await symlink(dir, join(root, 'input/src/up'));
    await symlink(join(dir, 'secret.txt'), join(root, 'input/src/leak.txt'));
    const tree = await tools.listFiles({ recursive: true });
    expect(tree.text).not.toContain('up');
    expect(tree.text).not.toContain('leak');
    expect(tree.text).not.toContain('secret');
  });

  test('refuses paths outside the readable areas', async () => {
    expect((await tools.listFiles({ path: '/scan/out' })).ok).toBe(false);
    expect((await tools.listFiles({ path: '/' })).ok).toBe(false);
    expect((await tools.listFiles({ path: 'src/index.ts' })).text).toContain('not a directory');
  });
});

describe('grep', () => {
  test('finds plain text, not regular expressions', async () => {
    const result = await tools.grep({ pattern: 'env.DB.prepare(' });
    expect(result.text).toBe(
      '/scan/input/src/lib/db.ts:1: export const db = (req) => env.DB.prepare(req.url);',
    );
    const regexLike = await tools.grep({ pattern: 'db.*prepare' });
    expect(regexLike.text).toContain('no matches');
  });

  test('matches without case when asked and caps results', async () => {
    const insensitive = await tools.grep({ pattern: 'EXPORT', case_insensitive: true });
    expect(insensitive.text.split('\n')).toHaveLength(2);
    const capped = await tools.grep({ pattern: 'e', max_results: 1 });
    expect(capped.text).toContain('[stopped at 1 matches;');
  });

  test('searches one file or memory, and skips symlinks and binary files', async () => {
    await symlink(join(dir, 'secret.txt'), join(root, 'input/leak.txt'));
    await writeFile(join(root, 'input/blob.bin'), Buffer.from('TOKEN\u0000', 'utf8'));
    const result = await tools.grep({ pattern: 'TOKEN' });
    expect(result.text).toContain('no matches');
    expect(result.text).toContain('[1 binary or too-large files skipped]');
    expect((await tools.grep({ pattern: 'F-1', path: '/scan/memory' })).text).toContain(
      '/scan/memory/index.json:1:',
    );
    expect((await tools.grep({ pattern: 'db', path: 'src/lib/db.ts' })).ok).toBe(true);
  });

  test('checks the pattern', async () => {
    expect((await tools.grep({ pattern: '' })).text).toContain('non-empty');
    expect((await tools.grep({ pattern: 'x'.repeat(201) })).text).toContain('too long');
    expect((await tools.grep({ pattern: 'x', path: '../' })).ok).toBe(false);
  });
});
