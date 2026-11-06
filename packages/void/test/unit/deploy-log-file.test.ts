import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const home = vi.hoisted(() => ({ dir: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home.dir };
});

const { openDeployLog } = await import('../../src/cli/log-file.ts');

describe('openDeployLog', () => {
  beforeEach(() => {
    home.dir = mkdtempSync(join(tmpdir(), 'void-deploy-log-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(home.dir, { recursive: true, force: true });
  });

  // Two deploys started at the same moment (for example two apps deployed in
  // parallel from one machine) must not interleave their records in one file.
  it('gives loggers opened in the same millisecond their own files', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T00:00:00.000Z'));

    const first = openDeployLog();
    const second = openDeployLog();

    expect(first.path).not.toBeNull();
    expect(second.path).not.toBeNull();
    expect(first.path).not.toBe(second.path);
    expect(first.path).toContain(String(process.pid));

    first.info('first_only');
    second.info('second_only');
    await first.close();
    await second.close();

    const firstText = readFileSync(first.path!, 'utf8');
    const secondText = readFileSync(second.path!, 'utf8');
    expect(firstText).toContain('first_only');
    expect(firstText).not.toContain('second_only');
    expect(secondText).toContain('second_only');
    expect(secondText).not.toContain('first_only');
  });

  // Many CLI failure paths call process.exit() right after logging. A buffered stream would
  // lose every record still in memory at that point, including deploy_end.
  it('keeps every record on disk when the process exits right after writing', () => {
    // A file URL, not a path: import() reads a Windows drive path as a 'c:' URL scheme.
    const logFile = new URL('../../src/cli/log-file.ts', import.meta.url).href;
    const script = [
      `const { openDeployLog } = await import(${JSON.stringify(logFile)});`,
      'const log = openDeployLog();',
      "for (let i = 0; i < 100; i++) log.info('record', { i });",
      "log.error('deploy_end', undefined, { ok: false, exitCode: 1 });",
      'process.exit(1);',
    ].join('\n');
    // The child resolves homedir() from these, so its log lands in the test's home.
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, HOME: home.dir, USERPROFILE: home.dir },
      encoding: 'utf8',
    });
    expect(child.stderr).toBe('');
    expect(child.status).toBe(1);

    const logsDir = join(home.dir, '.void', 'logs');
    const files = readdirSync(logsDir);
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(logsDir, files[0]), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(101);
    expect(JSON.parse(lines[99])).toMatchObject({ msg: 'record', i: 99 });
    expect(JSON.parse(lines[100])).toMatchObject({ msg: 'deploy_end', exitCode: 1 });
  });

  it('records deploy_end once, in the file and in the stderr mirror', async () => {
    const mirrored: Array<string> = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      mirrored.push(String(chunk));
      return true;
    });
    try {
      const log = openDeployLog({ mirrorToStderr: true });
      log.error('deploy_end', undefined, { ok: false, exitCode: 1 });
      log.error('deploy_end', new Error('later'), { ok: false });
      log.info('after_end');
      await log.close();

      const records = readFileSync(log.path!, 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.map((record) => record.msg)).toEqual(['deploy_end', 'after_end']);
      expect(records[0]).toMatchObject({ ok: false, exitCode: 1 });
      expect(records[0]).not.toHaveProperty('err');
      expect(mirrored.filter((line) => line.includes('deploy_end'))).toHaveLength(1);
    } finally {
      stderr.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'creates the file readable by its owner only',
    async () => {
      const log = openDeployLog();
      await log.close();
      expect(statSync(log.path!).mode & 0o777).toBe(0o600);
    },
  );

  it('keeps working without a file when the log directory cannot be created', () => {
    // A file where the directory should be makes mkdir fail.
    rmSync(home.dir, { recursive: true, force: true });
    writeFileSync(home.dir, '');
    try {
      const log = openDeployLog();
      expect(log.path).toBeNull();
      expect(() => log.info('ignored')).not.toThrow();
    } finally {
      rmSync(home.dir, { force: true });
    }
  });
});
