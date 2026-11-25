import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import { extractTar } from '../../src/runner/extract.ts';
import { buildTar } from '../helpers/tar.ts';

const ROOTS = ['task.json', 'input', 'memory'];

let dir: string;
let dest: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scanner-extract-'));
  dest = join(dir, 'scan');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('extractTar', () => {
  test.each([
    ['a symlink', { name: 'input/link', type: '2', linkname: '/etc' }, 'not a regular file'],
    ['a parent segment', { name: 'input/../../etc/x', data: 'x' }, '".." segment'],
    ['an absolute path', { name: '/etc/cron.d/x', data: 'x' }, 'absolute path'],
    ['a backslash', { name: String.raw`input\..\x`, data: 'x' }, 'backslash'],
    ['a name outside the scan input', { name: 'out/status.json', data: '{}' }, 'outside'],
  ])('refuses %s, leaving no link behind', async (_label, entry, message) => {
    const tar = buildTar([{ name: 'input/ok.ts', data: 'ok' }, entry]);
    await expect(extractTar(tar, { dest, allowedRoots: ROOTS })).rejects.toThrow(message);
    await expect(lstat(join(dest, 'input/link'))).rejects.toThrow();
  });

  test('never writes through a symlink already in the destination, and checks limits', async () => {
    const outside = join(dir, 'outside.txt');
    await writeFile(outside, 'keep');
    await extractTar(buildTar([{ name: 'input/a.ts', data: 'x' }]), { dest, allowedRoots: ROOTS });
    await symlink(outside, join(dest, 'input/planted'));
    const second = buildTar([{ name: 'input/planted', data: 'overwrite' }]);
    await expect(extractTar(second, { dest, allowedRoots: ROOTS })).rejects.toThrow(
      'could not be written',
    );
    expect(await readFile(outside, 'utf8')).toBe('keep');
    // A huge declared size is refused from the header, before any data is read.
    const huge = buildTar([{ name: 'input/big', size: 2 ** 33 - 1, data: '' }], { end: false });
    await expect(extractTar(huge, { dest: join(dir, 'four') })).rejects.toThrow('larger than');
    await expect(lstat(join(dir, 'four', 'input'))).rejects.toThrow();
  });
});
