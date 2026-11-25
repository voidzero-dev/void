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
  await mkdir(join(root, 'input/src'), { recursive: true });
  await mkdir(join(root, 'out'), { recursive: true });
  await writeFile(join(root, 'out/status.json'), '{}');
  await writeFile(join(root, 'input/src/index.ts'), 'export default {\n  fetch() {}\n};\n');
  await writeFile(join(dir, 'secret.txt'), 'TOKEN=outside');
  tools = createFsTools({ root });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Engine B file tools', () => {
  test('read_file reads numbered lines by absolute or input-relative path', async () => {
    const absolute = await tools.readFile({ path: '/scan/input/src/index.ts' });
    expect(absolute.text).toContain('2\t  fetch() {}');
    expect((await tools.readFile({ path: 'src/index.ts' })).text).toBe(absolute.text);
  });

  test.each([
    ['../secret.txt', 'must not hold ".."'],
    ['/scan/input/../../secret.txt', 'must not hold ".."'],
    ['/etc/passwd', 'outside /scan'],
    ['/proc/self/environ', 'outside /scan'],
    ['/scan/out/status.json', 'only /scan/input and /scan/memory'],
    [String.raw`src\x.ts`, 'backslashes'],
    ['src\u0000.ts', 'control character'],
  ])('read_file refuses %j', async (path, message) => {
    const result = await tools.readFile({ path });
    expect(result.ok).toBe(false);
    expect(result.text).toContain(message);
    expect(result.text).not.toContain('TOKEN');
  });

  test('no tool follows a symlink, to a file or through a folder', async () => {
    await symlink(join(dir, 'secret.txt'), join(root, 'input/src/leak.txt'));
    await symlink(dir, join(root, 'input/up'));
    for (const path of ['src/leak.txt', 'up/secret.txt']) {
      const result = await tools.readFile({ path });
      expect(result.ok, path).toBe(false);
      expect(result.text).toContain('symlinks are not followed');
    }
    expect((await tools.listFiles({ recursive: true })).text).not.toContain('leak');
    expect((await tools.grep({ pattern: 'TOKEN' })).text).toContain('no matches');
    expect((await tools.listFiles({ path: '/scan/out' })).ok).toBe(false);
    expect((await tools.grep({ pattern: 'x', path: '../' })).ok).toBe(false);
  });
});
