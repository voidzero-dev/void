import { describe, expect, it } from 'vite-plus/test';
import {
  parseSecurityBacklog,
  selectSecurityFocus,
  serializeSecurityBacklog,
  SECURITY_FILE_MAX_BYTES,
  SECURITY_FOCUS_MAX_FILES,
} from '../../src/security/input/backlog.ts';

function files(count: number, prefix = 'src/f', bytes = 1000) {
  return Array.from({ length: count }, (_, index) => ({ path: `${prefix}${index + 1}.ts`, bytes }));
}

function availableOf(list: ReadonlyArray<{ path: string; bytes: number }>) {
  return new Map(list.map((file) => [file.path, file.bytes]));
}

describe('selectSecurityFocus', () => {
  it('takes 400 files and keeps the rest in the backlog (edge #13)', () => {
    const diff = files(5000, 'src/f', 100);
    const selected = selectSecurityFocus({ backlog: [], diff, available: availableOf(diff) });
    expect(selected.focus).toHaveLength(SECURITY_FOCUS_MAX_FILES);
    expect(selected.focus[0]).toBe('src/f1.ts');
    expect(selected.backlog).toHaveLength(4600);
    expect(selected.backlog[0]).toBe('src/f401.ts');
  });

  it('drains the backlog first, so file 950 of 1,000 is scanned within 3 scans (edge #36)', () => {
    const diff = files(1000, 'src/f', 100);
    const available = availableOf(diff);
    let backlog: ReadonlyArray<string> = [];
    let next: ReadonlyArray<{ path: string; bytes: number }> = diff;
    const scannedIn: Array<number> = [];
    for (let scan = 1; scan <= 3; scan++) {
      const selected = selectSecurityFocus({ backlog, diff: next, available });
      if (selected.focus.includes('src/f950.ts')) {
        scannedIn.push(scan);
      }
      backlog = selected.backlog;
      // Later deploys change one new file each; the base moved past the old diff.
      next = [{ path: `src/new${scan}.ts`, bytes: 100 }];
      available.set(`src/new${scan}.ts`, 100);
    }
    expect(scannedIn).toEqual([3]);
    expect(backlog).toEqual([]);
  });

  it('stops at 2 MB, counting a big file as 256 KB', () => {
    const big = { path: 'src/big.ts', bytes: 10 * 1024 * 1024 };
    const diff = [big, ...files(20, 'src/m', 200 * 1024)];
    const selected = selectSecurityFocus({ backlog: [], diff, available: availableOf(diff) });
    // 256 KB + 8 × 200 KB = 1,856 KB; a ninth 200 KB file would pass 2 MB.
    expect(selected.focus[0]).toBe('src/big.ts');
    expect(selected.focus).toHaveLength(9);
    expect(selected.backlog).toHaveLength(12);
    expect(SECURITY_FILE_MAX_BYTES).toBe(256 * 1024);
  });

  it('drops backlog paths no longer in the input and never lists a path twice', () => {
    const diff = files(3);
    const selected = selectSecurityFocus({
      backlog: ['src/deleted.ts', 'src/f2.ts'],
      diff,
      available: availableOf(diff),
    });
    expect(selected.focus).toEqual(['src/f2.ts', 'src/f1.ts', 'src/f3.ts']);
    expect(selected.fromBacklog).toBe(1);
    expect(selected.backlog).toEqual([]);
  });

  it('puts the backlog rest before the new overflow', () => {
    const diff = files(3, 'src/new');
    const backlog = files(4, 'src/old').map((file) => file.path);
    const available = availableOf([...diff, ...files(4, 'src/old')]);
    const selected = selectSecurityFocus({ backlog, diff, available, maxFiles: 2 });
    expect(selected.focus).toEqual(['src/old1.ts', 'src/old2.ts']);
    expect(selected.backlog).toEqual([
      'src/old3.ts',
      'src/old4.ts',
      'src/new1.ts',
      'src/new2.ts',
      'src/new3.ts',
    ]);
  });
});

describe('backlog.json', () => {
  it('round-trips and ignores bad entries', () => {
    expect(parseSecurityBacklog(serializeSecurityBacklog(['a.ts', 'b/c.ts']))).toEqual([
      'a.ts',
      'b/c.ts',
    ]);
    expect(
      parseSecurityBacklog(
        JSON.stringify({ version: 1, paths: ['ok.ts', '../escape.ts', '/abs.ts', 3, 'ok.ts'] }),
      ),
    ).toEqual(['ok.ts']);
    expect(parseSecurityBacklog(null)).toEqual([]);
    expect(parseSecurityBacklog('nope')).toEqual([]);
    expect(parseSecurityBacklog('{"version":2,"paths":["a"]}')).toEqual([]);
  });
});
