import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import { extractTar, ExtractError, safeSegments } from '../../src/runner/extract.ts';
import { buildTar, paxHeader } from '../helpers/tar.ts';

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

function concatBytes(parts: Array<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

describe('extractTar', () => {
  test('writes regular files and directories, read-only files', async () => {
    const tar = buildTar([
      { name: 'task.json', data: '{"version":1}' },
      { name: 'input/', type: '5' },
      { name: 'input/src/index.ts', data: 'export default {};\n' },
      { name: './memory/index.json', data: '[]' },
    ]);
    const result = await extractTar(tar, { dest, allowedRoots: ROOTS });
    expect(result).toEqual({ files: 3, directories: 1, bytes: 13 + 19 + 2 });
    expect(await readFile(join(dest, 'input/src/index.ts'), 'utf8')).toBe('export default {};\n');
    expect(await readFile(join(dest, 'memory/index.json'), 'utf8')).toBe('[]');
    expect((await stat(join(dest, 'task.json'))).mode & 0o777).toBe(0o444);
  });

  test('reads a stream split at odd sizes', async () => {
    const body = 'x'.repeat(1500);
    const tar = buildTar([{ name: 'input/a.txt', data: body }]);
    await extractTar(chunked(tar, 7), { dest, allowedRoots: ROOTS });
    expect(await readFile(join(dest, 'input/a.txt'), 'utf8')).toBe(body);
  });

  test('uses ustar prefix and pax path for long names', async () => {
    const longName = `input/${'d'.repeat(120)}/file.ts`;
    const tar = buildTar([
      { name: 'file.ts', prefix: 'input/deep', data: 'a' },
      paxHeader({ path: longName }),
      { name: 'ignored-short-name', data: 'b' },
    ]);
    await extractTar(tar, { dest, allowedRoots: ROOTS });
    expect(await readFile(join(dest, 'input/deep/file.ts'), 'utf8')).toBe('a');
    expect(await readFile(join(dest, longName), 'utf8')).toBe('b');
  });

  test('skips binary pax values such as SCHILY.xattr and still reads path and size', async () => {
    const encoder = new TextEncoder();
    const record = (key: string, value: Uint8Array) => {
      const body = concatBytes([encoder.encode(` ${key}=`), value, encoder.encode('\n')]);
      let length = body.length + 1;
      while (String(length).length + body.length !== length) {
        length = String(length).length + body.length;
      }
      return concatBytes([encoder.encode(String(length)), body]);
    };
    const pax = concatBytes([
      record('SCHILY.xattr.com.apple.provenance', new Uint8Array([0x01, 0x00, 0xff, 0xfe, 0x0a])),
      record('path', encoder.encode('input/caf\u00e9.ts')),
    ]);
    const tar = buildTar([
      { name: 'PaxHeader', type: 'x', data: pax },
      { name: 'short', data: 'ok' },
    ]);
    await extractTar(tar, { dest, allowedRoots: ROOTS });
    expect(await readFile(join(dest, 'input/caf\u00e9.ts'), 'utf8')).toBe('ok');
  });

  test('a pax path that is not UTF-8 is an ExtractError', async () => {
    const tar = buildTar([
      {
        name: 'PaxHeader',
        type: 'x',
        data: new Uint8Array([...new TextEncoder().encode('11 path=a'), 0xff, 0x0a]),
      },
      { name: 'input/a.ts', data: 'a' },
    ]);
    await expect(extractTar(tar, { dest, allowedRoots: ROOTS })).rejects.toThrow(
      new ExtractError('tar pax path is not UTF-8'),
    );
  });

  test('a stop while the stream waits for data ends the read', async () => {
    const controller = new AbortController();
    const head = buildTar([{ name: 'task.json', data: '{}' }], { end: false });
    async function* stalled(): AsyncGenerator<Uint8Array> {
      yield head;
      await new Promise(() => {});
    }
    const pending = extractTar(stalled(), {
      dest,
      allowedRoots: ROOTS,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow(new ExtractError('tar input was stopped'));
  });

  test('reads an archive made by the system tar', async () => {
    const src = join(dir, 'src');
    execFileSync('mkdir', ['-p', join(src, 'input/lib')]);
    await writeFile(join(src, 'task.json'), '{}');
    await writeFile(join(src, 'input/lib/a.js'), 'module.exports = 1;\n');
    const tar = execFileSync(
      'tar',
      ['--format=ustar', '-cf', '-', '-C', src, 'task.json', 'input'],
      {
        // macOS tar would add AppleDouble ._ entries for extended attributes.
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      },
    );
    await extractTar(new Uint8Array(tar), { dest, allowedRoots: ROOTS });
    expect(await readFile(join(dest, 'input/lib/a.js'), 'utf8')).toBe('module.exports = 1;\n');
  });

  test.each([
    ['a symlink', { name: 'input/link', type: '2', linkname: '/etc/passwd' }, 'not a regular file'],
    ['a hard link', { name: 'input/hard', type: '1', linkname: 'task.json' }, 'not a regular file'],
    ['a character device', { name: 'input/dev', type: '3' }, 'not a regular file'],
    ['a fifo', { name: 'input/fifo', type: '6' }, 'not a regular file'],
    ['a parent segment', { name: 'input/../../etc/x', data: 'x' }, '".." segment'],
    ['an absolute path', { name: '/etc/cron.d/x', data: 'x' }, 'absolute path'],
    ['a backslash', { name: String.raw`input\..\x`, data: 'x' }, 'backslash'],
    ['an empty segment', { name: 'input//x', data: 'x' }, 'empty'],
    [
      'a name outside the scan input',
      { name: 'out/status.json', data: '{}' },
      'outside the scan input',
    ],
  ])('refuses %s', async (_label, entry, message) => {
    const tar = buildTar([{ name: 'input/ok.ts', data: 'ok' }, entry]);
    await expect(extractTar(tar, { dest, allowedRoots: ROOTS })).rejects.toThrow(message);
  });

  test('refuses a symlink hidden behind a pax path', async () => {
    const tar = buildTar([
      paxHeader({ path: 'input/innocent.ts' }),
      { name: 'x', type: '2', linkname: '/' },
    ]);
    await expect(extractTar(tar, { dest, allowedRoots: ROOTS })).rejects.toThrow(ExtractError);
  });

  test('refuses a duplicate entry instead of replacing the first', async () => {
    const tar = buildTar([
      { name: 'input/a.ts', data: 'first' },
      { name: 'input/a.ts', data: 'second' },
    ]);
    await expect(extractTar(tar, { dest, allowedRoots: ROOTS })).rejects.toThrow('appears twice');
    expect(await readFile(join(dest, 'input/a.ts'), 'utf8')).toBe('first');
  });

  test('refuses a file under a path that was a file', async () => {
    const tar = buildTar([
      { name: 'input/a', data: 'file' },
      { name: 'input/a/b', data: 'nested' },
    ]);
    await expect(extractTar(tar, { dest, allowedRoots: ROOTS })).rejects.toThrow('inside a file');
  });

  test('never writes through a symlink already in the destination', async () => {
    const outside = join(dir, 'outside.txt');
    await writeFile(outside, 'keep');
    const tar = buildTar([{ name: 'input/a.ts', data: 'x' }]);
    await extractTar(tar, { dest, allowedRoots: ROOTS });
    await symlink(outside, join(dest, 'input/planted'));
    const second = buildTar([{ name: 'input/planted', data: 'overwrite' }]);
    await expect(extractTar(second, { dest, allowedRoots: ROOTS })).rejects.toThrow(
      'could not be written',
    );
    expect(await readFile(outside, 'utf8')).toBe('keep');
  });

  test('refuses a bad checksum, a truncated stream and a missing end marker', async () => {
    await expect(
      extractTar(buildTar([{ name: 'input/a', data: 'x', corruptChecksum: true }]), { dest }),
    ).rejects.toThrow('checksum');
    const full = buildTar([{ name: 'input/b', data: 'y'.repeat(600) }], { end: false });
    await expect(extractTar(full.subarray(0, 700), { dest })).rejects.toThrow('ended inside');
    await expect(extractTar(full, { dest })).rejects.toThrow('end marker');
  });

  test('enforces file count, file size and total size limits before writing', async () => {
    const tar = buildTar([
      { name: 'input/a', data: 'aaaa' },
      { name: 'input/b', data: 'bbbb' },
    ]);
    await expect(
      extractTar(tar, { dest: join(dir, 'one'), limits: { maxFiles: 1 } }),
    ).rejects.toThrow('more than 1 files');
    await expect(
      extractTar(tar, { dest: join(dir, 'two'), limits: { maxFileBytes: 3 } }),
    ).rejects.toThrow('larger than 3 bytes');
    await expect(
      extractTar(tar, { dest: join(dir, 'three'), limits: { maxTotalBytes: 6 } }),
    ).rejects.toThrow('larger than 6 bytes');
    // A huge declared size is refused from the header, before any data is read.
    const huge = buildTar([{ name: 'input/big', size: 2 ** 33 - 1, data: '' }], { end: false });
    await expect(extractTar(huge, { dest: join(dir, 'four') })).rejects.toThrow('larger than');
    await expect(lstat(join(dir, 'four', 'input'))).rejects.toThrow();
  });

  test('a refused entry leaves no symlink behind', async () => {
    const tar = buildTar([{ name: 'input/link', type: '2', linkname: '/etc' }]);
    await expect(extractTar(tar, { dest, allowedRoots: ROOTS })).rejects.toThrow();
    await expect(lstat(join(dest, 'input/link'))).rejects.toThrow();
  });
});

describe('safeSegments', () => {
  test('strips a leading ./ and a trailing slash on directories', () => {
    expect(safeSegments('./input/src/', true)).toEqual(['input', 'src']);
  });

  test('refuses names with control characters', () => {
    expect(() => safeSegments('input/a\u0001b', false)).toThrow('control character');
  });
});
